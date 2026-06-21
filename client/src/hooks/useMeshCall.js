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
  // Track which peers we are the offerer for, so only the offerer renegotiates
  const offererForRef = useRef(new Set());
  // Guard against multiple renegotiations firing at the same time
  const negotiatingRef = useRef(new Set());
  // Track retry counts per peer
  const retryCountRef = useRef(new Map());
  // Track connection timeouts per peer
  const timeoutsRef = useRef(new Map());
  // Buffer incoming ICE candidates that arrive before the remote description is set
  const pendingCandidatesRef = useRef(new Map());
  // Ref to the latest createOffer function to avoid stale closures in timeouts
  const createOfferRef = useRef(null);

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
    offererForRef.current.delete(peerId);
    negotiatingRef.current.delete(peerId);
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

  const getOrCreatePeerConnection = useCallback((peerId, { asOfferer = false } = {}) => {
    const existing = peerConnections.current.get(peerId);
    if (existing) {
      // If the existing connection is dead/failed, tear it down and create a new one
      const state = existing.iceConnectionState;
      if (state === 'failed' || state === 'closed') {
        destroyPeer(peerId);
      } else {
        return existing;
      }
    }

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
          const wasOfferer = offererForRef.current.has(peerId);
          destroyPeer(peerId);
          // Small delay before retrying to let ICE state settle
          setTimeout(() => {
            // Only retry if the peer is still in the participant list
            if (!you?.id) return;
            if (wasOfferer || you.id < peerId) {
              if (createOfferRef.current) createOfferRef.current(peerId);
            } else {
              getOrCreatePeerConnection(peerId);
            }
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
                const wasOfferer = offererForRef.current.has(peerId);
                destroyPeer(peerId);
                if (!you?.id) return;
                if (wasOfferer || you.id < peerId) {
                  if (createOfferRef.current) createOfferRef.current(peerId);
                } else {
                  getOrCreatePeerConnection(peerId);
                }
              }
            }
          }, 5000);
          timeoutsRef.current.set(peerId, timer);
        }
      }
    };

    // Renegotiation: when tracks are added after the initial offer/answer
    // (e.g. camera stream arrives late), the browser fires this event.
    // Only the offerer side should respond to avoid "glare" (both sides
    // offering at once). If the answerer needs to renegotiate, they ask the
    // offerer to do it.
    pc.onnegotiationneeded = async () => {
      if (!offererForRef.current.has(peerId)) {
        socket.emit('webrtc:renegotiate', { to: peerId });
        return;
      }
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
          const wasOfferer = offererForRef.current.has(peerId);
          destroyPeer(peerId);
          if (wasOfferer) {
            createOffer(peerId);
          }
          // If not offerer, the remote side's retry or re-offer will handle it
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
        
        await flushPendingCandidates(from, pc);

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
          await flushPendingCandidates(from, pc);
        } catch (err) {
          console.warn('Failed to handle answer from', from, err);
        }
      }
    }

    async function handleIceCandidate({ from, candidate }) {
      const pc = peerConnections.current.get(from);
      if (pc && candidate) {
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
          console.warn('Failed to add ICE candidate from', from, err);
        }
      }
    }

    function handleRenegotiate({ from }) {
      if (offererForRef.current.has(from)) {
        if (createOfferRef.current) createOfferRef.current(from);
      }
    }

    socket.on('webrtc:offer', handleOffer);
    socket.on('webrtc:answer', handleAnswer);
    socket.on('webrtc:ice-candidate', handleIceCandidate);
    socket.on('webrtc:renegotiate', handleRenegotiate);

    return () => {
      socket.off('webrtc:offer', handleOffer);
      socket.off('webrtc:answer', handleAnswer);
      socket.off('webrtc:ice-candidate', handleIceCandidate);
      socket.off('webrtc:renegotiate', handleRenegotiate);
    };
  }, [getOrCreatePeerConnection]);

  // ── Socket reconnection: tear down all peers and re-establish ──────
  // When the socket reconnects (e.g. after Render cold-start timeout),
  // all the old signaling channels are gone — any existing PeerConnections
  // are zombies. Destroy them so the participant-change effect below
  // creates fresh ones.
  useEffect(() => {
    if (!reconnectToken) return;
    destroyAllPeers();
  }, [reconnectToken, destroyAllPeers]);

  // Decide, for each peer pair, who sends the initial offer — comparing ids
  // deterministically avoids both sides offering at once ("glare").
  // Also checks for dead/failed connections and re-establishes them.
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
      if (you.id < p.id) {
        createOffer(p.id);
      } else {
        getOrCreatePeerConnection(p.id);
      }
    });
  }, [participants, you, createOffer, getOrCreatePeerConnection, destroyPeer]);

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
      offererForRef.current.clear();
      negotiatingRef.current.clear();
      retryCountRef.current.clear();
      for (const timer of timeoutsRef.current.values()) clearTimeout(timer);
      timeoutsRef.current.clear();
    };
  }, []);

  return { remoteStreams, replaceLocalTrack, dataChannels, destroyAllPeers };
}
