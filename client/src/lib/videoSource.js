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

export function parseVideoSource(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return { type: 'invalid', error: "That doesn't look like a valid link." };
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
      "This looks like a streaming site page rather than a playable video. Subscription sites (Netflix, Disney+, Prime Video, etc.) block outside players by design, so MovDate works with YouTube links or direct video file links (.mp4/.webm/.mkv/.m3u8).",
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
