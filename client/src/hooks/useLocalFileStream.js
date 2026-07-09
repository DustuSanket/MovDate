import { useEffect, useRef, useState } from 'react';

const CHUNK_SIZE = 64 * 1024; // 64 KB - Lowest, safest chunk size for strict WebRTC limits

// Sniffs the actual container format from the file's magic bytes, instead
// of trusting the filename/extension or the OS-reported `file.type`.
// Release names very commonly carry a leftover/double extension (e.g.
// "Movie.x264.mkv.mp4") from whatever tool converted them, which makes
// `file.type` lie about the real container. Since we control the
// Content-Type we hand to the participant's <video> element, getting this
// wrong is exactly what causes a real, playable file to be rejected with
// a bogus "unsupported codec" error — the browser was never shown the
// actual container it needed to demux.
async function sniffContainer(file) {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const bytesEqual = (offset, sig) => sig.every((b, i) => head[offset + i] === b);
  const ascii = (offset, len) =>
    Array.from(head.slice(offset, offset + len)).map(b => String.fromCharCode(b)).join('');

  // Matroska / WebM: EBML magic 0x1A45DFA3
  if (bytesEqual(0, [0x1a, 0x45, 0xdf, 0xa3])) {
    // Real .webm (VP8/VP9/AV1+Opus/Vorbis) is honestly labeled video/webm.
    // Real .mkv, though, very often carries H.264/H.265+AC3/AAC — codecs
    // Chromium CAN demux from a Matroska container, but only if it isn't
    // told upfront that the container is WebM (WebM's codec registry is
    // stricter and Chromium will refuse before ever looking at the actual
    // stream). Labeling it video/mp4 instead isn't accurate, but it's what
    // actually gets Chromium's byte-level container sniffer to look past
    // the declared type and demux the real Matroska structure underneath —
    // this exact trick is what made this app's .mkv playback work before.
    const name = file.name.toLowerCase();
    if (name.endsWith('.webm')) {
      return { mimeType: 'video/webm', realContainer: 'matroska' };
    }
    return { mimeType: 'video/mp4', realContainer: 'matroska' };
  }

  // ISO-BMFF (MP4/MOV/M4V/3GP/HEIC...): 'ftyp' box at offset 4
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4).trim().toLowerCase();
    const isQuickTime = brand === 'qt';
    return { mimeType: isQuickTime ? 'video/quicktime' : 'video/mp4', realContainer: 'isobmff' };
  }

  // AVI: 'RIFF'....'AVI '
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AVI ') {
    // Browsers don't have a native AVI demuxer at all — flag it so the
    // caller can surface a clear error instead of a confusing generic one.
    return { mimeType: 'video/x-msvideo', realContainer: 'avi', unsupportedContainer: true };
  }

  // Fall back to whatever the OS/browser guessed, or the extension, only
  // if we couldn't identify real magic bytes (e.g. an unusual/rare format).
  if (file.type) return { mimeType: file.type, realContainer: 'unknown' };
  const name = file.name.toLowerCase();
  if (name.endsWith('.webm')) return { mimeType: 'video/webm', realContainer: 'unknown' };
  if (name.endsWith('.mov')) return { mimeType: 'video/quicktime', realContainer: 'unknown' };
  return { mimeType: 'video/mp4', realContainer: 'unknown' };
}

// ── Lightweight MP4 box walker ──────────────────────────────────────
// We only ever read box *headers* (a handful of bytes each), never box
// bodies/media data, so this is fast even on a multi-GB file and even
// when `moov` sits at the very end (non-"faststart" muxing) — we just
// skip over `mdat` by its declared size without touching its bytes.
async function readBoxHeader(file, offset) {
  if (offset + 8 > file.size) return null;
  const head = new Uint8Array(await file.slice(offset, Math.min(offset + 16, file.size)).arrayBuffer());
  if (head.length < 8) return null;
  const dv = new DataView(head.buffer);
  let size = dv.getUint32(0);
  const type = String.fromCharCode(head[4], head[5], head[6], head[7]);
  let headerSize = 8;
  if (size === 1 && head.length >= 16) {
    size = dv.getUint32(8) * 2 ** 32 + dv.getUint32(12);
    headerSize = 16;
  } else if (size === 0) {
    size = file.size - offset; // box extends to end of file
  }
  if (size < headerSize) return null;
  return { type, size, headerSize, bodyOffset: offset + headerSize, end: offset + size };
}

// Depth-first search for a nested box path, e.g. ['moov', 'trak'] returns
// the first trak box under moov. Only descends into plain "container"
// boxes (moov/trak/mdia/minf/stbl) — never into mdat or unknown boxes.
async function findBox(file, path, offset, limit) {
  let cursor = offset;
  while (cursor < limit) {
    const box = await readBoxHeader(file, cursor);
    if (!box || box.size <= 0) break;
    if (box.type === path[0]) {
      if (path.length === 1) return box;
      const child = await findBox(file, path.slice(1), box.bodyOffset, box.end);
      if (child) return child;
    }
    cursor = box.end;
  }
  return null;
}

async function readBytes(file, offset, length) {
  return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
}

function toHex(n, digits) {
  return n.toString(16).padStart(digits, '0');
}

// Builds the `codecs=` parameter browsers need to accurately answer
// `MediaSource.isTypeSupported()` — a bare "hvc1" or "avc1" isn't
// specific enough; they need the actual profile/level from the file.
async function describeVideoCodec(file, sampleEntry) {
  const { type, bodyOffset, end } = sampleEntry;

  if (type === 'avc1' || type === 'avc3') {
    // VisualSampleEntry fixed header is 78 bytes, then nested boxes (avcC) follow.
    const avcC = await findBox(file, ['avcC'], bodyOffset + 78, end);
    if (avcC) {
      const b = await readBytes(file, avcC.bodyOffset, 4);
      // b[0]=configVersion, b[1]=profile_idc, b[2]=profile_compatibility, b[3]=level_idc
      return { name: 'H.264', codecString: `${type}.${toHex(b[1], 2)}${toHex(b[2], 2)}${toHex(b[3], 2)}` };
    }
    return { name: 'H.264', codecString: null };
  }

  if (type === 'hev1' || type === 'hvc1') {
    const hvcC = await findBox(file, ['hvcC'], bodyOffset + 78, end);
    if (hvcC) {
      try {
        const b = await readBytes(file, hvcC.bodyOffset, 13);
        const generalProfileSpace = (b[1] >> 6) & 0x03;
        const generalTierFlag = (b[1] >> 5) & 0x01;
        const generalProfileIdc = b[1] & 0x1f;
        const compatFlags = (b[2] << 24) | (b[3] << 16) | (b[4] << 8) | b[5];
        const constraintBytes = b.slice(6, 12);
        const generalLevelIdc = b[12];

        const spaceLetter = ['', 'A', 'B', 'C'][generalProfileSpace] || '';
        // Compatibility flags are printed as a plain hex number (reversed-bit
        // convention some encoders use is a known rabbit hole — this covers
        // the overwhelming majority of real-world files correctly).
        const compatHex = (compatFlags >>> 0).toString(16);
        const tier = generalTierFlag ? 'H' : 'L';
        let constraintHex = Array.from(constraintBytes).map(x => toHex(x, 2)).join('.');
        // Trim trailing ".00" groups, but always keep at least one.
        const parts = constraintHex.split('.');
        while (parts.length > 1 && parts[parts.length - 1] === '00') parts.pop();
        constraintHex = parts.join('.');

        const codecString = `${type}.${spaceLetter}${generalProfileIdc}.${compatHex}.${tier}${generalLevelIdc}.${constraintHex}`;
        return { name: 'HEVC (H.265)', codecString };
      } catch {
        // Fall through to a representative guess below.
      }
    }
    // Couldn't read hvcC precisely — HEVC Main10 is by far the most common
    // profile in the wild for x265 rips, so use it as a best-effort proxy
    // for the support check rather than skip the check altogether.
    return { name: 'HEVC (H.265)', codecString: `${type}.2.4.L153.B0` };
  }

  if (type === 'av01') {
    return { name: 'AV1', codecString: 'av01.0.04M.08' };
  }
  if (type === 'vp09') {
    return { name: 'VP9', codecString: 'vp09.00.10.08' };
  }
  if (type === 'mp4v') {
    return { name: 'MPEG-4 Part 2', codecString: null };
  }
  return { name: type || 'unknown', codecString: null };
}

// Finds the first video track's sample description and identifies its
// codec. Returns null if this isn't an ISO-BMFF file or has no video track
// we can find (in which case we just skip the pre-check rather than block
// playback on an inconclusive read).
async function detectVideoCodec(file) {
  try {
    const moov = await findBox(file, ['moov'], 0, file.size);
    if (!moov) return null;

    let cursor = moov.bodyOffset;
    while (cursor < moov.end) {
      const trak = await readBoxHeader(file, cursor);
      if (!trak || trak.size <= 0) break;
      if (trak.type === 'trak') {
        const hdlr = await findBox(file, ['mdia', 'hdlr'], trak.bodyOffset, trak.end);
        if (hdlr) {
          const handlerType = String.fromCharCode(...(await readBytes(file, hdlr.bodyOffset + 8, 4)));
          if (handlerType === 'vide') {
            const stsd = await findBox(file, ['mdia', 'minf', 'stbl', 'stsd'], trak.bodyOffset, trak.end);
            if (stsd) {
              const entryHeader = await readBoxHeader(file, stsd.bodyOffset + 8);
              if (entryHeader) return await describeVideoCodec(file, entryHeader);
            }
          }
        }
      }
      cursor = trak.end;
    }
  } catch {
    // Any parsing hiccup (unusual/malformed file) — just skip the
    // pre-check silently rather than block a file that might play fine.
  }
  return null;
}

// Memoize the sniff per file so repeated meta requests (new peers joining,
// participants re-requesting meta, etc.) don't re-read the file header
// every time.
const containerInfoCache = new WeakMap();
function resolveContainerInfo(file) {
  if (!containerInfoCache.has(file)) {
    containerInfoCache.set(file, sniffContainer(file).then(async (info) => {
      if (info.realContainer === 'isobmff') {
        const codec = await detectVideoCodec(file);
        if (codec) {
          return {
            ...info,
            videoCodecName: codec.name,
            videoCodecString: codec.codecString
              ? `${info.mimeType}; codecs="${codec.codecString}"`
              : null
          };
        }
      }
      return info;
    }));
  }
  return containerInfoCache.get(file);
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
      async function sendMeta() {
        const { mimeType, realContainer, unsupportedContainer, videoCodecName, videoCodecString } =
          await resolveContainerInfo(fileRef.current);
        if (dc.readyState !== 'open') return;
        dc.send(JSON.stringify({
          type: 'file-stream-meta',
          name: fileRef.current.name,
          size: fileRef.current.size,
          mimeType,
          realContainer,
          unsupportedContainer: !!unsupportedContainer,
          videoCodecName,
          videoCodecString
        }));
      }

      if (dc.readyState === 'open') {
        sendMeta();
      } else {
        // If it opens later, send it then
        const originalOnOpen = dc.onopen;
        dc.onopen = (e) => {
          sendMeta();
          if (originalOnOpen) originalOnOpen(e);
        };
      }

      async function handleHostMessage(event) {
        if (typeof event.data !== 'string') return;
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type === 'request-meta') {
          const { mimeType, realContainer, unsupportedContainer, videoCodecName, videoCodecString } =
            await resolveContainerInfo(fileRef.current);
          if (dc.readyState !== 'open') return;
          dc.send(JSON.stringify({
            type: 'file-stream-meta',
            name: fileRef.current.name,
            size: fileRef.current.size,
            mimeType,
            realContainer,
            unsupportedContainer: !!unsupportedContainer,
            videoCodecName,
            videoCodecString
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

    // Registers (or re-registers) a stream with the Service Worker.
    // Reusable so a keepalive check that discovers the SW silently lost
    // its registration (idle-terminated by the browser, wiping its
    // in-memory state) can re-register with the *same* streamId — the
    // <video> element's src never has to change, so there's no visible
    // glitch, just a request that succeeds instead of surfacing a fake
    // "codec error" the next time playback tries to fetch.
    function registerStreamOnSW(streamId, meta, { isReRegistration = false } = {}) {
      const channel = new MessageChannel();
      serviceWorkerPortRef.current = channel.port1;

      let ackTimeoutId = null;
      let registerAttempts = 0;

      channel.port1.onmessage = (swEvent) => {
        if (swEvent.data.type === 'REGISTER_ACK') {
          if (ackTimeoutId) clearTimeout(ackTimeoutId);
          if (!isReRegistration) {
            setStreamUrl(`/stream-media/${streamId}`);
            setStreamReady(true);
            // Set progress to 100% since we can play immediately and don't need the progress bar anymore
            setStreamProgress(100);
          }
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

      // Registration can silently go nowhere if the Service Worker
      // isn't controlling this page yet (a common race right after
      // it's first installed/updated — the fix is normally just one
      // reload, but we shouldn't leave the person staring at a frozen
      // 0% with zero explanation). Wait for a controller, retry once,
      // then time out with a real error instead of hanging forever.
      async function attemptRegister() {
        registerAttempts += 1;
        let controller = navigator.serviceWorker.controller;
        if (!controller) {
          // Give an in-flight activation up to 3s to finish.
          controller = await Promise.race([
            new Promise((resolve) => {
              navigator.serviceWorker.addEventListener(
                'controllerchange',
                () => resolve(navigator.serviceWorker.controller),
                { once: true }
              );
            }),
            new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
          ]);
        }
        if (!controller) {
          if (registerAttempts === 1) {
            // Try registering the SW ourselves in case it never got
            // registered in this tab at all, then retry once.
            try {
              await navigator.serviceWorker.register('/sw.js');
            } catch {
              /* ignore — we'll surface the real error below if this doesn't help */
            }
            return attemptRegister();
          }
          if (!isReRegistration) {
            setStreamError(
              "Couldn't start streaming from the host (the connection needed for it never came up). Please refresh the page and try again, or use \"Load my own copy\" instead."
            );
          }
          return;
        }

        controller.postMessage({
          type: 'REGISTER_STREAM',
          streamId,
          meta,
        }, [channel.port2]);

        if (!isReRegistration) {
          ackTimeoutId = setTimeout(() => {
            setStreamError(
              "Streaming from the host timed out. Please refresh the page and try again, or use \"Load my own copy\" instead."
            );
          }, 8000);
        }
      }

      attemptRegister();
    }

    function handleParticipantMessage(event) {
      if (typeof event.data === 'string') {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }

        if (msg.type === 'file-stream-meta') {
          if (msg.unsupportedContainer) {
            setStreamError(
              `The host's file is an ${(msg.realContainer || 'unsupported').toUpperCase()} container, which browsers can't play directly. Ask the host to convert it to .mp4 first.`
            );
            return;
          }

          // If we know the video codec, check THIS device's actual decode
          // support before doing anything else. Some phones/tablets accept
          // the file (container demuxes fine) but have no hardware decoder
          // for the codec inside — that's what shows up as a black frame
          // with audio playing, not an obvious error. Catching it here
          // means a clear message instead of a silent black screen.
          if (msg.videoCodecString) {
            const canPlay =
              (window.MediaSource && MediaSource.isTypeSupported(msg.videoCodecString)) ||
              document.createElement('video').canPlayType(msg.videoCodecString) !== '';
            if (!canPlay) {
              setStreamError(
                `Your device can't decode this video (${msg.videoCodecName || 'unknown codec'}). ` +
                `This is a hardware/browser limitation on this device, not a broken file — try a ` +
                `different device or browser, or ask the host to re-encode the video to a more widely ` +
                `supported profile (e.g. H.264 Main/High, 8-bit).`
              );
              return;
            }
          }

          if (!navigator.serviceWorker) {
            setStreamError("Your browser doesn't support the streaming feature needed here. Try a different browser, or use \"Load my own copy\" instead.");
            return;
          }

          const streamId = Math.random().toString(36).substring(2);
          streamInfoRef.current = { id: streamId, meta: msg };
          registerStreamOnSW(streamId, msg);

        
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

    // ── Keep the Service Worker's registration alive during long pauses ──
    // Chrome (and other browsers) terminate an idle Service Worker after
    // ~30s of no fetch/message activity to free memory. A paused video
    // generates neither, so after a few minutes of pause the SW gets
    // killed and its in-memory stream registry (which can't be persisted —
    // it holds a live MessagePort) is wiped. The next fetch on resume then
    // 404s, which the <video> element reports as a generic decode/codec
    // error. Pinging periodically mostly prevents the SW from ever going
    // idle long enough to die; if it still gets killed anyway (e.g. the
    // browser reclaims it for other reasons), the ack tells us our
    // registration is gone and we silently re-register with the *same*
    // streamId — no src change, no visible glitch, no need to refresh.
    const keepaliveInterval = setInterval(() => {
      if (!streamInfoRef.current.id || !navigator.serviceWorker?.controller) return;
      const { id: streamId, meta } = streamInfoRef.current;

      try {
        const pingChannel = new MessageChannel();
        const ackPromise = new Promise((resolve) => {
          pingChannel.port1.onmessage = (e) => resolve(e.data);
        });
        navigator.serviceWorker.controller.postMessage(
          { type: 'KEEPALIVE', streamId },
          [pingChannel.port2]
        );
        Promise.race([
          ackPromise,
          new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
        ]).then((ack) => {
          if (!ack || !ack.stillRegistered) {
            registerStreamOnSW(streamId, meta, { isReRegistration: true });
          }
        });
      } catch {
        /* best-effort — a failed ping just means we try again next tick */
      }
    }, 20000);

    return () => {
      participantAttachedRef.current = false;
      dc.removeEventListener('message', handleParticipantMessage);
      clearInterval(keepaliveInterval);
    };
  }, [isHost, hostId, dataChannels]);

  return { streamUrl, streamReady, streamError, streamProgress, hostSendProgress };
}
