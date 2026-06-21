import {
  getOrCreateRoom,
  getRoom,
  addParticipant,
  removeParticipant,
  roomSnapshot,
  pruneEmptyRoom,
} from './rooms.js';

const MAX_MESSAGE_LENGTH = 500;

function isHost(room, socketId) {
  return room.hostId === socketId;
}

function withElapsedCompensation(video) {
  if (!video.isPlaying) return { ...video };
  const elapsedSeconds = (Date.now() - video.updatedAt) / 1000;
  return { ...video, currentTime: video.currentTime + elapsedSeconds };
}

export function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    let currentRoomId = null;

    // ─── Network Ping ─────────────────────────────────────────────────────────
    socket.on('room:ping', (callback) => {
      callback?.(Date.now());
    });

    // ─── Join room ────────────────────────────────────────────────────────────
    socket.on('room:join', ({ roomId, name, protected: wantsProtected, hostSecret, clientId }, callback) => {
      if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
        callback?.({ error: 'A room code is required.' });
        return;
      }

      const cleanRoomId = roomId.trim().slice(0, 64);
      // Pass protected flag only when creating the room (first joiner = host)
      const room = getOrCreateRoom(cleanRoomId, { protected: Boolean(wantsProtected) });

      // Clean up ghosts if reconnecting
      if (clientId) {
        // From waiting room
        for (const [existingSocketId, waiter] of room.waitingRoom.entries()) {
          if (waiter.clientId === clientId) {
            room.waitingRoom.delete(existingSocketId);
            if (room.hostId) {
              io.to(room.hostId).emit('room:waiting-left', { socketId: existingSocketId });
            }
            break;
          }
        }
        // From main room
        for (const [existingSocketId, p] of room.participants.entries()) {
          if (p.clientId === clientId) {
            const { newHostId } = removeParticipant(room, existingSocketId);
            io.to(cleanRoomId).emit('room:participant-left', { id: existingSocketId, newHostId });
            break;
          }
        }
      }

      let forceHost = false;
      if (hostSecret && hostSecret === room.hostSecret) {
        forceHost = true;
      }

      // If room is protected AND there is already a host, put this person in the waiting room
      if (room.protected && room.hostId && room.hostId !== socket.id && !forceHost) {
        const cleanName = (name || 'Guest').toString().trim().slice(0, 24) || 'Guest';
        room.waitingRoom.set(socket.id, { socketId: socket.id, name: cleanName, clientId });
        currentRoomId = cleanRoomId;
        socket.join(cleanRoomId);

        // Tell the joiner they're waiting
        callback?.({ waiting: true, name: cleanName });

        // Notify host
        if (room.hostId) {
          io.to(room.hostId).emit('room:waiting-knock', { socketId: socket.id, name: cleanName });
        }
        return;
      }

      // Normal join (first person, or unprotected room, or reclaiming host)
      const participant = addParticipant(room, socket.id, name, forceHost, clientId);
      currentRoomId = cleanRoomId;
      socket.join(cleanRoomId);

      const snapshot = roomSnapshot(room);
      snapshot.video = withElapsedCompensation(snapshot.video);

      callback?.({ ...snapshot, you: participant, hostSecret: participant.isHost ? room.hostSecret : null });
      
      if (forceHost) {
        // We might have demoted someone, so send the full updated participant list and host change to everyone
        io.to(cleanRoomId).emit('room:host-changed', { newHostId: socket.id });
        io.to(cleanRoomId).emit('room:participant-joined', participant); // this will just update/add them
      } else {
        socket.to(cleanRoomId).emit('room:participant-joined', participant);
      }
    });

    // ─── Host admits a waiting participant ────────────────────────────────────
    socket.on('room:admit', ({ roomId, socketId: targetId }) => {
      const room = getRoom(roomId);
      if (!room || !isHost(room, socket.id)) return;
      const waiter = room.waitingRoom.get(targetId);
      if (!waiter) return;

      room.waitingRoom.delete(targetId);
      const participant = addParticipant(room, targetId, waiter.name);

      const snapshot = roomSnapshot(room);
      snapshot.video = withElapsedCompensation(snapshot.video);

      // Tell the admitted participant they're in
      io.to(targetId).emit('room:admitted', { ...snapshot, you: participant });
      // Tell everyone else including host
      io.to(roomId).emit('room:participant-joined', participant);
    });

    // ─── Host rejects a waiting participant ───────────────────────────────────
    socket.on('room:reject', ({ roomId, socketId: targetId }) => {
      const room = getRoom(roomId);
      if (!room || !isHost(room, socket.id)) return;
      if (!room.waitingRoom.has(targetId)) return;

      room.waitingRoom.delete(targetId);
      io.to(targetId).emit('room:rejected');
    });

    // ─── Host toggles protected mode ──────────────────────────────────────────
    socket.on('room:set-protected', ({ roomId, protected: val }) => {
      const room = getRoom(roomId);
      if (!room || !isHost(room, socket.id)) return;
      room.protected = Boolean(val);
      io.to(roomId).emit('room:protected-changed', { protected: room.protected });
    });

    // ─── Video events ─────────────────────────────────────────────────────────
    socket.on('video:load', ({ roomId, url, videoType, videoId }) => {
      const room = getRoom(roomId);
      if (!room || !isHost(room, socket.id)) return;
      if (!url || typeof url !== 'string') return;

      room.video = {
        url,
        type: videoType || 'unknown',
        id: videoId || null,
        isPlaying: false,
        currentTime: 0,
        updatedAt: Date.now(),
      };
      io.to(roomId).emit('video:loaded', room.video);
    });

    socket.on('video:play', ({ roomId, time }) => {
      const room = getRoom(roomId);
      if (!room || !isHost(room, socket.id)) return;
      room.video.isPlaying = true;
      room.video.currentTime = Number(time) || 0;
      room.video.updatedAt = Date.now();
      io.to(roomId).emit('video:play', { time: room.video.currentTime, serverTime: room.video.updatedAt });
    });

    socket.on('video:pause', ({ roomId, time }) => {
      const room = getRoom(roomId);
      if (!room || !isHost(room, socket.id)) return;
      room.video.isPlaying = false;
      room.video.currentTime = Number(time) || 0;
      room.video.updatedAt = Date.now();
      io.to(roomId).emit('video:pause', { time: room.video.currentTime });
    });

    socket.on('video:seek', ({ roomId, time }) => {
      const room = getRoom(roomId);
      if (!room || !isHost(room, socket.id)) return;
      room.video.currentTime = Number(time) || 0;
      room.video.updatedAt = Date.now();
      io.to(roomId).emit('video:seek', { 
        time: room.video.currentTime, 
        serverTime: room.video.updatedAt,
        isPlaying: room.video.isPlaying
      });
    });

    socket.on('video:heartbeat', ({ roomId, time }) => {
      const room = getRoom(roomId);
      if (!room || !isHost(room, socket.id) || !room.video.isPlaying) return;
      room.video.currentTime = Number(time) || room.video.currentTime;
      room.video.updatedAt = Date.now();
    });

    socket.on('video:sync-request', ({ roomId }) => {
      const room = getRoom(roomId);
      if (!room || !room.video.url) return;
      const compensated = withElapsedCompensation(room.video);
      socket.emit('video:loaded', room.video);
      socket.emit(compensated.isPlaying ? 'video:play' : 'video:pause', {
        time: compensated.currentTime,
      });
    });

    socket.on('video:pause-request', ({ roomId }) => {
      const room = getRoom(roomId);
      if (!room || isHost(room, socket.id)) return;
      const participant = room.participants.get(socket.id);
      if (!participant) return;
      const hostSocket = room.hostId;
      if (hostSocket) {
        io.to(hostSocket).emit('video:pause-request', {
          fromId: socket.id,
          fromName: participant.name || 'Someone',
        });
      }
    });

    socket.on('video:pause-request-response', ({ roomId, approved, toId, time }) => {
      const room = getRoom(roomId);
      if (!room || !isHost(room, socket.id)) return;

      if (approved) {
        room.video.isPlaying = false;
        room.video.currentTime = Number(time) || 0;
        room.video.updatedAt = Date.now();
        socket.to(roomId).emit('video:pause', { time: room.video.currentTime });
        if (toId) io.to(toId).emit('video:pause-request-approved');
      } else {
        if (toId) io.to(toId).emit('video:pause-request-denied');
      }
    });

    socket.on('room:switch-host', ({ roomId, toId }) => {
      const room = getRoom(roomId);
      if (!room || !isHost(room, socket.id)) return;
      const newHost = room.participants.get(toId);
      if (!newHost) return;

      const oldHost = room.participants.get(socket.id);
      if (oldHost) oldHost.isHost = false;
      newHost.isHost = true;
      room.hostId = toId;

      io.to(roomId).emit('room:host-changed', { newHostId: toId });
    });

    socket.on('room:kick', ({ roomId, toId }) => {
      const room = getRoom(roomId);
      if (!room || !isHost(room, socket.id)) return;
      if (toId === socket.id) return;
      const target = room.participants.get(toId);
      if (!target) return;

      io.to(toId).emit('room:kicked');
      const { newHostId, isEmpty } = removeParticipant(room, toId);
      io.to(roomId).emit('room:participant-left', { id: toId, newHostId });
      if (isEmpty) pruneEmptyRoom(roomId);
      const targetSocket = io.sockets.sockets.get(toId);
      if (targetSocket) targetSocket.leave(roomId);
    });

    socket.on('chat:send', ({ roomId, text }) => {
      const room = getRoom(roomId);
      if (!room || typeof text !== 'string' || !text.trim()) return;
      const participant = room.participants.get(socket.id);

      const message = {
        id: `${Date.now()}-${socket.id}`,
        authorId: socket.id,
        name: participant?.name || 'Guest',
        text: text.trim().slice(0, MAX_MESSAGE_LENGTH),
        ts: Date.now(),
      };

      room.messages.push(message);
      if (room.messages.length > 100) room.messages.shift();
      io.to(roomId).emit('chat:message', message);
    });

    socket.on('media:state', ({ roomId, muted, cameraOff }) => {
      const room = getRoom(roomId);
      if (!room) return;
      const participant = room.participants.get(socket.id);
      if (!participant) return;

      if (typeof muted === 'boolean') participant.muted = muted;
      if (typeof cameraOff === 'boolean') participant.cameraOff = cameraOff;

      socket.to(roomId).emit('media:state', {
        id: socket.id,
        muted: participant.muted,
        cameraOff: participant.cameraOff,
      });
    });

    socket.on('webrtc:offer', ({ to, offer }) => {
      if (to) io.to(to).emit('webrtc:offer', { from: socket.id, offer });
    });

    socket.on('webrtc:answer', ({ to, answer }) => {
      if (to) io.to(to).emit('webrtc:answer', { from: socket.id, answer });
    });

    socket.on('webrtc:ice-candidate', ({ to, candidate }) => {
      if (to) io.to(to).emit('webrtc:ice-candidate', { from: socket.id, candidate });
    });

    socket.on('disconnect', () => {
      if (!currentRoomId) return;
      const room = getRoom(currentRoomId);
      if (!room) return;

      // If they were in the waiting room, just remove them silently
      if (room.waitingRoom.has(socket.id)) {
        room.waitingRoom.delete(socket.id);
        if (room.hostId) {
          io.to(room.hostId).emit('room:waiting-left', { socketId: socket.id });
        }
        return;
      }

      const { newHostId, isEmpty } = removeParticipant(room, socket.id);
      socket.to(currentRoomId).emit('room:participant-left', { id: socket.id, newHostId });
      if (isEmpty) pruneEmptyRoom(currentRoomId);
    });
  });
}
