import { useEffect, useRef, useState } from 'react';

export default function ParticipantTile({ name, isYou, isHost, stream, muted, cameraOff, speakerId }) {
  const videoRef = useRef(null);

  const showVideo = Boolean(stream) && !cameraOff;

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream || null;
  }, [stream, showVideo]);

  // Output device only matters for remote audio — our own tile is muted
  // locally anyway — but applying it unconditionally is harmless and keeps
  // this simple. setSinkId isn't supported everywhere (no Firefox/Safari as
  // of this writing), so this silently no-ops there. Re-applies whenever the
  // <video> element itself remounts (e.g. camera toggled back on), since a
  // fresh element starts back on the system default output.
  useEffect(() => {
    const el = videoRef.current;
    if (!el || isYou || !speakerId || typeof el.setSinkId !== 'function') return;
    el.setSinkId(speakerId).catch(() => {
      // Selected output device may have been unplugged; ignore — the
      // element just keeps using whatever it was already using.
    });
  }, [speakerId, isYou, stream, showVideo]);

  const [volume, setVolume] = useState(100);

  useEffect(() => {
    if (videoRef.current && !isYou) {
      videoRef.current.volume = Math.max(0, Math.min(100, volume)) / 100;
    }
  }, [volume, showVideo, isYou]);

  function handleVolumeChange(event) {
    setVolume(Number(event.target.value));
  }

  return (
    <div className="participant-tile">
      {showVideo ? (
        <video ref={videoRef} autoPlay playsInline muted={isYou} />
      ) : (
        <div className="participant-avatar" aria-hidden="true">
          {name?.[0]?.toUpperCase() || '?'}
        </div>
      )}
      <div className="participant-meta">
        <span className="participant-name">
          {name}
          {isYou ? ' (you)' : ''}
        </span>
        <div className="participant-icons">
          {isHost && <span className="badge badge--host">Host</span>}
          {muted && <span className="badge" title="Muted">🔇</span>}
        </div>
      </div>
      {!isYou && (
        <div className="participant-volume-control" title="Adjust participant volume">
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
