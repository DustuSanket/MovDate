import { useState } from 'react';

function formatTime(rawSeconds = 0) {
  const seconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export default function PlaybackControls({
  isHost,
  isPlaying,
  currentTime,
  duration,
  onTogglePlay,
  onSeek,
  onSkip,
  onRequestPause,
  hasVideo,
  onVolumeChange,
}) {
  const [pauseRequested, setPauseRequested] = useState(false);
  const [volume, setVolume] = useState(100);

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

  if (!hasVideo) return null;

  return (
    <div className="playback-controls">
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
    </div>
  );
}
