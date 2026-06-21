import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from '../lib/socket.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // For larger or stricter networks (corporate Wi-Fi, some mobile carriers),
  // plain STUN sometimes isn't enough — add a TURN server here for production:
  // { urls: 'turn:your-turn-server:3478', username: '...', credential: '...' },
];

// A simple mesh: every participant opens a direct connection to every other
// participant. This is the simplest topology and needs no media server, but
// bandwidth scales with the square of the group size — it's a great fit for
// the small-group "watch party with friends" use case (roughly 2-6 people),
// not for large broadcasts. For bigger rooms, swap this for an SFU (e.g. a
// self-hosted mediasoup/LiveKit server, or a hosted provider).
export function useMeshCall({ you, participants, localStream }) {
  const [remoteStreams, setRemoteStreams] = useState({});
  const [dataChannels, setDataChannels] = useState(new Map());
  const peerConnections = useRef(new Map());
  const localStreamRef = useRef(null);
  const dataChannelsRef = useRef(new Map());
  // Track which peers we are the offerer for, so only the offerer renegotiates
  const offererForRef = useRef(new Set());
  // Guard against multiple renegotiations firing at the same time
  const negotiatingRef = useRef(new Set());

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

  const getOrCreatePeerConnection = useCallback((peerId, { asOfferer = false } = {}) => {
    const existing = peerConnections.current.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    if (asOfferer) {
      offererForRef.current.add(peerId);
    }

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

    // Renegotiation: when tracks are added after the initial offer/answer
    // (e.g. camera stream arrives late), the browser fires this event.
    // Only the offerer side should respond to avoid "glare" (both sides
    // offering at once).
    pc.onnegotiationneeded = async () => {
      if (!offererForRef.current.has(peerId)) return;
      if (negotiatingRef.current.has(peerId)) return;
      negotiatingRef.current.add(peerId);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('webrtc:offer', { to: peerId, offer });
      } catch (err) {
        console.warn('Renegotiation failed for', peerId, err);
      } finally {
        negotiatingRef.current.delete(peerId);
      }
    };

    // Data channel — ONLY the offerer creates it; the answerer must receive
    // the very same channel via ondatachannel below. Calling
    // createDataChannel() on both sides (the old bug) doesn't give you one
    // shared channel under a shared name — it silently creates two entirely
    // separate, disconnected channels per peer pair, one per side. Each side
    // would then track whichever of its two unrelated channels happened to
    // open, under the same peerId key, with no guarantee they're talking to
    // the same pipe on the other end. Messages sent on one never arrive on
    // the other — which is exactly why streaming requests/data could vanish
    // with no error.
    if (asOfferer) {
      const dc = pc.createDataChannel('file-stream', { ordered: true });
      dc.binaryType = 'arraybuffer';
      dc.onopen = () => {
        dataChannelsRef.current.set(peerId, dc);
        setDataChannels(new Map(dataChannelsRef.current));
      };
      dc.onclose = () => {
        dataChannelsRef.current.delete(peerId);
        setDataChannels(new Map(dataChannelsRef.current));
      };
    }

    pc.ondatachannel = (event) => {
      const incoming = event.channel;
      incoming.binaryType = 'arraybuffer';
      incoming.onopen = () => {
        dataChannelsRef.current.set(peerId, incoming);
        setDataChannels(new Map(dataChannelsRef.current));
      };
      incoming.onclose = () => {
        dataChannelsRef.current.delete(peerId);
        setDataChannels(new Map(dataChannelsRef.current));
      };
      // Register immediately if already open
      if (incoming.readyState === 'open') {
        dataChannelsRef.current.set(peerId, incoming);
        setDataChannels(new Map(dataChannelsRef.current));
      }
    };

    peerConnections.current.set(peerId, pc);
    return pc;
  }, []);

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

  // Signaling listeners — registered once, independent of local media state,
  // so a participant without camera/mic access can still receive others.
  useEffect(() => {
    async function handleOffer({ from, offer }) {
      const pc = getOrCreatePeerConnection(from);
      try {
        // Handle both initial offers and renegotiation offers.
        // For renegotiation, the connection is already in 'stable' or may
        // have a pending local description (if we also tried to renegotiate).
        // Using rollback when we have a pending local offer resolves glare.
        if (pc.signalingState !== 'stable') {
          // We have a local offer pending — we're the non-offerer here (the
          // remote side is the real offerer via onnegotiationneeded), so
          // roll back our own offer and accept theirs.
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }),
            pc.setRemoteDescription(offer),
          ]);
        } else {
          await pc.setRemoteDescription(offer);
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc:answer', { to: from, answer });
      } catch (err) {
        console.warn('Failed to handle offer from', from, err);
      }
    }

    async function handleAnswer({ from, answer }) {
      const pc = peerConnections.current.get(from);
      if (pc) {
        try {
          await pc.setRemoteDescription(answer);
        } catch (err) {
          console.warn('Failed to handle answer from', from, err);
        }
      }
    }

    async function handleIceCandidate({ from, candidate }) {
      const pc = peerConnections.current.get(from);
      if (pc && candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          console.warn('Failed to add ICE candidate from', from, err);
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
  }, [getOrCreatePeerConnection]);

  // Decide, for each peer pair, who sends the initial offer — comparing ids
  // deterministically avoids both sides offering at once ("glare").
  useEffect(() => {
    if (!you?.id) return;
    participants.forEach((p) => {
      if (p.id === you.id || peerConnections.current.has(p.id)) return;
      if (you.id < p.id) {
        createOffer(p.id);
      } else {
        getOrCreatePeerConnection(p.id);
      }
    });
  }, [participants, you, createOffer, getOrCreatePeerConnection]);

  // Tear down connections for anyone who has left the room.
  useEffect(() => {
    const currentIds = new Set(participants.map((p) => p.id));
    for (const [id, pc] of peerConnections.current.entries()) {
      if (!currentIds.has(id)) {
        pc.close();
        peerConnections.current.delete(id);
        offererForRef.current.delete(id);
        negotiatingRef.current.delete(id);
        setRemoteStreams((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    }
  }, [participants]);

  // Full cleanup on unmount (leaving the room).
  useEffect(() => {
    return () => {
      peerConnections.current.forEach((pc) => pc.close());
      peerConnections.current.clear();
      offererForRef.current.clear();
      negotiatingRef.current.clear();
    };
  }, []);

  return { remoteStreams, replaceLocalTrack, dataChannels };
}
