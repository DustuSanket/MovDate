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

    event.respondWith(handleStreamRequest(event.request, streamInfo));
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

async function handleStreamRequest(request, streamInfo) {
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

  let streamReqId;
  const stream = new ReadableStream({
    start(controller) {
      const channel = new MessageChannel();
      streamReqId = Math.random().toString(36).substring(2);
      
      channel.port1.onmessage = (event) => {
        if (event.data.type === 'chunk') {
          controller.enqueue(new Uint8Array(event.data.data));
        } else if (event.data.type === 'end') {
          controller.close();
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
      // Use streamInfo.port to send cancel to main thread
      streamInfo.port.postMessage({
        type: 'cancel-range',
        reqId: streamReqId
      });
    }
  });

  const headers = new Headers({
    'Content-Type': streamInfo.meta.mimeType || streamInfo.meta.type || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize.toString(),
  });

  if (rangeHeader) {
    headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);
    return new Response(stream, { status: 206, headers });
  } else {
    return new Response(stream, { status: 200, headers });
  }
}
