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

export function useLocalFileStream({ isHost, dataChannels, file, wantStream }) {
  const [streamUrl,      setStreamUrl]      = useState(null);
  const [streamReady,    setStreamReady]    = useState(false);
  const [streamError,    setStreamError]    = useState(null);
  const [streamProgress, setStreamProgress] = useState(0); // 0–100

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
      if (dc.readyState !== 'open') return;

      const slice  = f.slice(offset, offset + CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();
      dc.send(buffer);
      offset += buffer.byteLength;
    }

    // 3. End sentinel
    dc.send(JSON.stringify({ type: 'file-stream-end' }));
  }, []);

  // ── HOST: listen for an explicit "send me the file" request from each
  // peer, and only THEN start streaming to that peer. This is the fix for
  // the old behavior, which pushed the whole file down every open channel
  // the instant the host picked a file — long before participants had even
  // seen the prompt, let alone chosen "Stream from host". Anyone who clicked
  // "Stream from host" late (or who chose "Load my own copy" and never
  // listened at all) would have the meta frame and early chunks sail past
  // with no listener attached to catch them, so their progress bar never
  // moved off 0%.
  useEffect(() => {
    if (!isHost) return undefined;

    const attached = [];
    dataChannels.forEach((dc, peerId) => {
      function handleRequest(event) {
        if (typeof event.data !== 'string') return;
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'request-file-stream') {
          // Remove from sentToPeers so a re-request (after participant switches
          // source and comes back to "stream from host") is honoured.
          sentToPeers.current.delete(peerId);
          streamFileToPeer(peerId, dc);
        }
      }
      dc.addEventListener('message', handleRequest);
      attached.push([dc, handleRequest]);
    });

    return () => {
      attached.forEach(([dc, handler]) => dc.removeEventListener('message', handler));
    };
  }, [isHost, dataChannels, streamFileToPeer]);

  // Reset sentToPeers when the file changes so a new file re-streams to
  // anyone who re-requests it
  useEffect(() => {
    sentToPeers.current.clear();
  }, [file]);

  // ── PARTICIPANT: attach the listener AND ask the host to start, in the
  // same step — so there's no window where the host could be sending and
  // nobody is listening yet. ─────────────────────────────────────────────
  useEffect(() => {
    // When participant switches away from stream mode, clear all stream state
    // so the modal shows fresh options (no stale "Stream ready!" message).
    if (isHost || !wantStream) {
      setStreamUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
      setStreamReady(false);
      setStreamError(null);
      setStreamProgress(0);
      chunksRef.current    = [];
      receivedRef.current  = 0;
      totalSizeRef.current = 0;
      return;
    }

    // Find an open data channel
    let dc = null;
    for (const [, ch] of dataChannels) {
      if (ch.readyState === 'open') { dc = ch; break; }
    }
    if (!dc) return;

    // Always detach the old listener before re-attaching (even if DC is the same),
    // so switching source and coming back to "stream from host" always starts fresh.
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

    // Now that we're definitely listening, ask the host to start sending.
    if (dc.readyState === 'open') {
      dc.send(JSON.stringify({ type: 'request-file-stream' }));
    }

    // Store ref for cleanup
    dc._fileStreamCleanup = () => {
      dc.removeEventListener('message', handleMessage);
    };

    return () => {
      dc.removeEventListener('message', handleMessage);
      if (listeningDcRef.current === dc) listeningDcRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, wantStream, dataChannels]);

  // Revoke blob URL on unmount
  useEffect(() => {
    return () => {
      if (streamUrl) URL.revokeObjectURL(streamUrl);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamUrl]);

  return { streamUrl, streamReady, streamError, streamProgress, streamFileToPeer };
}
