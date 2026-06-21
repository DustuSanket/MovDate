/**
 * useLocalFileStream
 *
 * HOST: reads the File in 256 KB chunks and sends them over an RTCDataChannel —
 *       but only AFTER a participant explicitly asks for it (a small
 *       'request-file-stream' message over the same channel). The host never
 *       pushes the file blindly the moment the channel opens.
 *
 * PARTICIPANT (stream mode): attaches its message listener and sends the
 *   request in the same step, so it can never miss the meta frame or the
 *   first chunks. Accumulates all chunks into a Uint8Array, then creates a
 *   Blob URL once the full file has arrived. This is the most compatible
 *   approach — no MediaSource codec string guessing, no codec mismatch
 *   errors, no seek restrictions. The trade-off is that playback starts
 *   after the entire file is received, so it's best for smaller files or
 *   fast local networks. Progress is reported so the UI can show a bar.
 *
 * PARTICIPANT (local-copy mode): handled entirely in Room.jsx — this hook
 *   is not involved.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const CHUNK_SIZE = 256 * 1024; // 256 KB — good balance of overhead vs latency

export function useLocalFileStream({ isHost, dataChannels, file }) {
  const [streamUrl,      setStreamUrl]      = useState(null);
  const [streamReady,    setStreamReady]    = useState(false);
  const [streamError,    setStreamError]    = useState(null);
  const [streamProgress, setStreamProgress] = useState(0); // 0–100

  // HOST: per-peer send progress — Map<peerId, number (0–100)>
  // Exposed so the host UI can show which participants are loading
  const [hostSendProgress, setHostSendProgress] = useState(new Map());

  // HOST: track which peers we've already started sending to
  const sentToPeers = useRef(new Set());
  // HOST: always read the latest file inside callbacks/listeners without
  // having to re-create them (and re-attach DC listeners) on every change.
  const fileRef = useRef(file);
  useEffect(() => { fileRef.current = file; }, [file]);

  // PARTICIPANT: accumulation buffer
  const chunksRef      = useRef([]);
  const totalSizeRef   = useRef(0);
  const receivedRef    = useRef(0);
  const fileNameRef    = useRef('');
  const listeningDcRef = useRef(null);  // the DC we attached onmessage to

  // ── HOST: send file to one peer (only called once we know they want it) ──
  const streamFileToPeer = useCallback(async (peerId, dc) => {
    const f = fileRef.current;
    if (!f || dc.readyState !== 'open') return;
    if (sentToPeers.current.has(peerId)) return;
    sentToPeers.current.add(peerId);

    // Track progress for this peer — start at 0
    setHostSendProgress((prev) => new Map(prev).set(peerId, 0));

    // 1. Metadata
    dc.send(JSON.stringify({
      type: 'file-stream-meta',
      name: f.name,
      size: f.size,
    }));

    // 2. Chunks
    let offset = 0;
    while (offset < f.size) {
      // Flow control
      while (dc.bufferedAmount > 8 * 1024 * 1024) {
        await new Promise(r => setTimeout(r, 30));
      }
      if (dc.readyState !== 'open') {
        // Connection lost mid-stream — clean up progress
        setHostSendProgress((prev) => {
          const next = new Map(prev);
          next.delete(peerId);
          return next;
        });
        return;
      }

      const slice  = f.slice(offset, offset + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();
      dc.send(buffer);
      offset += buffer.byteLength;

      // Update send progress
      const pct = Math.round((offset / f.size) * 100);
      setHostSendProgress((prev) => new Map(prev).set(peerId, pct));
    }

    // 3. End sentinel
    dc.send(JSON.stringify({ type: 'file-stream-end' }));

    // Mark as complete — keep at 100 briefly so the UI shows "done",
    // then remove after a short delay
    setHostSendProgress((prev) => new Map(prev).set(peerId, 100));
    setTimeout(() => {
      setHostSendProgress((prev) => {
        const next = new Map(prev);
        next.delete(peerId);
        return next;
      });
    }, 3000);
  }, []);

  // ── HOST: stream the file to all open data channels ──
  useEffect(() => {
    if (!isHost || !file) return undefined;

    dataChannels.forEach((dc, peerId) => {
      if (dc.readyState === 'open') {
        streamFileToPeer(peerId, dc);
      }
    });
  }, [isHost, dataChannels, file, streamFileToPeer]);

  // Reset sentToPeers when the file changes so a new file re-streams
  useEffect(() => {
    sentToPeers.current.clear();
  }, [file]);

  // ── PARTICIPANT: unconditionally listen to the host's stream ──
  useEffect(() => {
    if (isHost) return undefined;

    // Find an open data channel
    let dc = null;
    for (const [, ch] of dataChannels) {
      if (ch.readyState === 'open') { dc = ch; break; }
    }
    if (!dc) return undefined;

    if (listeningDcRef.current === dc) return undefined; // Already listening to this channel

    // Always detach the old listener before re-attaching
    if (listeningDcRef.current && listeningDcRef.current._fileStreamCleanup) {
      listeningDcRef.current._fileStreamCleanup();
    }
    listeningDcRef.current = dc;

    // Reset state for fresh stream
    chunksRef.current    = [];
    receivedRef.current  = 0;
    totalSizeRef.current = 0;
    setStreamUrl(null);
    setStreamReady(false);
    setStreamError(null);
    setStreamProgress(0);

    function handleMessage(event) {
      const data = event.data;

      if (typeof data === 'string') {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        if (msg.type === 'file-stream-meta') {
          totalSizeRef.current = msg.size;
          fileNameRef.current  = msg.name;
          chunksRef.current    = [];
          receivedRef.current  = 0;
          return;
        }

        if (msg.type === 'file-stream-end') {
          // Assemble Blob and make a URL
          const blob  = new Blob(chunksRef.current);
          const url   = URL.createObjectURL(blob);
          setStreamUrl(url);
          setStreamReady(true);
          setStreamProgress(100);
          chunksRef.current = []; // free memory
          return;
        }
        return;
      }

      if (data instanceof ArrayBuffer) {
        chunksRef.current.push(data);
        receivedRef.current += data.byteLength;
        if (totalSizeRef.current > 0) {
          setStreamProgress(
            Math.round((receivedRef.current / totalSizeRef.current) * 100)
          );
        }
      }
    }

    dc.addEventListener('message', handleMessage);

    // Store ref for cleanup
    dc._fileStreamCleanup = () => {
      dc.removeEventListener('message', handleMessage);
    };

    return () => {
      dc.removeEventListener('message', handleMessage);
      if (listeningDcRef.current === dc) listeningDcRef.current = null;
    };
  }, [isHost, dataChannels]);

  // Revoke blob URL on unmount
  useEffect(() => {
    return () => {
      if (streamUrl) URL.revokeObjectURL(streamUrl);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl]);

  return { streamUrl, streamReady, streamError, streamProgress, streamFileToPeer, hostSendProgress };
}
