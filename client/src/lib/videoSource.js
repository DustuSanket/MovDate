const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'music.youtube.com',
]);

const DIRECT_FILE_EXTENSIONS = ['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.m3u8', '.mkv', '.m4v', '.avi'];

// Containers a <video> tag can be POINTED at, but that browsers don't
// reliably decode — Matroska/AVI playback success depends on which codec is
// packed inside that specific file, which we have no way to check from a URL.
// We still let these through (rejecting outright would block legitimate
// .mkv files that DO happen to use a supported codec) but flag the risk.
const SHAKY_EXTENSIONS = ['.mkv', '.avi'];

// Hosts that serve a playable page at /v/ID (or similar) and a bare,
// frameable player at /e/ID/. We can't control play/pause on these the way
// we do YouTube (no postMessage API), but we CAN still show them and let the
// person who pasted the link hit play locally — same tradeoff as any
// "paste an iframe embed" video source.
const EMBED_HOST_PATTERNS = [
  {
    hosts: ['tpead.net', 'www.tpead.net'],
    // /v/ID or /e/ID/  ->  /e/ID/
    toEmbedUrl(url) {
      const parts = url.pathname.split('/').filter(Boolean); // ['v'|'e', ID, ...]
      if (parts.length < 2) return null;
      const id = parts[1];
      if (!id) return null;
      return `https://tpead.net/e/${id}/`;
    },
  },
];

// If the user pasted a whole <iframe> tag instead of a bare link, pull the
// src attribute out of it and continue parsing from there.
function extractIframeSrc(raw) {
  const match = raw.match(/<iframe[^>]*\ssrc=["']([^"']+)["']/i);
  return match ? match[1] : null;
}

export function parseVideoSource(rawInput) {
  const trimmedInput = rawInput.trim();
  const iframeSrc = extractIframeSrc(trimmedInput);
  const rawUrl = iframeSrc || trimmedInput;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { type: 'invalid', error: "That doesn't look like a valid link." };
  }

  for (const pattern of EMBED_HOST_PATTERNS) {
    if (pattern.hosts.includes(url.hostname)) {
      const embedUrl = pattern.toEmbedUrl(url);
      if (!embedUrl) {
        return { type: 'invalid', error: "Could not find a video in that link." };
      }
      return {
        type: 'embed',
        url: embedUrl,
        warning:
          "This is an embedded player, so play/pause/seek can't be synced automatically — everyone will need to hit play on their own end.",
      };
    }
  }

  if (YOUTUBE_HOSTS.has(url.hostname)) {
    const id = extractYouTubeId(url);
    if (!id) {
      return { type: 'invalid', error: 'Could not find a video in that YouTube link.' };
    }
    return { type: 'youtube', url: rawUrl.trim(), id };
  }

  const lowerPath = url.pathname.toLowerCase();
  const matchedExt = DIRECT_FILE_EXTENSIONS.find((ext) => lowerPath.endsWith(ext));
  if (matchedExt) {
    const result = { type: 'file', url: rawUrl.trim() };
    if (SHAKY_EXTENSIONS.includes(matchedExt)) {
      result.warning =
        "MKV/AVI files only play if your browser supports the codec packed inside — it varies file to file. If it doesn't load, an MP4 link is the safe bet.";
    }
    return result;
  }

  return {
    type: 'unsupported',
    error:
      "This looks like a streaming site page rather than a playable video. Subscription sites (Netflix, Disney+, Prime Video, etc.) block outside players by design, so MovDate works with YouTube links, direct video file links (.mp4/.webm/.mkv/.m3u8), or a supported embed link/iframe.",
  };
}

function extractYouTubeId(url) {
  if (url.hostname === 'youtu.be') {
    return url.pathname.slice(1).split('/')[0] || null;
  }
  if (url.pathname.startsWith('/shorts/')) {
    return url.pathname.split('/')[2] || null;
  }
  if (url.pathname.startsWith('/embed/')) {
    return url.pathname.split('/')[2] || null;
  }
  return url.searchParams.get('v');
}
