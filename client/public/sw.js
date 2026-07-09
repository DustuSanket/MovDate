self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

const activeStreams = new Map();

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'REGISTER_STREAM') {
    const { streamId, meta } = event.data;
    activeStreams.set(streamId, {
      port: event.ports[0],
      meta
    });
    // Acknowledge registration so the client knows it's safe to load the URL
    event.ports[0].postMessage({ type: 'REGISTER_ACK' });
  } else if (event.data && event.data.type === 'KEEPALIVE') {
    // Just receiving any message resets Chrome's "kill this idle SW"
    // timer, but we also reply so the client can tell the difference
    // between "still alive" and "got silently restarted, activeStreams
    // is now empty" — a restarted SW responds fine to messages, it's
    // just lost all its registrations, which is the actual failure mode
    // that shows up as a fake "codec error" after a long pause.
    const stillRegistered = activeStreams.has(event.data.streamId);
    event.ports?.[0]?.postMessage({ type: 'KEEPALIVE_ACK', stillRegistered });
  }
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/stream-media/')) {
    const streamId = url.pathname.split('/')[2];
    const streamInfo = activeStreams.get(streamId);

    if (!streamInfo) {
      return event.respondWith(new Response('Stream not found or Service Worker was reloaded.', { status: 404 }));
    }

    event.respondWith(handleStreamRequest(event.request, streamInfo, streamId));
  }
});

// The maximum number of bytes we'll ever promise in a single response.
// Real static file servers never hand back "the rest of a multi-GB file"
// just because the client sent an open-ended Range header (`bytes=X-`);
// they cap it and let the client issue further range requests as needed.
// We have to do the same, since we're trickling the data over a WebRTC
// data channel — promising gigabytes in one Content-Length causes the
// <video> element to stall waiting on a response that will never arrive
// in time, which Chrome then reports as a generic "can't play this file"
// error (looks like a codec error, but it's really just a starved fetch).
const MAX_RANGE_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MB per response

// ── Read-ahead cache ──────────────────────────────────────────────────
// Once we've served a window of bytes, we proactively fetch the *next*
// window from the host in the background and stash it here. If the
// <video> element (or a resync-triggered seek) immediately asks for that
// range — which it usually does, since that's exactly how sequential
// playback and nearby seeks work — we can answer instantly from memory
// instead of making the browser wait through another full host round-trip.
const PREFETCH_BYTES = 6 * 1024 * 1024; // how far ahead to read
const CACHE_ENTRIES_PER_STREAM = 4;     // ~24MB ceiling per stream

const chunkCache = new Map();        // streamId -> Array<{start, end, data: Uint8Array}>
const pendingPrefetches = new Set(); // `${streamId}:${start}` currently in flight, to avoid duplicates

function cacheGet(streamId, start, end) {
  const entries = chunkCache.get(streamId);
  if (!entries) return null;
  for (const entry of entries) {
    if (entry.start <= start && entry.end >= end) {
      const offset = start - entry.start;
      const length = end - start + 1;
      return entry.data.subarray(offset, offset + length);
    }
  }
  return null;
}

function cachePut(streamId, start, end, data) {
  if (!chunkCache.has(streamId)) chunkCache.set(streamId, []);
  const entries = chunkCache.get(streamId);
  entries.push({ start, end, data });
  while (entries.length > CACHE_ENTRIES_PER_STREAM) entries.shift();
}

// Pulls a byte range from the host into a single concatenated buffer,
// using the same request-range/chunk-header/chunk protocol the live
// streaming path uses — just consumed into memory instead of teed to a
// Response's ReadableStream controller.
function fetchRangeIntoBuffer(streamInfo, start, end) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const reqId = Math.random().toString(36).substring(2);
    const parts = [];
    let total = 0;

    channel.port1.onmessage = (event) => {
      if (event.data.type === 'chunk') {
        parts.push(new Uint8Array(event.data.data));
        total += event.data.data.byteLength;
      } else if (event.data.type === 'end') {
        const combined = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
          combined.set(part, offset);
          offset += part.byteLength;
        }
        resolve(combined);
      } else if (event.data.type === 'error') {
        reject(new Error('Prefetch range failed'));
      }
    };

    streamInfo.port.postMessage({
      type: 'request-range',
      start,
      end,
      reqId,
      replyPort: channel.port2
    }, [channel.port2]);
  });
}

function schedulePrefetch(streamInfo, streamId, afterByte, totalSize) {
  const start = afterByte + 1;
  if (start >= totalSize) return; // already at end of file

  const end = Math.min(start + PREFETCH_BYTES - 1, totalSize - 1);

  // Skip if this window is already cached or already being fetched.
  if (cacheGet(streamId, start, end)) return;
  const key = `${streamId}:${start}`;
  if (pendingPrefetches.has(key)) return;

  pendingPrefetches.add(key);
  fetchRangeIntoBuffer(streamInfo, start, end)
    .then(data => cachePut(streamId, start, end, data))
    .catch(() => { /* best-effort — a failed prefetch just means no speed-up, not an error */ })
    .finally(() => pendingPrefetches.delete(key));
}

async function handleStreamRequest(request, streamInfo, streamId) {
  const rangeHeader = request.headers.get('Range');
  const totalSize = streamInfo.meta.size;

  let start = 0;
  let end = totalSize - 1;
  let openEnded = true;

  if (rangeHeader) {
    const parts = rangeHeader.replace(/bytes=/, '').split('-');
    start = parseInt(parts[0], 10);
    if (parts[1]) {
      end = parseInt(parts[1], 10);
      openEnded = false;
    } else {
      end = totalSize - 1;
    }
  }

  // Clamp: if the request was open-ended (or simply huge), only serve up
  // to MAX_RANGE_RESPONSE_BYTES from `start`. The browser will follow up
  // with another range request for the next chunk once it needs more —
  // exactly like it would against a normal HTTP server.
  if (openEnded || (end - start + 1) > MAX_RANGE_RESPONSE_BYTES) {
    end = Math.min(start + MAX_RANGE_RESPONSE_BYTES - 1, totalSize - 1);
  }

  if (start >= totalSize || end >= totalSize || start > end) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${totalSize}` }
    });
  }

  const chunkSize = end - start + 1;
  const headers = new Headers({
    'Content-Type': streamInfo.meta.mimeType || streamInfo.meta.type || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize.toString(),
  });
  if (rangeHeader) headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
  const status = rangeHeader ? 206 : 200;

  // ── Fast path: already have this window read-ahead in memory ──
  const cached = cacheGet(streamId, start, end);
  if (cached) {
    // We're already this far ahead — start reading further ahead too.
    schedulePrefetch(streamInfo, streamId, end, totalSize);
    return new Response(cached, { status, headers });
  }

  // ── Slow path: stream live from the host, tee into cache as we go ──
  let streamReqId;
  const collected = [];
  let collectedBytes = 0;

  const stream = new ReadableStream({
    start(controller) {
      const channel = new MessageChannel();
      streamReqId = Math.random().toString(36).substring(2);

      channel.port1.onmessage = (event) => {
        if (event.data.type === 'chunk') {
          const bytes = new Uint8Array(event.data.data);
          controller.enqueue(bytes);
          collected.push(bytes);
          collectedBytes += bytes.byteLength;
        } else if (event.data.type === 'end') {
          controller.close();
          // Cache what we just delivered, then read ahead for next time.
          const combined = new Uint8Array(collectedBytes);
          let offset = 0;
          for (const part of collected) { combined.set(part, offset); offset += part.byteLength; }
          cachePut(streamId, start, end, combined);
          schedulePrefetch(streamInfo, streamId, end, totalSize);
        } else if (event.data.type === 'error') {
          controller.error(new Error('Stream error'));
        }
      };

      streamInfo.port.postMessage({
        type: 'request-range',
        start,
        end,
        reqId: streamReqId,
        replyPort: channel.port2
      }, [channel.port2]);
    },
    cancel() {
      streamInfo.port.postMessage({
        type: 'cancel-range',
        reqId: streamReqId
      });
    }
  });

  return new Response(stream, { status, headers });
}
