import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from '../lib/socket.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Free TURN server to handle strict symmetric NATs where STUN fails:
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  }
];

// How long to wait for a connection to succeed before retrying
const CONNECTION_TIMEOUT_MS = 15_000;
// Max retries per peer before giving up
const MAX_RETRIES = 2;

// A simple mesh: every participant opens a direct connection to every other
// participant. This is the simplest topology and needs no media server, but
// bandwidth scales with the square of the group size — it's a great fit for
// the small-group "watch party with friends" use case (roughly 2-6 people),
// not for large broadcasts. For bigger rooms, swap this for an SFU (e.g. a
// self-hosted mediasoup/LiveKit server, or a hosted provider).
export function useMeshCall({ you, participants, localStream, reconnectToken }) {
  const [remoteStreams, setRemoteStreams] = useState({});
  const [dataChannels, setDataChannels] = useState(new Map());
  const peerConnections = useRef(new Map());
  const localStreamRef = useRef(null);
  const dataChannelsRef = useRef(new Map());
  // Track perfect negotiation state per peer
  const makingOfferRef = useRef(new Set());
  const ignoreOfferRef = useRef(new Set());
  // Track retry counts per peer
  const retryCountRef = useRef(new Map());
  // Track connection timeouts per peer
  const timeoutsRef = useRef(new Map());
  // Buffer incoming ICE candidates that arrive before the remote description is set
  const pendingCandidatesRef = useRef(new Map());

  // ── Helpers ─────────────────────────────────────────────────────────

  // Fully tear down a single peer connection and its associated state
  const destroyPeer = useCallback((peerId) => {
    const pc = peerConnections.current.get(peerId);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onnegotiationneeded = null;
      pc.oniceconnectionstatechange = null;
      pc.ondatachannel = null;
      pc.close();
      peerConnections.current.delete(peerId);
    }
    makingOfferRef.current.delete(peerId);
    ignoreOfferRef.current.delete(peerId);
    dataChannelsRef.current.delete(peerId);
    setDataChannels(new Map(dataChannelsRef.current));
    const timer = timeoutsRef.current.get(peerId);
    if (timer) { clearTimeout(timer); timeoutsRef.current.delete(peerId); }
    pendingCandidatesRef.current.delete(peerId);
    setRemoteStreams((prev) => {
      if (!(peerId in prev)) return prev;
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, []);

  // Tear down ALL peer connections (used on reconnect)
  const destroyAllPeers = useCallback(() => {
    for (const peerId of [...peerConnections.current.keys()]) {
      destroyPeer(peerId);
    }
    retryCountRef.current.clear();
  }, [destroyPeer]);

  // Keep the ref current and attach tracks to any connection that was created
  // before the local stream became available (e.g. waiting on permissions).
  useEffect(() => {
    localStreamRef.current = localStream;
    if (!localStream) return;
    peerConnections.current.forEach((pc) => {
      const existingTracks = new Set(pc.getSenders().map((sender) => sender.track));
      localStream.getTracks().forEach((track) => {
        if (!existingTracks.has(track)) pc.addTrack(track, localStream);
      });
    });
  }, [localStream]);

  const getOrCreatePeerConnection = useCallback((peerId) => {
    const existing = peerConnections.current.get(peerId);
    if (existing) {
      const state = existing.iceConnectionState;
      if (state === 'failed' || state === 'closed') {
        destroyPeer(peerId);
      } else {
        return existing;
      }
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc:ice-candidate', { to: peerId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      setRemoteStreams((prev) => ({ ...prev, [peerId]: event.streams[0] }));
    };

    // ── ICE connection state monitoring ──────────────────────────────
    // When a connection fails or disconnects for too long, tear it down
    // and retry. This is the main fix for the "can't see each other"
    // bug — without it, a failed connection sits around silently and
    // blocks any new attempt because getOrCreatePeerConnection sees the
    // existing (dead) entry and returns it.
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;

      if (state === 'connected' || state === 'completed') {
        // Connection succeeded — clear the timeout and reset retries
        const timer = timeoutsRef.current.get(peerId);
        if (timer) { clearTimeout(timer); timeoutsRef.current.delete(peerId); }
        retryCountRef.current.delete(peerId);
      }

      if (state === 'failed') {
        // Connection permanently failed — retry if under the limit
        const retries = retryCountRef.current.get(peerId) || 0;
        if (retries < MAX_RETRIES) {
          retryCountRef.current.set(peerId, retries + 1);
          destroyPeer(peerId);
          // Small delay before retrying to let ICE state settle
          setTimeout(() => {
            if (!you?.id) return;
            getOrCreatePeerConnection(peerId);
          }, 1000);
        } else {
          console.warn(`WebRTC: giving up on peer ${peerId} after ${MAX_RETRIES} retries`);
        }
      }

      if (state === 'disconnected') {
        // "disconnected" is often transient (network blip) — give it a
        // few seconds to recover before tearing down. If it recovers
        // to "connected" the timer is cleared above.
        if (!timeoutsRef.current.has(peerId)) {
          const timer = setTimeout(() => {
            timeoutsRef.current.delete(peerId);
            const currentPc = peerConnections.current.get(peerId);
            if (currentPc && currentPc.iceConnectionState === 'disconnected') {
              const retries = retryCountRef.current.get(peerId) || 0;
              if (retries < MAX_RETRIES) {
                retryCountRef.current.set(peerId, retries + 1);
                destroyPeer(peerId);
                if (!you?.id) return;
                getOrCreatePeerConnection(peerId);
              }
            }
          }, 5000);
          timeoutsRef.current.set(peerId, timer);
        }
      }
    };

    // ── Perfect Negotiation: onnegotiationneeded ──────────────────────
    pc.onnegotiationneeded = async () => {
      try {
        makingOfferRef.current.add(peerId);
        await pc.setLocalDescription();
        socket.emit('webrtc:offer', { to: peerId, offer: pc.localDescription });
      } catch (err) {
        console.warn('Renegotiation failed for', peerId, err);
      } finally {
        makingOfferRef.current.delete(peerId);
      }
    };

    // ── Symmetric Data Channel ────────────────────────────────────────
    // With perfect negotiation, both sides create the exact same data channel.
    // Using negotiated: true and id: 1 ensures they connect immediately without
    // waiting for in-band signaling.
    const dc = pc.createDataChannel('file-stream', { negotiated: true, id: 1, ordered: true });
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      dataChannelsRef.current.set(peerId, dc);
      setDataChannels(new Map(dataChannelsRef.current));
    };
    dc.onclose = () => {
      dataChannelsRef.current.delete(peerId);
      setDataChannels(new Map(dataChannelsRef.current));
    };

    peerConnections.current.set(peerId, pc);

    // ── Connection timeout ────────────────────────────────────────────
    // If the connection doesn't reach "connected" within the timeout,
    // tear it down and retry. This catches the case where ICE never
    // completes (e.g. after a server cold-start, the signaling messages
    // arrived before the peer was ready to respond).
    const timeoutTimer = setTimeout(() => {
      timeoutsRef.current.delete(peerId);
      const currentPc = peerConnections.current.get(peerId);
      if (currentPc && currentPc.iceConnectionState !== 'connected' && currentPc.iceConnectionState !== 'completed') {
        const retries = retryCountRef.current.get(peerId) || 0;
        if (retries < MAX_RETRIES) {
          console.warn(`WebRTC: connection to ${peerId} timed out, retrying (${retries + 1}/${MAX_RETRIES})`);
          retryCountRef.current.set(peerId, retries + 1);
          destroyPeer(peerId);
          getOrCreatePeerConnection(peerId);
        }
      }
    }, CONNECTION_TIMEOUT_MS);
    timeoutsRef.current.set(peerId, timeoutTimer);

    return pc;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destroyPeer]);

  // Called after switching mic/camera device. The new track already lives on
  // the local stream (useLocalMedia swapped it in place); this pushes that
  // same track onto every existing connection's sender via replaceTrack,
  // which renegotiates audio/video in place with no offer/answer round trip
  // and no flicker for the other participants. Falls back to addTrack only
  // for the (rare) case a connection has no sender of that kind yet.
  const replaceLocalTrack = useCallback((track) => {
    if (!track) return;
    peerConnections.current.forEach((pc) => {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === track.kind);
      if (sender) {
        sender.replaceTrack(track).catch((err) => console.warn('Failed to replace track for', track.kind, err));
      } else {
        pc.addTrack(track, localStreamRef.current || undefined);
      }
    });
  }, []);

  const createOffer = useCallback(
    async (peerId) => {
      const pc = getOrCreatePeerConnection(peerId, { asOfferer: true });
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc:offer', { to: peerId, offer });
      } catch (err) {
        console.warn('Failed to create offer for', peerId, err);
      }
    },
    [getOrCreatePeerConnection]
  );

  // Keep ref updated so timeouts can use the latest version without circular deps
  useEffect(() => {
    createOfferRef.current = createOffer;
  }, [createOffer]);

  // Signaling listeners — registered once, independent of local media state,
  // so a participant without camera/mic access can still receive others.
  useEffect(() => {
    async function flushPendingCandidates(peerId, pc) {
      const queue = pendingCandidatesRef.current.get(peerId) || [];
      if (queue.length > 0 && pc.remoteDescription) {
        for (const candidate of queue) {
          try {
            await pc.addIceCandidate(candidate);
          } catch (err) {
            console.warn('Failed to add buffered ICE candidate from', peerId, err);
          }
        }
        pendingCandidatesRef.current.delete(peerId);
      }
    }


    async function handleOffer({ from, offer }) {
      const pc = getOrCreatePeerConnection(from);
      const isPolite = you?.id > from;
      const offerCollision = makingOfferRef.current.has(from) || pc.signalingState !== 'stable';
      
      ignoreOfferRef.current.set(from, !isPolite && offerCollision);
      if (ignoreOfferRef.current.get(from)) {
        return;
      }

      try {
        if (offerCollision) {
          await pc.setLocalDescription({ type: 'rollback' });
        }
        await pc.setRemoteDescription(offer);
        
        await flushPendingCandidates(from, pc);

        await pc.setLocalDescription(); // Automatically creates answer
        socket.emit('webrtc:answer', { to: from, answer: pc.localDescription });
      } catch (err) {
        console.warn('Failed to handle offer from', from, err);
      }
    }

    async function handleAnswer({ from, answer }) {
      const pc = peerConnections.current.get(from);
      if (pc) {
        try {
          await pc.setRemoteDescription(answer);
          await flushPendingCandidates(from, pc);
        } catch (err) {
          console.warn('Failed to handle answer from', from, err);
        }
      }
    }

    async function handleIceCandidate({ from, candidate }) {
      const pc = getOrCreatePeerConnection(from);
      if (candidate) {
        try {
          if (!pc.remoteDescription) {
            // Remote description not set yet, buffer the candidate
            const queue = pendingCandidatesRef.current.get(from) || [];
            queue.push(candidate);
            pendingCandidatesRef.current.set(from, queue);
          } else {
            // Safe to add immediately
            await pc.addIceCandidate(candidate);
          }
        } catch (err) {
          if (!ignoreOfferRef.current.get(from)) {
            console.warn('Failed to add ICE candidate from', from, err);
          }
        }
      }
    }

    socket.on('webrtc:offer', handleOffer);
    socket.on('webrtc:answer', handleAnswer);
    socket.on('webrtc:ice-candidate', handleIceCandidate);

    return () => {
      socket.off('webrtc:offer', handleOffer);
      socket.off('webrtc:answer', handleAnswer);
      socket.off('webrtc:ice-candidate', handleIceCandidate);
    };
  }, [getOrCreatePeerConnection, you]);

  // ── Socket reconnection: tear down all peers and re-establish ──────
  // When the socket reconnects (e.g. after Render cold-start timeout),
  // all the old signaling channels are gone — any existing PeerConnections
  // are zombies. Destroy them so the participant-change effect below
  // creates fresh ones.
  useEffect(() => {
    if (!reconnectToken) return;
    destroyAllPeers();
  }, [reconnectToken, destroyAllPeers]);

  // Check for new participants and establish connections.
  // Perfect negotiation handles who offers seamlessly.
  useEffect(() => {
    if (!you?.id) return;
    participants.forEach((p) => {
      if (p.id === you.id) return;
      const existing = peerConnections.current.get(p.id);
      if (existing) {
        // If the connection exists but is dead, tear it down so we can retry
        const state = existing.iceConnectionState;
        if (state === 'failed' || state === 'closed') {
          destroyPeer(p.id);
        } else {
          return; // Connection exists and is alive, skip
        }
      }
      getOrCreatePeerConnection(p.id);
    });
  }, [participants, you, getOrCreatePeerConnection, destroyPeer]);

  // Tear down connections for anyone who has left the room.
  useEffect(() => {
    const currentIds = new Set(participants.map((p) => p.id));
    for (const id of [...peerConnections.current.keys()]) {
      if (!currentIds.has(id)) {
        destroyPeer(id);
        retryCountRef.current.delete(id);
      }
    }
  }, [participants, destroyPeer]);

  // Full cleanup on unmount (leaving the room).
  useEffect(() => {
    return () => {
      peerConnections.current.forEach((pc) => {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onnegotiationneeded = null;
        pc.oniceconnectionstatechange = null;
        pc.ondatachannel = null;
        pc.close();
      });
      peerConnections.current.clear();
      makingOfferRef.current.clear();
      ignoreOfferRef.current.clear();
      retryCountRef.current.clear();
      for (const timer of timeoutsRef.current.values()) clearTimeout(timer);
      timeoutsRef.current.clear();
    };
  }, []);

  return { remoteStreams, replaceLocalTrack, dataChannels, destroyAllPeers };
}
