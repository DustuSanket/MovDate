import { useEffect, useRef, useState } from 'react';

export default function MeetTile({ 
  name, isYou, isHost, stream, muted, cameraOff, speakerId, isScreen, isPinned, onTogglePin 
}) {
  const videoRef = useRef(null);
  const showVideo = Boolean(stream) && !cameraOff;
  const [isPortrait, setIsPortrait] = useState(false);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream || null;
  }, [stream, showVideo]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || isYou || !speakerId || typeof el.setSinkId !== 'function') return;
    el.setSinkId(speakerId).catch(() => {});
  }, [speakerId, isYou, stream, showVideo]);

  const [volume, setVolume] = useState(100);

  useEffect(() => {
    if (videoRef.current && !isYou) {
      videoRef.current.volume = Math.max(0, Math.min(100, volume)) / 100;
    }
  }, [volume, showVideo, isYou]);

  function handleVolumeChange(event) {
    event.stopPropagation();
    setVolume(Number(event.target.value));
  }

  function handleDoubleClick() {
    if (!videoRef.current) return;
    if (!document.fullscreenElement) {
      videoRef.current.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  function handleLoadedMetadata() {
    if (videoRef.current) {
      setIsPortrait(videoRef.current.videoHeight > videoRef.current.videoWidth);
    }
  }

  return (
    <div 
      className={`meet-tile ${isPinned ? 'is-pinned' : ''} ${isScreen ? 'is-screen' : ''} ${isPortrait ? 'is-portrait' : ''}`}
      onDoubleClick={handleDoubleClick}
    >
      {showVideo ? (
        <video 
          ref={videoRef} 
          autoPlay 
          playsInline 
          muted={isYou} 
          className={isScreen ? 'video-contain' : 'video-cover'}
          onLoadedMetadata={handleLoadedMetadata}
        />
      ) : (
        <div className="participant-avatar" aria-hidden="true">
          {name?.[0]?.toUpperCase() || '?'}
        </div>
      )}
      
      <div className="participant-meta">
        <span className="participant-name">
          {name}
        </span>
        <div className="participant-icons">
          {isHost && !isScreen && <span className="badge badge--host">Host</span>}
          {muted && !isScreen && <span className="badge" title="Muted">🔇</span>}
        </div>
      </div>
      
      <div className="meet-tile-controls">
        <button 
          className="pin-btn" 
          onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
          title={isPinned ? "Unpin" : "Pin to screen"}
        >
          {isPinned ? '📌' : '📍'}
        </button>
      </div>

      {!isYou && (
        <div className="participant-volume-control" title="Adjust volume">
          <input
            type="range"
            className="participant-volume-slider"
            min="0"
            max="100"
            value={volume}
            onChange={handleVolumeChange}
            aria-label={`Volume for ${name}`}
          />
        </div>
      )}
    </div>
  );
}
