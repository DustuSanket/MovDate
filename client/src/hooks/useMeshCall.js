import { useCallback, useEffect, useRef, useState } from 'react';
import { socket } from '../lib/socket.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
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
const CONNECTION_TIMEOUT_MS = 8_000;
// Max retries per peer before giving up
const MAX_RETRIES = 5;
// How often to check for unhealthy peers and re-poke them
const HEALTH_CHECK_INTERVAL_MS = 4_000;

// A simple mesh: every participant opens a direct connection to every other
// participant. This is the simplest topology and needs no media server, but
// bandwidth scales with the square of the group size — it's a great fit for
// the small-group "watch party with friends" use case (roughly 2-6 people),
// not for large broadcasts. For bigger rooms, swap this for an SFU (e.g. a
// self-hosted mediasoup/LiveKit server, or a hosted provider).
export function useMeshCall({ you, participants, localStream, screenStream, reconnectToken }) {
  const [remoteStreams, setRemoteStreams] = useState({});
  const [dataChannels, setDataChannels] = useState(new Map());
  const peerConnections = useRef(new Map());
  const localStreamRef = useRef(null);
  const dataChannelsRef = useRef(new Map());
  // Track perfect negotiation state per peer
  const screenStreamRef = useRef(null);
  const makingOfferRef = useRef(new Set());
  const ignoreOfferRef = useRef(new Map());
  // Track retry counts per peer
  const retryCountRef = useRef(new Map());
  // Track connection timeouts per peer
  const timeoutsRef = useRef(new Map());
  // Buffer incoming ICE candidates that arrive before the PC or remote description exists
  const pendingCandidatesRef = useRef(new Map());
  // Keep `you` in a ref so callbacks always see the latest value
  const youRef = useRef(you);
  useEffect(() => { youRef.current = you; }, [you]);

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
    peerConnections.current.forEach((pc) => {
      if (!localStream) return;
      const existingTracks = new Set(pc.getSenders().map((sender) => sender.track));
      localStream.getTracks().forEach((track) => {
        if (!existingTracks.has(track)) pc.addTrack(track, localStream);
      });
    });
  }, [localStream]);

  // Handle Screen Stream exactly like localStream
  useEffect(() => {
    screenStreamRef.current = screenStream;
    peerConnections.current.forEach((pc) => {
      const senders = pc.getSenders();
      
      // If screenStream is active, add its tracks
      if (screenStream) {
        const existingTracks = new Set(senders.map((s) => s.track));
        screenStream.getTracks().forEach((track) => {
          if (!existingTracks.has(track)) pc.addTrack(track, screenStream);
        });
      } else {
        // If screenStream is stopped, remove the senders that belong to it
        // Since we don't have the stream reference anymore if it's null, we remove 
        // any sender whose track is NOT in the localStream
        senders.forEach((sender) => {
          if (sender.track && localStreamRef.current && !localStreamRef.current.getTracks().includes(sender.track)) {
            pc.removeTrack(sender);
          }
        });
      }
    });
  }, [screenStream]);

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

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, screenStreamRef.current);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc:ice-candidate', { to: peerId, candidate: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (!stream) return;

      setRemoteStreams((prev) => {
        const peerStreams = prev[peerId] || [];
        if (peerStreams.includes(stream)) return prev;
        return { ...prev, [peerId]: [...peerStreams, stream] };
      });

      stream.onremovetrack = () => {
        if (stream.getTracks().length === 0) {
          setRemoteStreams((prev) => {
            const peerStreams = prev[peerId] || [];
            return { ...prev, [peerId]: peerStreams.filter(s => s !== stream) };
          });
        }
      };
    };

    // ── ICE connection state monitoring ──────────────────────────────
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;

      if (state === 'connected' || state === 'completed') {
        // Connection succeeded — clear the timeout and reset retries
        const timer = timeoutsRef.current.get(peerId);
        if (timer) { clearTimeout(timer); timeoutsRef.current.delete(peerId); }
        retryCountRef.current.delete(peerId);
      }

      if (state === 'failed') {
        const retries = retryCountRef.current.get(peerId) || 0;
        if (retries < MAX_RETRIES) {
          retryCountRef.current.set(peerId, retries + 1);
          destroyPeer(peerId);
          setTimeout(() => {
            if (!youRef.current?.id) return;
            getOrCreatePeerConnection(peerId);
          }, 500 + Math.random() * 500);
        } else {
          console.warn(`WebRTC: giving up on peer ${peerId} after ${MAX_RETRIES} retries`);
        }
      }

      if (state === 'disconnected') {
        if (!timeoutsRef.current.has(peerId)) {
          const timer = setTimeout(() => {
            timeoutsRef.current.delete(peerId);
            const currentPc = peerConnections.current.get(peerId);
            if (currentPc && currentPc.iceConnectionState === 'disconnected') {
              const retries = retryCountRef.current.get(peerId) || 0;
              if (retries < MAX_RETRIES) {
                retryCountRef.current.set(peerId, retries + 1);
                destroyPeer(peerId);
                if (!youRef.current?.id) return;
                getOrCreatePeerConnection(peerId);
              }
            }
          }, 5000);
          timeoutsRef.current.set(peerId, timer);
        }
      }
    };

    // ── Perfect Negotiation: onnegotiationneeded ──────────────────────
    // This fires whenever the browser decides a new offer is needed (e.g.
    // when tracks are added). It only fires in "stable" state, so
    // setLocalDescription() always produces an offer here.
    pc.onnegotiationneeded = async () => {
      try {
        makingOfferRef.current.add(peerId);
        await pc.setLocalDescription();
        socket.emit('webrtc:offer', { to: peerId, offer: pc.localDescription });
      } catch (err) {
        console.warn('onnegotiationneeded failed for', peerId, err);
      } finally {
        makingOfferRef.current.delete(peerId);
      }
    };

    // ── Symmetric Data Channel ────────────────────────────────────────
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

    // ── Flush any ICE candidates that arrived before this PC existed ──
    const earlyQueue = pendingCandidatesRef.current.get(peerId);
    if (earlyQueue && earlyQueue.length > 0) {
      // These will be internally queued by the browser until the remote
      // description is set (spec: "pending remote candidates").
      // We can't addIceCandidate until remoteDescription is set, so
      // keep them in pendingCandidatesRef for flushPendingCandidates().
    }

    // ── Connection timeout ────────────────────────────────────────────
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

  // Called after switching mic/camera device.
  const replaceLocalTrack = useCallback((track) => {
    if (!track) return;
    peerConnections.current.forEach((pc) => {
      // Find the sender for the localStream (not the screenStream)
      const sender = pc.getSenders().find((s) => {
        return s.track && s.track.kind === track.kind && 
               (!screenStreamRef.current || !screenStreamRef.current.getTracks().includes(s.track));
      });
      if (sender) {
        sender.replaceTrack(track).catch((err) => console.warn('Failed to replace track for', track.kind, err));
      } else {
        pc.addTrack(track, localStreamRef.current || undefined);
      }
    });
  }, []);

  // ── Signaling listeners ─────────────────────────────────────────────
  // Registered once. Uses youRef (a ref) so it always sees the latest
  // `you` value without needing `you` in the dependency array. This
  // prevents the listeners from being torn down and re-added when `you`
  // changes — which was a window where incoming signals could be LOST.
  useEffect(() => {
    function flushPendingCandidates(peerId, pc) {
      const queue = pendingCandidatesRef.current.get(peerId);
      if (!queue || queue.length === 0 || !pc.remoteDescription) return;
      pendingCandidatesRef.current.delete(peerId);
      for (const candidate of queue) {
        pc.addIceCandidate(candidate).catch((err) => {
          console.warn('Failed to add buffered ICE candidate from', peerId, err);
        });
      }
    }

    async function handleOffer({ from, offer }) {
      const pc = getOrCreatePeerConnection(from);
      // Use the ref so we always read the latest `you` value
      const myId = youRef.current?.id;
      const isPolite = myId ? myId > from : false;

      const offerCollision =
        makingOfferRef.current.has(from) || pc.signalingState !== 'stable';

      ignoreOfferRef.current.set(from, !isPolite && offerCollision);
      if (ignoreOfferRef.current.get(from)) {
        return;
      }

      try {
        // In the polite peer case with a collision, setRemoteDescription()
        // implicitly rolls back the pending local offer (supported in all
        // modern browsers since ~2020).
        await pc.setRemoteDescription(offer);

        flushPendingCandidates(from, pc);

        await pc.setLocalDescription(); // Automatically creates answer
        socket.emit('webrtc:answer', { to: from, answer: pc.localDescription });
      } catch (err) {
        console.warn('Failed to handle offer from', from, err);
      }
    }

    async function handleAnswer({ from, answer }) {
      const pc = peerConnections.current.get(from);
      if (!pc) return;
      try {
        await pc.setRemoteDescription(answer);
        flushPendingCandidates(from, pc);
      } catch (err) {
        console.warn('Failed to handle answer from', from, err);
      }
    }

    // ── KEY FIX: handleIceCandidate must NOT create peer connections ──
    // Previously this called getOrCreatePeerConnection(from), which would
    // create a brand-new PC, add tracks, and fire onnegotiationneeded —
    // sending a spurious offer that collided with the real one. Now we
    // simply buffer the candidate until the PC exists and has a remote
    // description set.
    async function handleIceCandidate({ from, candidate }) {
      if (!candidate) return;
      if (ignoreOfferRef.current.get(from)) return;

      const pc = peerConnections.current.get(from);

      // Buffer if: no PC exists yet, OR PC exists but remote description
      // hasn't been set (addIceCandidate throws without remoteDescription)
      if (!pc || !pc.remoteDescription) {
        const queue = pendingCandidatesRef.current.get(from) || [];
        queue.push(candidate);
        pendingCandidatesRef.current.set(from, queue);
        return;
      }

      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        if (!ignoreOfferRef.current.get(from)) {
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
  // NOTE: `you` is deliberately NOT in this dependency array. We read it
  // via youRef so that these listeners are registered ONCE and never
  // torn down/re-added (which caused a window where signals were lost).
  }, [getOrCreatePeerConnection]);

  // ── Socket reconnection: tear down all peers and re-establish ──────
  useEffect(() => {
    if (!reconnectToken) return;
    destroyAllPeers();
  }, [reconnectToken, destroyAllPeers]);

  // ── Periodic health check ──────────────────────────────────────────
  // Every few seconds, check if any peer connection is stuck in a non-
  // connected state. If so, tear it down and recreate it. This catches
  // edge cases where the initial signaling was lost (e.g. offer arrived
  // before listeners were registered on the other side) and the timeout
  // hasn't fired yet.
  useEffect(() => {
    if (!you?.id) return;

    const interval = setInterval(() => {
      participants.forEach((p) => {
        if (p.id === you.id) return;
        const pc = peerConnections.current.get(p.id);
        if (!pc) {
          // PC doesn't exist at all — create it
          getOrCreatePeerConnection(p.id);
          return;
        }
        const state = pc.iceConnectionState;
        if (state === 'connected' || state === 'completed' || state === 'checking') {
          return; // Healthy or actively connecting
        }
        // PC exists but is stuck in 'new' or 'disconnected' — it never
        // got an offer/answer through. Tear it down and try again.
        if (state === 'new') {
          const retries = retryCountRef.current.get(p.id) || 0;
          if (retries < MAX_RETRIES) {
            console.warn(`WebRTC health: peer ${p.id} stuck in "new", retrying`);
            retryCountRef.current.set(p.id, retries + 1);
            destroyPeer(p.id);
            getOrCreatePeerConnection(p.id);
          }
        }
      });
    }, HEALTH_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [participants, you, getOrCreatePeerConnection, destroyPeer]);

  // Check for new participants and establish connections.
  useEffect(() => {
    if (!you?.id) return;
    participants.forEach((p) => {
      if (p.id === you.id) return;
      const existing = peerConnections.current.get(p.id);
      if (existing) {
        const state = existing.iceConnectionState;
        if (state === 'failed' || state === 'closed') {
          destroyPeer(p.id);
        } else {
          return;
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
