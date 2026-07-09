import { useEffect, useRef, useState } from 'react';

function formatTime(rawSeconds = 0) {
  const seconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const QUALITY_LABELS = {
  highres: 'Highest',
  hd2160: '2160p (4K)',
  hd1440: '1440p',
  hd1080: '1080p',
  hd720: '720p',
  large: '480p',
  medium: '360p',
  small: '240p',
  tiny: '144p',
  auto: 'Auto',
};

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
  source,
  playerRef,
}) {
  const [pauseRequested, setPauseRequested] = useState(false);
  const [volume, setVolume] = useState(100);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [qualities, setQualities] = useState([]);
  const [currentQuality, setCurrentQuality] = useState(null);
  const [captionTracks, setCaptionTracks] = useState([]);
  const [currentCaptionTrack, setCurrentCaptionTrack] = useState(null);
  const [audioTracks, setAudioTracks] = useState([]);
  const [currentAudioTrack, setCurrentAudioTrack] = useState(null);
  const [subtitleAvailable, setSubtitleAvailable] = useState(false);
  const [subtitleShowing, setSubtitleShowing] = useState(false);
  const settingsMenuRef = useRef(null);

  const isYouTube = source?.type === 'youtube';
  const isFile = source?.type === 'file';

  // Refresh the available qualities/captions each time the menu opens —
  // YouTube only knows these once the video has actually started buffering.
  useEffect(() => {
    if (!settingsOpen || !playerRef?.current) return;
    if (isYouTube) {
      setQualities(playerRef.current.getAvailableQualities?.() ?? []);
      setCurrentQuality(playerRef.current.getCurrentQuality?.() ?? null);
      setCaptionTracks(playerRef.current.getCaptionTracks?.() ?? []);
      setCurrentCaptionTrack(playerRef.current.getCurrentCaptionTrack?.() ?? null);
    } else if (isFile) {
      const tracks = playerRef.current.getAudioTracks?.() ?? [];
      setAudioTracks(tracks);
      setCurrentAudioTrack(tracks.find((t) => t.enabled)?.id ?? null);
      setSubtitleAvailable(playerRef.current.getSubtitleAvailable?.() ?? false);
      setSubtitleShowing(playerRef.current.isSubtitleShowing?.() ?? false);
    }
  }, [settingsOpen, isYouTube, isFile, playerRef]);

  // Close the menu on outside click.
  useEffect(() => {
    if (!settingsOpen) return undefined;
    function handleClickOutside(event) {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(event.target)) {
        setSettingsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [settingsOpen]);

  function handleSelectQuality(level) {
    playerRef?.current?.setQuality?.(level);
    setCurrentQuality(level);
  }

  function handleSelectCaptionTrack(track) {
    playerRef?.current?.setCaptionTrack?.(track);
    setCurrentCaptionTrack(track && track.languageCode ? track : null);
  }

  function handleSelectAudioTrack(trackId) {
    playerRef?.current?.setAudioTrack?.(trackId);
    setCurrentAudioTrack(trackId);
  }

  function handleToggleSubtitle(show) {
    playerRef?.current?.setSubtitleShowing?.(show);
    setSubtitleShowing(show);
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

        {((isHost && isYouTube) || (isFile && (audioTracks.length > 0 || subtitleAvailable))) && (
          <div className="playback-settings" ref={settingsMenuRef}>
            <button
              type="button"
              className="settings-btn"
              onClick={() => setSettingsOpen((v) => !v)}
              aria-label="Video settings"
              aria-expanded={settingsOpen}
              title={isYouTube ? 'Quality & captions' : 'Audio track & subtitles'}
            >
              ⚙
            </button>

            {settingsOpen && isYouTube && (
              <div className="settings-menu">
                <div className="settings-menu-section">
                  <div className="settings-menu-title">Quality</div>
                  <button
                    type="button"
                    className={`settings-menu-item${!currentQuality || currentQuality === 'auto' ? ' is-active' : ''}`}
                    onClick={() => handleSelectQuality('default')}
                  >
                    Auto
                  </button>
                  {qualities.length === 0 && (
                    <div className="settings-menu-empty">Loading…</div>
                  )}
                  {qualities.map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={`settings-menu-item${currentQuality === level ? ' is-active' : ''}`}
                      onClick={() => handleSelectQuality(level)}
                    >
                      {QUALITY_LABELS[level] || level}
                    </button>
                  ))}
                </div>

                <div className="settings-menu-section">
                  <div className="settings-menu-title">Captions</div>
                  <button
                    type="button"
                    className={`settings-menu-item${!currentCaptionTrack ? ' is-active' : ''}`}
                    onClick={() => handleSelectCaptionTrack(null)}
                  >
                    Off
                  </button>
                  {captionTracks.length === 0 && (
                    <div className="settings-menu-empty">No captions available</div>
                  )}
                  {captionTracks.map((track) => (
                    <button
                      key={track.languageCode}
                      type="button"
                      className={`settings-menu-item${
                        currentCaptionTrack?.languageCode === track.languageCode ? ' is-active' : ''
                      }`}
                      onClick={() => handleSelectCaptionTrack(track)}
                    >
                      {track.displayName || track.languageName || track.languageCode}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {settingsOpen && isFile && (
              <div className="settings-menu">
                {audioTracks.length > 0 && (
                  <div className="settings-menu-section">
                    <div className="settings-menu-title">Audio track</div>
                    {audioTracks.map((track) => (
                      <button
                        key={track.id}
                        type="button"
                        className={`settings-menu-item${currentAudioTrack === track.id ? ' is-active' : ''}`}
                        onClick={() => handleSelectAudioTrack(track.id)}
                      >
                        {track.label}
                      </button>
                    ))}
                  </div>
                )}

                {subtitleAvailable && (
                  <div className="settings-menu-section">
                    <div className="settings-menu-title">Subtitles</div>
                    <button
                      type="button"
                      className={`settings-menu-item${!subtitleShowing ? ' is-active' : ''}`}
                      onClick={() => handleToggleSubtitle(false)}
                    >
                      Off
                    </button>
                    <button
                      type="button"
                      className={`settings-menu-item${subtitleShowing ? ' is-active' : ''}`}
                      onClick={() => handleToggleSubtitle(true)}
                    >
                      On
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {!isHost && <span className="host-only-tag">Host controls playback</span>}
      </div>
    </div>
  );
}
