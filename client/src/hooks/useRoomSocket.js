import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from '../lib/socket.js';

export function useRoomSocket(roomId, name, options = {}) {
  const [participants, setParticipants] = useState([]);
  const [you, setYou] = useState(null);
  const [hostId, setHostId] = useState(null);
  const [video, setVideo] = useState({ url: null, type: null, id: null, isPlaying: false, currentTime: 0 });
  const [messages, setMessages] = useState([]);
  const [status, setStatus] = useState('connecting'); // 'connecting' | 'waiting' | 'joined' | 'kicked' | 'rejected' | 'error'
  const [connectionError, setConnectionError] = useState(null);
  const [kicked, setKicked] = useState(false);
  const [isProtected, setIsProtected] = useState(false);
  const [hostSecret, setHostSecret] = useState(null);

  // Persistent clientId to help server deduplicate fast-reconnect ghosts
  const clientIdRef = useRef(null);
  if (!clientIdRef.current) {
    clientIdRef.current = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).substring(2, 15);
  }

  // Waiting room: list of { socketId, name } that the host needs to admit/reject
  const [waitingKnocks, setWaitingKnocks] = useState([]);

  const [pauseRequests, setPauseRequests] = useState([]);
  const [pauseRequestDenied, setPauseRequestDenied] = useState(false);

  const videoEventBusRef = useRef(typeof EventTarget !== 'undefined' ? new EventTarget() : null);
  const serverOffsetRef = useRef(0);

  useEffect(() => {
    if (!roomId || !name) return;

    // Ping the server to calculate round-trip time and server clock offset
    function measurePing() {
      if (!socket.connected) return;
      const start = Date.now();
      socket.emit('room:ping', (serverTime) => {
        const end = Date.now();
        const latency = (end - start) / 2;
        // The server was at `serverTime` approximately `latency` ms ago.
        const estimatedServerTimeNow = serverTime + latency;
        serverOffsetRef.current = estimatedServerTimeNow - end;
      });
    }

    const pingInterval = setInterval(measurePing, 5000);
    socket.on('connect', measurePing);

    socket.connect();

    function handleConnect() {
      socket.emit('room:join', { 
        roomId, 
        name, 
        protected: options.protected, 
        hostSecret: options.hostSecret,
        clientId: clientIdRef.current
      }, (response) => {
        if (response?.error) {
          setConnectionError(response.error);
          setStatus('error');
          return;
        }

        // Waiting room path
        if (response?.waiting) {
          setStatus('waiting');
          return;
        }

        // Normal join
        setParticipants(response.participants);
        setHostId(response.hostId);
        setVideo(response.video);
        setMessages(response.messages);
        setYou(response.you);
        if (response.hostSecret) setHostSecret(response.hostSecret);
        setIsProtected(response.protected || false);
        setStatus('joined');

        if (response.video?.url) {
          socket.emit('video:sync-request', { roomId });
        }
      });
    }

    // Host admitted us from the waiting room
    function handleAdmitted(response) {
      setParticipants(response.participants);
      setHostId(response.hostId);
      setVideo(response.video);
      setMessages(response.messages);
      setYou(response.you);
      if (response.hostSecret) setHostSecret(response.hostSecret);
      setIsProtected(response.protected || false);
      setStatus('joined');

      if (response.video?.url) {
        socket.emit('video:sync-request', { roomId });
      }
    }

    function handleRejected() {
      setStatus('rejected');
      socket.disconnect();
    }

    // Waiting room knock arrives at the host
    function handleWaitingKnock({ socketId: sid, name: knockName }) {
      setWaitingKnocks((prev) => {
        if (prev.some((k) => k.socketId === sid)) return prev;
        return [...prev, { socketId: sid, name: knockName }];
      });
    }

    // Waiting participant disconnected before being admitted
    function handleWaitingLeft({ socketId: sid }) {
      setWaitingKnocks((prev) => prev.filter((k) => k.socketId !== sid));
    }

    function handleParticipantJoined(participant) {
      setParticipants((prev) => [...prev.filter((p) => p.id !== participant.id), participant]);
    }

    function handleParticipantLeft({ id, newHostId }) {
      setParticipants((prev) => prev.filter((p) => p.id !== id));
      if (newHostId !== undefined) setHostId(newHostId);
    }

    function handleHostChanged({ newHostId }) {
      setHostId(newHostId);
      setParticipants((prev) =>
        prev.map((p) => ({ ...p, isHost: p.id === newHostId }))
      );
    }

    function handleKicked() {
      setKicked(true);
      setStatus('kicked');
      socket.disconnect();
    }

    function handleProtectedChanged({ protected: val }) {
      setIsProtected(val);
    }

    function handleVideoLoaded(payload) {
      setVideo(payload);
    }

    function handleVideoPlay({ time, serverTime }) {
      let compensatedTime = time;
      if (serverTime) {
        const nowServer = Date.now() + serverOffsetRef.current;
        const elapsed = (nowServer - serverTime) / 1000;
        // Only compensate if elapsed is reasonable (e.g. less than 5 seconds), otherwise
        // it might be a weird edge case like waking up from sleep.
        if (elapsed > 0 && elapsed < 5) {
          compensatedTime += elapsed;
        }
      }
      setVideo((prev) => ({ ...prev, isPlaying: true, currentTime: compensatedTime }));
      videoEventBusRef.current?.dispatchEvent(new CustomEvent('play', { detail: { time: compensatedTime } }));
    }

    function handleVideoPause({ time }) {
      setVideo((prev) => ({ ...prev, isPlaying: false, currentTime: time }));
      videoEventBusRef.current?.dispatchEvent(new CustomEvent('pause', { detail: { time } }));
    }

    function handleVideoSeek({ time, serverTime, isPlaying }) {
      let compensatedTime = time;
      if (isPlaying && serverTime) {
        const nowServer = Date.now() + serverOffsetRef.current;
        const elapsed = (nowServer - serverTime) / 1000;
        if (elapsed > 0 && elapsed < 5) {
          compensatedTime += elapsed;
        }
      }
      setVideo((prev) => ({ ...prev, currentTime: compensatedTime }));
      videoEventBusRef.current?.dispatchEvent(new CustomEvent('seek', { detail: { time: compensatedTime } }));
    }

    function handleChatMessage(message) {
      setMessages((prev) => [...prev.slice(-99), message]);
    }

    function handleMediaState({ id, muted, cameraOff }) {
      setParticipants((prev) => prev.map((p) => (p.id === id ? { ...p, muted, cameraOff } : p)));
    }

    function handlePauseRequest({ fromId, fromName }) {
      setPauseRequests((prev) => {
        if (prev.some((r) => r.fromId === fromId)) return prev;
        return [...prev, { fromId, fromName }];
      });
    }

    function handlePauseRequestDenied() {
      setPauseRequestDenied(true);
      setTimeout(() => setPauseRequestDenied(false), 4000);
    }

    socket.on('connect', handleConnect);
    socket.on('room:admitted', handleAdmitted);
    socket.on('room:rejected', handleRejected);
    socket.on('room:waiting-knock', handleWaitingKnock);
    socket.on('room:waiting-left', handleWaitingLeft);
    socket.on('room:participant-joined', handleParticipantJoined);
    socket.on('room:participant-left', handleParticipantLeft);
    socket.on('room:host-changed', handleHostChanged);
    socket.on('room:kicked', handleKicked);
    socket.on('room:protected-changed', handleProtectedChanged);
    socket.on('video:loaded', handleVideoLoaded);
    socket.on('video:play', handleVideoPlay);
    socket.on('video:pause', handleVideoPause);
    socket.on('video:seek', handleVideoSeek);
    socket.on('chat:message', handleChatMessage);
    socket.on('media:state', handleMediaState);
    socket.on('video:pause-request', handlePauseRequest);
    socket.on('video:pause-request-denied', handlePauseRequestDenied);
    socket.on('video:pause-request-approved', () => {});

    if (socket.connected) handleConnect();

    return () => {
      clearInterval(pingInterval);
      socket.off('connect', measurePing);
      socket.off('connect', handleConnect);
      socket.off('room:admitted', handleAdmitted);
      socket.off('room:rejected', handleRejected);
      socket.off('room:waiting-knock', handleWaitingKnock);
      socket.off('room:waiting-left', handleWaitingLeft);
      socket.off('room:participant-joined', handleParticipantJoined);
      socket.off('room:participant-left', handleParticipantLeft);
      socket.off('room:host-changed', handleHostChanged);
      socket.off('room:kicked', handleKicked);
      socket.off('room:protected-changed', handleProtectedChanged);
      socket.off('video:loaded', handleVideoLoaded);
      socket.off('video:play', handleVideoPlay);
      socket.off('video:pause', handleVideoPause);
      socket.off('video:seek', handleVideoSeek);
      socket.off('chat:message', handleChatMessage);
      socket.off('media:state', handleMediaState);
      socket.off('video:pause-request', handlePauseRequest);
      socket.off('video:pause-request-denied', handlePauseRequestDenied);
      socket.off('video:pause-request-approved');
      socket.disconnect();
    };
  }, [roomId, name, options.protected, options.hostSecret]);

  const loadVideo = useCallback(
    (parsed) => socket.emit('video:load', { roomId, url: parsed.url, videoType: parsed.type, videoId: parsed.id }),
    [roomId]
  );
  const play = useCallback((time) => socket.emit('video:play', { roomId, time }), [roomId]);
  const pause = useCallback((time) => socket.emit('video:pause', { roomId, time }), [roomId]);
  const seek = useCallback((time) => socket.emit('video:seek', { roomId, time }), [roomId]);
  const sendChat = useCallback((text) => socket.emit('chat:send', { roomId, text }), [roomId]);
  const updateMediaState = useCallback((state) => socket.emit('media:state', { roomId, ...state }), [roomId]);
  const sendHeartbeat = useCallback((time) => socket.emit('video:heartbeat', { roomId, time }), [roomId]);
  const requestPause = useCallback(() => socket.emit('video:pause-request', { roomId }), [roomId]);
  const respondToPauseRequest = useCallback(
    ({ approved, toId, time }) => socket.emit('video:pause-request-response', { roomId, approved, toId, time }),
    [roomId]
  );
  const dismissPauseRequest = useCallback(
    (fromId) => setPauseRequests((prev) => prev.filter((r) => r.fromId !== fromId)),
    []
  );
  const switchHost = useCallback((toId) => socket.emit('room:switch-host', { roomId, toId }), [roomId]);
  const kickParticipant = useCallback((toId) => socket.emit('room:kick', { roomId, toId }), [roomId]);
  const admitParticipant = useCallback(
    (socketId) => {
      socket.emit('room:admit', { roomId, socketId });
      setWaitingKnocks((prev) => prev.filter((k) => k.socketId !== socketId));
    },
    [roomId]
  );
  const rejectParticipant = useCallback(
    (socketId) => {
      socket.emit('room:reject', { roomId, socketId });
      setWaitingKnocks((prev) => prev.filter((k) => k.socketId !== socketId));
    },
    [roomId]
  );
  const setProtected = useCallback(
    (val) => socket.emit('room:set-protected', { roomId, protected: val }),
    [roomId]
  );

  return {
    participants,
    you,
    hostId,
    isHost: Boolean(you && you.id === hostId),
    video,
    messages,
    status,
    connectionError,
    kicked,
    isProtected,
    waitingKnocks,
    videoEventBus: videoEventBusRef.current,
    pauseRequests,
    pauseRequestDenied,
    loadVideo,
    play,
    pause,
    seek,
    sendChat,
    updateMediaState,
    sendHeartbeat,
    requestPause,
    respondToPauseRequest,
    dismissPauseRequest,
    switchHost,
    kickParticipant,
    admitParticipant,
    rejectParticipant,
    setProtected,
    hostSecret,
  };
}
