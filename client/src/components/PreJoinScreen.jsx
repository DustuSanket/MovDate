import React, { useEffect, useRef, useState } from 'react';
import MeetTopBar from './MeetTopBar.jsx';

export default function PreJoinScreen({
  roomId,
  name,
  localStream,
  muted,
  cameraOff,
  toggleMic,
  toggleCamera,
  onJoin,
  onOpenSettings,
  step,
  status,
  connectCountdown,
  isCreating
}) {
  const videoRef = useRef(null);
  const [isPortrait, setIsPortrait] = useState(false);

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = localStream || null;
    }
  }, [localStream, cameraOff]);

  function handleLoadedMetadata() {
    if (videoRef.current) {
      setIsPortrait(videoRef.current.videoHeight > videoRef.current.videoWidth);
    }
  }

  let sidebarContent;

  if (status === 'rejected') {
    sidebarContent = (
      <>
        <h2>Entry denied</h2>
        <p className="prejoin-name">The host didn't let you into this session.</p>
        <div className="prejoin-actions">
          <button className="btn-secondary prejoin-settings-btn" onClick={() => window.location.href = '/'}>Go back home</button>
        </div>
      </>
    );
  } else if (status === 'kicked') {
    sidebarContent = (
      <>
        <h2>You were removed</h2>
        <p className="prejoin-name">The host removed you from this session.</p>
        <div className="prejoin-actions">
          <button className="btn-secondary prejoin-settings-btn" onClick={() => window.location.href = '/'}>Go back home</button>
        </div>
      </>
    );
  } else if (status === 'waiting') {
    sidebarContent = (
      <>
        <h2>Waiting for host</h2>
        <p className="prejoin-name">The host will let you in shortly. Hang tight!</p>
        <div className="waiting-spinner" aria-hidden="true" style={{ alignSelf: 'center', margin: '2rem 0' }} />
      </>
    );
  } else if (step === 'connecting' && status === 'connecting') {
    if (isCreating) {
      const pct = ((60 - connectCountdown) / 60) * 100;
      sidebarContent = (
        <>
          <h2>Joining meeting…</h2>
          <p className="prejoin-name">Waking up the server. Hang tight!</p>
          <div className="connecting-ring-wrap" style={{ alignSelf: 'center', margin: '1rem 0' }}>
            <svg className="connecting-ring" viewBox="0 0 100 100">
              <circle className="connecting-ring-bg" cx="50" cy="50" r="42" />
              <circle
                className="connecting-ring-fill"
                cx="50" cy="50" r="42"
                style={{ strokeDashoffset: `${264 - (264 * pct) / 100}` }}
              />
            </svg>
            <span className="connecting-countdown">{connectCountdown}s</span>
          </div>
        </>
      );
    } else {
      sidebarContent = (
        <>
          <h2>Connecting...</h2>
          <p className="prejoin-name">Joining the meeting. Hang tight!</p>
          <div className="waiting-spinner" aria-hidden="true" style={{ alignSelf: 'center', margin: '2rem 0' }} />
        </>
      );
    }
  } else if (step === 'ready' || status === 'joined') {
    sidebarContent = (
      <div style={{ textAlign: 'center' }}>
        <h2>Ready!</h2>
        <p className="prejoin-name" style={{ marginBottom: 0 }}>Entering the room...</p>
        <div className="ready-checkmark" style={{ fontSize: '5rem', margin: '1rem 0' }}>✅</div>
      </div>
    );
  } else {
    sidebarContent = (
      <>
        <h2>Ready to join?</h2>
        <p className="prejoin-name">Joining as <strong>{name}</strong></p>
        
        <div className="prejoin-actions">
          <button className="btn-primary prejoin-join-btn" onClick={onJoin}>
            Join now ✨
          </button>
          <button className="btn-secondary prejoin-settings-btn" onClick={onOpenSettings}>
            ⚙️ Check audio & video
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="room meet-mode prejoin-screen">
      <div className="room-stage meet-stage">
        <MeetTopBar roomId={roomId} />

        <div className="prejoin-content">
          <div className="prejoin-layout">
            
            <div className={`prejoin-video-container ${isPortrait ? 'is-portrait' : ''}`}>
              {!cameraOff && localStream ? (
                <video 
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="prejoin-video"
                  onLoadedMetadata={handleLoadedMetadata}
                />
              ) : (
                <div className="prejoin-avatar">
                  {name?.[0]?.toUpperCase() || '?'}
                </div>
              )}
              
              <div className="prejoin-video-controls">
                <button
                  className={`control-btn ${muted ? 'danger' : 'active'}`}
                  onClick={toggleMic}
                  title={muted ? 'Unmute' : 'Mute'}
                >
                  {muted ? '🔇' : '🎙️'}
                </button>
                <button
                  className={`control-btn ${cameraOff ? 'danger' : 'active'}`}
                  onClick={toggleCamera}
                  title={cameraOff ? 'Turn on camera' : 'Turn off camera'}
                >
                  {cameraOff ? '🚫' : '📸'}
                </button>
              </div>
            </div>

            <div className="prejoin-sidebar">
              {sidebarContent}
            </div>
            
          </div>
        </div>
      </div>
    </div>
  );
}
