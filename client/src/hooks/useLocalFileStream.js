import { useEffect, useRef, useState } from 'react';

const CHUNK_SIZE = 64 * 1024; // 64 KB - Lowest, safest chunk size for strict WebRTC limits

function getMimeType(file) {
  if (file.type) return file.type;
  const name = file.name.toLowerCase();
  if (name.endsWith('.mkv')) return 'video/mp4'; // Disguise as MP4 to trigger Chromium's byte sniffer
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.avi')) return 'video/mp4'; // Disguise as MP4
  if (name.endsWith('.mov')) return 'video/quicktime';
  return 'video/mp4'; // fallback
}

export function useLocalFileStream({ isHost, hostId, dataChannels, file }) {
  const [streamUrl,      setStreamUrl]      = useState(null);
  const [streamReady,    setStreamReady]    = useState(false);
  const [streamError,    setStreamError]    = useState(null);
  const [streamProgress, setStreamProgress] = useState(0); // 0–100

  // HOST: per-peer send progress — Map<peerId, number (0–100)>
  const [hostSendProgress, setHostSendProgress] = useState(new Map());

  // HOST: always read the latest file inside callbacks/listeners
  const fileRef = useRef(file);
  useEffect(() => { fileRef.current = file; }, [file]);

  // HOST: tracking
  const hostAttachedPeersRef = useRef(new Set());
  const activeRangesRef = useRef(new Set());

  // PARTICIPANT: tracking
  const streamInfoRef = useRef({ id: null, meta: null });
  const serviceWorkerPortRef = useRef(null);
  const pendingRequests = useRef(new Map()); // reqId -> replyPort
  const currentReqIdRef = useRef(null);
  const participantAttachedRef = useRef(false);

  // ── HOST: stream the file chunk-by-chunk on demand ──
  useEffect(() => {
    if (!isHost || !file) return;

    dataChannels.forEach((dc, peerId) => {
      if (hostAttachedPeersRef.current.has(peerId)) return;
      hostAttachedPeersRef.current.add(peerId);
      
      // Tell participant that file metadata is ready right away so they can register the SW stream
      if (dc.readyState === 'open') {
        dc.send(JSON.stringify({
          type: 'file-stream-meta',
          name: file.name,
          size: file.size,
          mimeType: getMimeType(file)
        }));
      } else {
        // If it opens later, send it then
        const originalOnOpen = dc.onopen;
        dc.onopen = (e) => {
          dc.send(JSON.stringify({
            type: 'file-stream-meta',
            name: file.name,
            size: file.size,
            mimeType: getMimeType(file)
          }));
          if (originalOnOpen) originalOnOpen(e);
        };
      }

      async function handleHostMessage(event) {
        if (typeof event.data !== 'string') return;
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type === 'request-meta') {
          dc.send(JSON.stringify({
            type: 'file-stream-meta',
            name: fileRef.current.name,
            size: fileRef.current.size,
            mimeType: getMimeType(fileRef.current)
          }));
        } else if (msg.type === 'request-range') {
          const { start, end, reqId } = msg;
          let offset = start;
          activeRangesRef.current.add(reqId);
          
          while (offset <= end) {
            if (!activeRangesRef.current.has(reqId)) {
              // Range was cancelled by the participant
              break;
            }
            
            // Flow control - MUST be safely below Chrome's 16MB SCTP buffer limit
            while (dc.bufferedAmount > 8 * 1024 * 1024) {
              await new Promise(r => setTimeout(r, 5));
              if (!activeRangesRef.current.has(reqId)) break;
            }
            if (dc.readyState !== 'open') return;
            if (!activeRangesRef.current.has(reqId)) break;

            const sliceEnd = Math.min(offset + CHUNK_SIZE, end + 1);
            const slice = fileRef.current.slice(offset, sliceEnd);
            const buffer = await slice.arrayBuffer();

            // Send header then binary data - wrapped in retry logic for safety
            try {
              dc.send(JSON.stringify({ type: 'chunk-header', reqId }));
              dc.send(buffer);
              offset += buffer.byteLength;
            } catch (err) {
              // If send fails (e.g. buffer full spike), wait and retry the exact same offset
              await new Promise(r => setTimeout(r, 50));
            }
          }
          
          if (dc.readyState === 'open' && activeRangesRef.current.has(reqId)) {
            dc.send(JSON.stringify({ type: 'chunk-end', reqId }));
          }
          activeRangesRef.current.delete(reqId);

        } else if (msg.type === 'cancel-range') {
          activeRangesRef.current.delete(msg.reqId);
        } else if (msg.type === 'file-stream-progress') {
          setHostSendProgress((prev) => new Map(prev).set(peerId, msg.progress));
        }
      }

      dc.addEventListener('message', handleHostMessage);
      
      // Cleanup for this peer if DC closes
      const originalOnClose = dc.onclose;
      dc.onclose = (e) => {
        hostAttachedPeersRef.current.delete(peerId);
        dc.removeEventListener('message', handleHostMessage);
        if (originalOnClose) originalOnClose(e);
      };
    });
  }, [isHost, dataChannels, file]);

  // Reset attached peers when file changes so we send meta again
  useEffect(() => {
    hostAttachedPeersRef.current.clear();
    activeRangesRef.current.clear();
  }, [file]);


  // ── PARTICIPANT: unconditionally listen to the host's stream ──
  useEffect(() => {
    if (isHost || !hostId) return;

    // We only attach ONCE per host. If we are already attached, do nothing.
    if (participantAttachedRef.current) return;

    const dc = dataChannels.get(hostId);
    if (!dc) return; // Wait until host DC is created

    participantAttachedRef.current = true;

    // Reset state for fresh stream
    setStreamUrl(null);
    setStreamReady(false);
    setStreamError(null);
    setStreamProgress(0);

    function handleParticipantMessage(event) {
      if (typeof event.data === 'string') {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type === 'file-stream-meta') {
          if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
            setStreamError("Service Worker not active. Please refresh the page.");
            return;
          }

          const streamId = Math.random().toString(36).substring(2);
          streamInfoRef.current = { id: streamId, meta: msg };
          
          const channel = new MessageChannel();
          serviceWorkerPortRef.current = channel.port1;
          
          channel.port1.onmessage = (swEvent) => {
            if (swEvent.data.type === 'REGISTER_ACK') {
              setStreamUrl(`/stream-media/${streamId}`);
              setStreamReady(true);
              // Set progress to 100% since we can play immediately and don't need the progress bar anymore
              setStreamProgress(100); 
            } else if (swEvent.data.type === 'request-range') {
              const { start, end, reqId, replyPort } = swEvent.data;
              pendingRequests.current.set(reqId, replyPort);
              
              if (dc.readyState === 'open') {
                dc.send(JSON.stringify({
                  type: 'request-range',
                  start,
                  end,
                  reqId
                }));
              }
            } else if (swEvent.data.type === 'cancel-range') {
              const { reqId } = swEvent.data;
              pendingRequests.current.delete(reqId);
              if (dc.readyState === 'open') {
                dc.send(JSON.stringify({
                  type: 'cancel-range',
                  reqId
                }));
              }
            }
          };

          navigator.serviceWorker.controller.postMessage({
            type: 'REGISTER_STREAM',
            streamId,
            meta: msg
          }, [channel.port2]);
          
        } else if (msg.type === 'chunk-header') {
          currentReqIdRef.current = msg.reqId;
        } else if (msg.type === 'chunk-end') {
          const reqId = msg.reqId;
          if (pendingRequests.current.has(reqId)) {
            const port = pendingRequests.current.get(reqId);
            port.postMessage({ type: 'end' });
            pendingRequests.current.delete(reqId);
          }
          currentReqIdRef.current = null;
        }
      } else if (event.data instanceof ArrayBuffer) {
        const reqId = currentReqIdRef.current;
        if (reqId && pendingRequests.current.has(reqId)) {
          const port = pendingRequests.current.get(reqId);
          port.postMessage({ type: 'chunk', data: event.data }, [event.data]);
        }
      }
    }

    if (dc.readyState === 'open') {
      dc.addEventListener('message', handleParticipantMessage);
      dc.send(JSON.stringify({ type: 'request-meta' }));
    } else {
      const originalOnOpen = dc.onopen;
      dc.onopen = (e) => {
        dc.addEventListener('message', handleParticipantMessage);
        dc.send(JSON.stringify({ type: 'request-meta' }));
        if (originalOnOpen) originalOnOpen(e);
      };
    }

    const originalOnClose = dc.onclose;
    dc.onclose = (e) => {
      participantAttachedRef.current = false;
      dc.removeEventListener('message', handleParticipantMessage);
      if (originalOnClose) originalOnClose(e);
    };

    return () => {
      participantAttachedRef.current = false;
      dc.removeEventListener('message', handleParticipantMessage);
    };
  }, [isHost, hostId, dataChannels]);

  return { streamUrl, streamReady, streamError, streamProgress, hostSendProgress };
}
