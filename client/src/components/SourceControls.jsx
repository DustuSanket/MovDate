import { useState } from 'react';
import { parseVideoSource } from '../lib/videoSource.js';

export default function SourceControls({
  isHost,
  hasVideo,
  onLoadVideo,
  onLoadLocalFile,
}) {
  const [linkInput, setLinkInput] = useState('');
  const [linkError, setLinkError] = useState(null);
  const [linkWarning, setLinkWarning] = useState(null);

  const fileInputRef = useState(() => {
    if (typeof document === 'undefined') return null;
    const el = document.createElement('input');
    el.type = 'file';
    el.accept = 'video/*,.mp4,.webm,.mkv,.mov,.avi,.m4v';
    return el;
  })[0];

  function handleLocalFileClick() {
    if (!fileInputRef) return;
    fileInputRef.onchange = (e) => onLoadLocalFile?.(e);
    fileInputRef.click();
  }

  function handleLoadSubmit(event) {
    event.preventDefault();
    if (!linkInput.trim()) return;

    const parsed = parseVideoSource(linkInput.trim());
    if (parsed.type === 'invalid' || parsed.type === 'unsupported') {
      setLinkError(parsed.error);
      setLinkWarning(null);
      return;
    }

    setLinkError(null);
    setLinkWarning(parsed.warning || null);
    onLoadVideo(parsed);
    setLinkInput('');
  }

  if (!isHost) return null;

  return (
    <div className="source-controls">
      <div className="load-video-area">
        <form className="load-video-form" onSubmit={handleLoadSubmit}>
          <input
            type="text"
            value={linkInput}
            onChange={(event) => setLinkInput(event.target.value)}
            placeholder="Paste a YouTube, direct video (.mp4), or embed link/iframe"
            aria-label="Video link"
          />
          <button type="submit">{hasVideo ? 'Switch video' : 'Load video'}</button>
        </form>
        <button
          type="button"
          className="local-file-btn"
          onClick={handleLocalFileClick}
          title="Play a video file from your device (plays at up to 720p for smooth performance)"
        >
          📁 Play local file
        </button>
      </div>

      {linkError && <p className="form-error">{linkError}</p>}
      {linkWarning && <p className="form-warning">{linkWarning}</p>}
    </div>
  );
}
