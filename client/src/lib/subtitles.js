// Converts SRT subtitle text to WebVTT, which is the only format the
// HTML <track> element actually understands. If the text already looks
// like VTT, it's passed through untouched.
export function srtToVtt(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (normalized.startsWith('WEBVTT')) return normalized;

  const body = normalized
    // SRT uses a comma for milliseconds ("00:00:01,000"); VTT requires a dot.
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    // Drop the numeric cue-index lines SRT puts before each timestamp —
    // VTT doesn't need them and leaving them in can confuse some parsers.
    .split('\n')
    .filter((line, i, lines) => {
      const isIndexLine = /^\d+$/.test(line.trim());
      const nextIsTimestamp = /-->/.test(lines[i + 1] || '');
      return !(isIndexLine && nextIsTimestamp);
    })
    .join('\n');

  return `WEBVTT\n\n${body}\n`;
}

export function isSubtitleFile(file) {
  const name = file.name.toLowerCase();
  return name.endsWith('.srt') || name.endsWith('.vtt');
}

export async function readSubtitleFileAsVtt(file) {
  const text = await file.text();
  return file.name.toLowerCase().endsWith('.srt') ? srtToVtt(text) : text;
}
