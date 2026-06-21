import { useState } from 'react';
import { parseVideoSource } from '../lib/videoSource.js';

function formatTime(rawSeconds = 0) {
  const seconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export default function PlayerControls({
  isHost,
  isPlaying,
  currentTime,
  duration,
  onTogglePlay,
  onSeek,
  onSkip,
  onLoadVideo,
  onLoadLocalFile,
  onRequestPause,
  hasVideo,
  onVolumeChange,
}) {
  const [linkInput, setLinkInput] = useState('');
  const [linkError, setLinkError] = useState(null);
  const [linkWarning, setLinkWarning] = useState(null);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [volume, setVolume] = useState(100);
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

  function handleScrub(event) {
    if (!isHost || !duration) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    onSeek(Math.max(0, Math.min(1, fraction)) * duration);
  }

  function handleRequestPause() {
    if (pauseRequested) return;
    setPauseRequested(true);
    onRequestPause?.();
    setTimeout(() => setPauseRequested(false), 8000);
  }

  function handleVolumeChange(event) {
    const val = Number(event.target.value);
    setVolume(val);
    onVolumeChange?.(val);
  }

  const progressPct = duration ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div className="player-controls">
      {isHost && (
        <div className="load-video-area">
          <form className="load-video-form" onSubmit={handleLoadSubmit}>
            <input
              type="text"
              value={linkInput}
              onChange={(event) => setLinkInput(event.target.value)}
              placeholder="Paste a YouTube or direct video (.mp4) link"
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
      )}

      {linkError && <p className="form-error">{linkError}</p>}
      {linkWarning && <p className="form-warning">{linkWarning}</p>}

      {hasVideo && (
        <>
          {/* Participant pause-request — full-width row above the scrub bar */}
          {!isHost && isPlaying && (
            <div className="participant-request-row">
              <button
                type="button"
                className={`participant-request-btn${pauseRequested ? ' participant-request-btn--sent' : ''}`}
                onClick={handleRequestPause}
                disabled={pauseRequested}
              >
                {pauseRequested ? '⏸ Pause requested…' : '⏸ Request pause'}
              </button>
            </div>
          )}

          <div className="playback-bar">
            {/* Host play/pause + 10s skip */}
            {isHost && (
              <>
                <button
                  type="button"
                  className="skip-btn"
                  onClick={() => onSkip?.(-10)}
                  aria-label="Back 10 seconds"
                  title="Back 10 seconds (←)"
                >
                  ⟲10
                </button>

                <button
                  type="button"
                  className="play-pause-btn"
                  onClick={onTogglePlay}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? '❙❙' : '▶'}
                </button>

                <button
                  type="button"
                  className="skip-btn"
                  onClick={() => onSkip?.(10)}
                  aria-label="Forward 10 seconds"
                  title="Forward 10 seconds (→)"
                >
                  10⟳
                </button>
              </>
            )}

            {/* Participant: paused state indicator in place of button */}
            {!isHost && !isPlaying && (
              <span className="play-pause-placeholder">❙❙</span>
            )}

            <span className="time-label">{formatTime(currentTime)}</span>

            <div
              className={`scrub-track ${isHost ? 'scrub-track--active' : ''}`}
              onClick={handleScrub}
              role="slider"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progressPct)}
              aria-label="Seek"
              tabIndex={isHost ? 0 : -1}
            >
              <div className="scrub-fill" style={{ width: `${progressPct}%` }} />
            </div>

            <span className="time-label">{formatTime(duration)}</span>

            <div className="volume-control" title="Video volume">
              <span className="volume-icon">{volume === 0 ? '🔇' : volume < 50 ? '🔉' : '🔊'}</span>
              <input
                type="range"
                className="volume-slider"
                min="0"
                max="100"
                value={volume}
                onChange={handleVolumeChange}
                aria-label="Volume"
              />
            </div>

            {!isHost && <span className="host-only-tag">Host controls playback</span>}
          </div>
        </>
      )}
    </div>
  );
}
