import { nanoid } from 'nanoid';

const rooms = new Map();

export function createRoomId() {
  return nanoid(8);
}

export function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

export function getOrCreateRoom(roomId, options = {}) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      hostId: null,
      hostSecret: nanoid(16),
      createdAt: Date.now(),
      // Protected room (waiting room) support
      protected: options.protected || false,
      waitingRoom: new Map(), // socketId -> { name, socketId }
      video: {
        url: null,
        type: null,
        id: null,
        isPlaying: false,
        currentTime: 0,
        updatedAt: Date.now(),
      },
      participants: new Map(), // socketId -> participant
      messages: [],
    };
    rooms.set(roomId, room);
  }
  return room;
}

export function addParticipant(room, socketId, rawName, forceHost = false) {
  const isFirst = room.participants.size === 0;
  const isHost = isFirst || forceHost;
  const name = (rawName || 'Guest').toString().trim().slice(0, 24) || 'Guest';
  const participant = {
    id: socketId,
    name,
    muted: false,
    cameraOff: false,
    isHost,
  };
  room.participants.set(socketId, participant);
  
  if (isHost) {
    room.hostId = socketId;
    for (const [id, p] of room.participants.entries()) {
      if (id !== socketId) p.isHost = false;
    }
  }
  return participant;
}

export function removeParticipant(room, socketId) {
  room.participants.delete(socketId);
  // Also clean up from waiting room if they were there
  room.waitingRoom.delete(socketId);
  let newHostId = room.hostId;

  if (room.hostId === socketId) {
    newHostId = null;
    room.hostId = null;
  }

  return { newHostId, isEmpty: room.participants.size === 0 };
}

export function roomSnapshot(room) {
  return {
    id: room.id,
    hostId: room.hostId,
    protected: room.protected,
    video: { ...room.video },
    participants: Array.from(room.participants.values()),
    messages: room.messages.slice(-50),
  };
}

export function pruneEmptyRoom(roomId) {
  const room = rooms.get(roomId);
  if (room && room.participants.size === 0) {
    rooms.delete(roomId);
  }
}

setInterval(() => {
  for (const [roomId, room] of rooms.entries()) {
    if (room.participants.size === 0 && Date.now() - room.createdAt > 60_000) {
      rooms.delete(roomId);
    }
  }
}, 60_000);
