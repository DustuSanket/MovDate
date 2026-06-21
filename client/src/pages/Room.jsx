import { useEffect, useRef, useState } from 'react';
import { useLocation, useParams, useNavigate } from 'react-router-dom';
import { useRoomSocket } from '../hooks/useRoomSocket.js';
import { useLocalMedia } from '../hooks/useLocalMedia.js';
import { useMeshCall } from '../hooks/useMeshCall.js';
import VideoPlayer from '../components/VideoPlayer.jsx';
import PlayerControls from '../components/PlayerControls.jsx';
import CallGrid from '../components/CallGrid.jsx';
import CallOverlay from '../components/CallOverlay.jsx';
import ChatPanel from '../components/ChatPanel.jsx';
import InviteBar from '../components/InviteBar.jsx';
import DeviceSettings from '../components/DeviceSettings.jsx';
import PermissionModal from '../components/PermissionModal.jsx';
import LocalFilePrompt from '../components/LocalFilePrompt.jsx';
import { useLocalFileStream } from '../hooks/useLocalFileStream.js';

export default function Room() {
  const { roomId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const [name, setName] = useState(() => {
    return location.state?.name || sessionStorage.getItem(`movdate_name_${roomId}`) || '';
  });
  const [pendingName, setPendingName] = useState('');

  // Persist name across refreshes
  useEffect(() => {
    if (name) sessionStorage.setItem(`movdate_name_${roomId}`, name);
  }, [name, roomId]);

  const [activeTab, setActiveTab] = useState('chat');
  const [displayTime, setDisplayTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [mutedAutoplay, setMutedAutoplay] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsHidden, setControlsHidden] = useState(false);
  const [deviceSettingsOpen, setDeviceSettingsOpen] = useState(false);
  const [mediaPerms, setMediaPerms] = useState(() => {
    try {
      const saved = localStorage.getItem('movdate_media_perms');
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return { mic: false, camera: false, answered: false };
  });
  const [showPermModal, setShowPermModal] = useState(() => {
    return !localStorage.getItem('movdate_media_perms');
  });
  const [localFileUrl, setLocalFileUrl] = useState(null);
  const localFileRef = useRef(null);

  // Local file mode: 'none' | 'local-copy' | 'stream'
  const [localFileMode, setLocalFileMode] = useState('none');
  const [hostFile, setHostFile] = useState(null);
  const [localPromptDismissed, setLocalPromptDismissed] = useState(false);

  const playerRef = useRef(null);
  const stageWrapRef = useRef(null);
  const idleTimerRef = useRef(null);

  // Protected room: read flag from navigation state (set on Home page)
  const wantsProtected = location.state?.protected || false;

  const [hostSecret] = useState(() => sessionStorage.getItem(`movdate_host_${roomId}`) || null);

  const {
    participants,
    you,
    hostId,
    isHost,
    video,
    messages,
    status,
    connectionError,
    kicked,
    isProtected,
    waitingKnocks,
    videoEventBus,
    pauseRequests,
    pauseRequestDenied,
    reconnectToken,
    loadVideo,
    play,
    pause,
    seek,
    sendChat,
    updateMediaState,
    sendHeartbeat,
    requestPause,
    respondToPauseRequest,
    dismissPauseRequest,
    switchHost,
    kickParticipant,
    admitParticipant,
    rejectParticipant,
    setProtected,
    hostSecret: returnedHostSecret,
  } = useRoomSocket(roomId, name, { protected: wantsProtected, hostSecret });

  useEffect(() => {
    if (returnedHostSecret) {
      sessionStorage.setItem(`movdate_host_${roomId}`, returnedHostSecret);
    }
  }, [returnedHostSecret, roomId]);

  const {
    stream: localStream,
    error: mediaError,
    deviceError,
    muted,
    cameraOff,
    toggleMic,
    toggleCamera,
    devices,
    selectedMicId,
    selectedCameraId,
    selectedSpeakerId,
    speakerSupported,
    switchMic,
    switchCamera,
    switchSpeaker,
    requestPermission,
  } = useLocalMedia({ permissions: mediaPerms });
  const { remoteStreams, replaceLocalTrack, dataChannels } = useMeshCall({ you, participants, localStream, reconnectToken });

  const { streamUrl, streamReady, streamError, streamProgress, streamFileToPeer, hostSendProgress } = useLocalFileStream({
    isHost,
    dataChannels,
    file: hostFile,
  });

  // ── 60-second countdown for cold-start connecting screen ──
  const [connectCountdown, setConnectCountdown] = useState(60);
  useEffect(() => {
    if (status !== 'connecting' || !name) return undefined;
    setConnectCountdown(60);
    const timer = setInterval(() => {
      setConnectCountdown((prev) => {
        if (prev <= 1) { clearInterval(timer); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [status, name]);

  useEffect(() => {
    if (!you) return;
    updateMediaState({ muted, cameraOff });
  }, [muted, cameraOff, you, updateMediaState]);

  const isHostRef = useRef(isHost);
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);

  useEffect(() => {
    if (!videoEventBus) return undefined;

    function handlePlay(event) {
      setAutoplayBlocked(false);
      setMutedAutoplay(false);
      setPlaybackError(false);
      if (!isHostRef.current) {
        playerRef.current?.playAt(event.detail.time);
      }
    }
    function handlePause(event) {
      if (!isHostRef.current) {
        playerRef.current?.pauseAt(event.detail.time);
      }
    }
    function handleSeek(event) {
      if (!isHostRef.current) {
        playerRef.current?.seekTo(event.detail.time);
      }
    }

    videoEventBus.addEventListener('play', handlePlay);
    videoEventBus.addEventListener('pause', handlePause);
    videoEventBus.addEventListener('seek', handleSeek);

    return () => {
      videoEventBus.removeEventListener('play', handlePlay);
      videoEventBus.removeEventListener('pause', handlePause);
      videoEventBus.removeEventListener('seek', handleSeek);
    };
  }, [videoEventBus]);

  useEffect(() => {
    const interval = setInterval(() => {
      const time = playerRef.current?.getCurrentTime?.() ?? 0;
      setDisplayTime(time);
      const dur = playerRef.current?.getDuration?.() ?? 0;
      if (dur) setDuration(dur);
    }, 500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!isHost || !video?.isPlaying) return undefined;
    const interval = setInterval(() => {
      const time = playerRef.current?.getCurrentTime?.() ?? 0;
      sendHeartbeat(time);
    }, 5000);
    return () => clearInterval(interval);
  }, [isHost, video?.isPlaying, sendHeartbeat]);

  // Guard: when the host picks a local file we set a flag so the video?.url
  // change effect doesn't revoke the blob URL we JUST created. The flag is
  // set before loadVideo() and cleared after the effect runs.
  const hostLoadingLocalRef = useRef(false);

  useEffect(() => {
    setAutoplayBlocked(false);
    setMutedAutoplay(false);
    setPlaybackError(false);

    if (!isHost) {
      if (localFileUrl) URL.revokeObjectURL(localFileUrl);
      setLocalFileMode('none');
      setLocalPromptDismissed(false);
      setLocalFileUrl(null);
    } else if (!video?.url?.startsWith?.('local:')) {
      // Switching away from a local file to YouTube/URL — clean up
      if (!hostLoadingLocalRef.current && localFileUrl) {
        URL.revokeObjectURL(localFileUrl);
        setLocalFileUrl(null);
      }
      setHostFile(null);
    }
    hostLoadingLocalRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.url, isHost]);

  useEffect(() => {
    function handleFullscreenChange() {
      const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
      setIsFullscreen(Boolean(fsElement) && fsElement === stageWrapRef.current);
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    if (!isFullscreen) {
      setControlsHidden(false);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      return undefined;
    }

    function resetIdleTimer() {
      setControlsHidden(false);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (deviceSettingsOpen) return;
      idleTimerRef.current = setTimeout(() => setControlsHidden(true), 3000);
    }

    resetIdleTimer();
    const el = stageWrapRef.current;
    el?.addEventListener('mousemove', resetIdleTimer);
    el?.addEventListener('pointermove', resetIdleTimer);
    el?.addEventListener('touchstart', resetIdleTimer);

    return () => {
      el?.removeEventListener('mousemove', resetIdleTimer);
      el?.removeEventListener('pointermove', resetIdleTimer);
      el?.removeEventListener('touchstart', resetIdleTimer);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [isFullscreen, deviceSettingsOpen]);

  async function handleSwitchMic(deviceId) {
    const newTrack = await switchMic(deviceId);
    if (newTrack) replaceLocalTrack(newTrack);
  }

  async function handleSwitchCamera(deviceId) {
    const newTrack = await switchCamera(deviceId);
    if (newTrack) replaceLocalTrack(newTrack);
  }

  function toggleFullscreen() {
    const el = stageWrapRef.current;
    if (!el) return;
    const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fsElement) {
      const request = el.requestFullscreen || el.webkitRequestFullscreen;
      request?.call(el);
    } else {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      exit?.call(document);
    }
  }

  const isLocalFileSentinel = video?.url?.startsWith?.('local:');
  let videoSource = null;
  if (video?.url && !isLocalFileSentinel) {
    videoSource = { type: video.type, url: video.url, id: video.id };
  } else if (video?.url && isLocalFileSentinel) {
    if (isHost && localFileUrl) {
      videoSource = { type: 'file', url: localFileUrl, isLocal: true };
    } else if (!isHost && localFileMode === 'local-copy' && localFileUrl) {
      videoSource = { type: 'file', url: localFileUrl, isLocal: true };
    } else if (!isHost && localFileMode === 'stream' && streamUrl) {
      videoSource = { type: 'file', url: streamUrl, isLocal: false };
    }
  }

  function handleLoadVideo(parsed) {
    loadVideo(parsed);
    setDuration(0);
    setDisplayTime(0);
    setPlaybackError(false);
    if (localFileUrl) {
      URL.revokeObjectURL(localFileUrl);
      setLocalFileUrl(null);
    }
  }

  async function handleLocalFilePick(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    // Revoke the previous blob URL ONLY now that we have a replacement
    const oldUrl = localFileUrl;

    setHostFile(file);
    const objectUrl = URL.createObjectURL(file);
    setLocalFileUrl(objectUrl);
    setLocalPromptDismissed(false);
    setPlaybackError(false);

    // Tell the video?.url effect NOT to revoke the URL we just set
    hostLoadingLocalRef.current = true;

    const parsed = {
      type: 'file',
      url: `local:${file.name}`,
      isLocal: true,
      localFileName: file.name,
    };
    loadVideo(parsed);
    setDuration(0);
    setDisplayTime(0);

    // Revoke the old URL after a short delay so the <video> element
    // has time to detach from it before the browser invalidates it
    if (oldUrl) setTimeout(() => URL.revokeObjectURL(oldUrl), 200);

    event.target.value = '';
  }

  function handleParticipantFilePick(file) {
    if (localFileUrl) URL.revokeObjectURL(localFileUrl);
    const url = URL.createObjectURL(file);
    setLocalFileUrl(url);
    setLocalFileMode('local-copy');
    setLocalPromptDismissed(true);
  }

  function handleUseStream() {
    setLocalFileMode('stream');
    // prompt stays open; dismissed once streamReady
  }

  // Participant resets their source choice — brings the modal back
  function handleSwitchMode() {
    // Revoke local-copy object URL if that was the active mode
    if (localFileMode === 'local-copy' && localFileUrl) {
      URL.revokeObjectURL(localFileUrl);
      setLocalFileUrl(null);
    }
    // Setting localFileMode to 'none' causes wantStream to become false,
    // which triggers the hook to clear streamReady/streamUrl/streamProgress
    // so the modal renders with fresh options instead of "Stream ready!".
    setLocalFileMode('none');
    setLocalPromptDismissed(false);
  }

  useEffect(() => {
    if (streamReady && localFileMode === 'stream') {
      setLocalPromptDismissed(true);
    }
  }, [streamReady, localFileMode]);

  useEffect(() => {
    return () => {
      if (localFileUrl) URL.revokeObjectURL(localFileUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleHostPlayPause({ kind, time }) {
    if (kind === 'play') {
      play(time);
      setAutoplayBlocked(false);
      setMutedAutoplay(false);
    } else {
      pause(time);
    }
  }

  function handleTogglePlay() {
    if (!isHost) return;
    const time = playerRef.current?.getCurrentTime?.() ?? 0;
    if (video.isPlaying) {
      pause(time);
      playerRef.current?.pauseAt(time);
    } else {
      play(time);
      playerRef.current?.playAt(time);
      setAutoplayBlocked(false);
      setMutedAutoplay(false);
    }
  }

  function handleSeek(time) {
    if (!isHost) return;
    seek(time);
    playerRef.current?.seekTo(time);
  }

  function handleSkip(delta) {
    if (!isHost || !videoSource) return;
    const current = playerRef.current?.getCurrentTime?.() ?? displayTime;
    const dur = playerRef.current?.getDuration?.() ?? duration;
    let next = current + delta;
    if (next < 0) next = 0;
    if (dur > 0 && next > dur) next = dur;
    handleSeek(next);
  }

  useEffect(() => {
    if (!isHost || !videoSource) return undefined;

    function handleKeyDown(event) {
      const target = event.target;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        handleSkip(10);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        handleSkip(-10);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, videoSource, displayTime, duration]);

  function handlePauseRequestApprove(fromId) {
    const time = playerRef.current?.getCurrentTime?.() ?? 0;
    pause(time);
    playerRef.current?.pauseAt(time);
    respondToPauseRequest({ approved: true, toId: fromId, time });
    dismissPauseRequest(fromId);
  }

  function handlePauseRequestDeny(fromId) {
    respondToPauseRequest({ approved: false, toId: fromId, time: 0 });
    dismissPauseRequest(fromId);
  }

  function handleJoinSubmit(event) {
    event.preventDefault();
    if (pendingName.trim()) {
      setName(pendingName.trim());
    }
  }

  // ─── Screens before the main room UI ───────────────────────────────────────

   if (!name) {
    return (
      <div className="join-gate">
        <div className="home-card">
          <h2>Join this MovDate session</h2>
          <p>Room {roomId}</p>
          <form onSubmit={handleJoinSubmit}>
            <label htmlFor="pending-name">Your name</label>
            <input
              id="pending-name"
              value={pendingName}
              onChange={(event) => setPendingName(event.target.value)}
              placeholder="e.g. Priya"
              required
              autoFocus
            />
            <button type="submit">Join</button>
          </form>
        </div>
      </div>
    );
  }

  if (status === 'connecting') {
    const pct = ((60 - connectCountdown) / 60) * 100;
    return (
      <div className="join-gate">
        <div className="home-card connecting-card">
          <div className="connecting-ring-wrap">
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
          <h2>Joining room…</h2>
          <p className="connecting-desc">
            Waking up the server — this can take up to a minute on the first
            connection. Hang tight!
          </p>
          <p className="waiting-room-id">Room: <strong>{roomId}</strong></p>
          <div className="connecting-dots" aria-hidden="true">
            <span /><span /><span />
          </div>
        </div>
      </div>
    );
  }

  if (status === 'waiting') {
    return (
      <div className="join-gate">
        <div className="home-card waiting-card">
          <div className="waiting-spinner" aria-hidden="true" />
          <h2>Waiting for host</h2>
          <p>The host will let you in shortly. Hang tight!</p>
          <p className="waiting-room-id">Room: <strong>{roomId}</strong></p>
        </div>
      </div>
    );
  }

  if (status === 'rejected') {
    return (
      <div className="join-gate">
        <div className="home-card">
          <h2>Entry denied</h2>
          <p>The host didn't let you into this session.</p>
        </div>
      </div>
    );
  }

  if (status === 'kicked') {
    return (
      <div className="join-gate">
        <div className="home-card">
          <h2>You were removed</h2>
          <p>The host removed you from this session.</p>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="join-gate">
        <div className="home-card">
          <h2>Couldn't join</h2>
          <p>{connectionError}</p>
        </div>
      </div>
    );
  }

  // ─── Main room UI ──────────────────────────────────────────────────────────
  return (
    <div className="room">
      {showPermModal && (
        <PermissionModal
          onDone={({ mic, camera }) => {
            setShowPermModal(false);
            const perms = {
              mic: mic === 'granted',
              camera: camera === 'granted',
              answered: true
            };
            setMediaPerms(perms);
            localStorage.setItem('movdate_media_perms', JSON.stringify(perms));
          }}
        />
      )}

      <header className="room-header">
        <InviteBar roomId={roomId} />
        <div className="room-header-right">
          {/* Protected room toggle — host only */}
          {isHost && (
            <button
              type="button"
              className={`protect-toggle-btn${isProtected ? ' protect-toggle-btn--on' : ''}`}
              onClick={() => setProtected(!isProtected)}
              title={isProtected ? 'Room is protected — click to open it' : 'Room is open — click to protect it'}
            >
              {isProtected ? '🔒 Protected' : '🔓 Open room'}
            </button>
          )}
          {!isHost && isProtected && (
            <span className="protect-badge" title="Only the host can admit participants">🔒 Protected</span>
          )}
          <span className="participant-count">
            {participants.length} {participants.length === 1 ? 'person' : 'people'} watching
          </span>
          <button
            type="button"
            className="leave-room-btn"
            onClick={() => navigate('/')}
            title="Leave room and return to home"
          >
            Leave
          </button>
        </div>
      </header>

      {/* Waiting-room knock toasts + pause-request toasts are rendered
          inside video-stage-wrap (below) so they remain visible during
          fullscreen — the Fullscreen API only shows children of the
          fullscreen element, so placing them here as siblings would
          make them invisible when the host enters full screen. */}

      <div className="room-body">
        <section className="room-main">
          <div
            className={`video-stage-wrap${isFullscreen ? ' video-stage-wrap--fullscreen' : ''}${
              isFullscreen && controlsHidden ? ' controls-hidden' : ''
            }`}
            ref={stageWrapRef}
          >
            <VideoPlayer
              ref={playerRef}
              source={videoSource}
              isHost={isHost}
              onHostPlayPause={handleHostPlayPause}
              onAutoplayBlocked={() => setAutoplayBlocked(true)}
              onMutedAutoplay={() => setMutedAutoplay(true)}
              onPlaybackError={() => setPlaybackError(true)}
            />

            {/* Waiting-room knock toasts — host sees these (inside stage-wrap for fullscreen visibility) */}
            {isHost && waitingKnocks.length > 0 && (
              <div className="pause-request-stack">
                {waitingKnocks.map((knock) => (
                  <div key={knock.socketId} className="pause-request-toast knock-toast">
                    <span>
                      <strong>{knock.name}</strong> wants to join
                    </span>
                    <button
                      type="button"
                      className="pause-req-btn pause-req-btn--approve"
                      onClick={() => admitParticipant(knock.socketId)}
                    >
                      Admit
                    </button>
                    <button
                      type="button"
                      className="pause-req-btn pause-req-btn--deny"
                      onClick={() => rejectParticipant(knock.socketId)}
                    >
                      Reject
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Host: pause-request toasts */}
            {isHost && pauseRequests.length > 0 && (
              <div className="pause-request-stack">
                {pauseRequests.map((req) => (
                  <div key={req.fromId} className="pause-request-toast">
                    <span>
                      <strong>{req.fromName}</strong> wants to pause
                    </span>
                    <button
                      type="button"
                      className="pause-req-btn pause-req-btn--approve"
                      onClick={() => handlePauseRequestApprove(req.fromId)}
                    >
                      Pause
                    </button>
                    <button
                      type="button"
                      className="pause-req-btn pause-req-btn--deny"
                      onClick={() => handlePauseRequestDeny(req.fromId)}
                    >
                      Ignore
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Participant: feedback when request was denied */}
            {!isHost && pauseRequestDenied && (
              <div className="pause-request-stack">
                <div className="pause-request-toast pause-request-toast--denied">
                  Host kept the video playing.
                </div>
              </div>
            )}

            {/* Participant: local-file source prompt / switch pill */}
            {!isHost && isLocalFileSentinel && (
              <LocalFilePrompt
                fileName={video?.url?.replace('local:', '') || 'video file'}
                onPickFile={handleParticipantFilePick}
                onUseStream={handleUseStream}
                streamReady={streamReady}
                streamError={streamError}
                streamProgress={streamProgress}
                dismissed={localPromptDismissed && !(localFileMode === 'stream' && !streamReady)}
              />
            )}

            <button
              type="button"
              className="fullscreen-toggle"
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit full screen' : 'Full screen'}
              aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
            >
              {isFullscreen ? '⤡' : '⤢'}
            </button>

            {autoplayBlocked && (
              <p className={`media-warning${isFullscreen ? ' media-warning--overlay' : ''}`}>
                Your browser blocked autoplay. Press play once to start in sync with everyone else.
              </p>
            )}

            {mutedAutoplay && (
              <button
                type="button"
                className={`media-warning media-warning--action${isFullscreen ? ' media-warning--overlay' : ''}`}
                onClick={() => {
                  playerRef.current?.unmute();
                  setMutedAutoplay(false);
                }}
              >
                🔇 Playing muted to stay in sync — tap to unmute
              </button>
            )}

            {playbackError && (
              <p className={`media-warning${isFullscreen ? ' media-warning--overlay' : ''}`}>
                This browser can't play that file — it's likely an unsupported codec inside the
                container. {isHost ? 'Try loading an .mp4 link instead.' : 'Ask the host to load an .mp4 link instead.'}
              </p>
            )}

            {/* Host: show when participants are receiving the file stream */}
            {isHost && hostSendProgress.size > 0 && (
              <div className="host-stream-status">
                {[...hostSendProgress.entries()].map(([peerId, pct]) => {
                  const peer = participants.find((p) => p.id === peerId);
                  const peerName = peer?.name || 'Someone';
                  return (
                    <div key={peerId} className="host-stream-status-item">
                      <span className="host-stream-name">{peerName}</span>
                      <div className="host-stream-bar">
                        <div className="host-stream-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="host-stream-pct">
                        {pct >= 100 ? '✓ Ready' : `${pct}%`}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            <PlayerControls
              isHost={isHost}
              isPlaying={Boolean(video?.isPlaying)}
              currentTime={displayTime}
              duration={duration}
              onTogglePlay={handleTogglePlay}
              onSeek={handleSeek}
              onSkip={handleSkip}
              onLoadVideo={handleLoadVideo}
              onLoadLocalFile={handleLocalFilePick}
              onRequestPause={requestPause}
              hasVideo={Boolean(videoSource)}
              onVolumeChange={(vol) => playerRef.current?.setVolume?.(vol)}
            />

            {isFullscreen && (
              <CallOverlay
                participants={participants}
                you={you}
                hostId={hostId}
                localStream={localStream}
                remoteStreams={remoteStreams}
                boundsRef={stageWrapRef}
                muted={muted}
                cameraOff={cameraOff}
                onToggleMic={toggleMic}
                onToggleCamera={toggleCamera}
                devices={devices}
                selectedMicId={selectedMicId}
                selectedCameraId={selectedCameraId}
                selectedSpeakerId={selectedSpeakerId}
                speakerSupported={speakerSupported}
                onChangeMic={handleSwitchMic}
                onChangeCamera={handleSwitchCamera}
                onChangeSpeaker={switchSpeaker}
                deviceError={deviceError}
                onDeviceSettingsOpenChange={setDeviceSettingsOpen}
                onRequestPermission={requestPermission}
              />
            )}
          </div>

          {mediaError && <p className="media-warning">{mediaError}</p>}

          <CallGrid
            participants={participants}
            you={you}
            hostId={hostId}
            localStream={localStream}
            remoteStreams={remoteStreams}
            speakerId={selectedSpeakerId}
          />

          <div className="call-actions">
            <button type="button" onClick={toggleMic} className={muted ? 'is-off' : ''}>
              {muted ? 'Unmute' : 'Mute'}
            </button>
            <button type="button" onClick={toggleCamera} className={cameraOff ? 'is-off' : ''}>
              {cameraOff ? 'Start camera' : 'Stop camera'}
            </button>
            <DeviceSettings
              devices={devices}
              selectedMicId={selectedMicId}
              selectedCameraId={selectedCameraId}
              selectedSpeakerId={selectedSpeakerId}
              speakerSupported={speakerSupported}
              onChangeMic={handleSwitchMic}
              onChangeCamera={handleSwitchCamera}
              onChangeSpeaker={switchSpeaker}
              deviceError={deviceError}
              onOpenChange={setDeviceSettingsOpen}
              onRequestPermission={requestPermission}
            />
            {/* Participant: switch local-file source — shown after a choice is made */}
            {!isHost && isLocalFileSentinel && localPromptDismissed &&
              (localFileMode === 'local-copy' || (localFileMode === 'stream' && streamReady)) && (
              <button
                type="button"
                className="source-switch-pill"
                onClick={handleSwitchMode}
                title="Switch between your own local copy and streaming from the host"
              >
                🔄 Switch source
              </button>
            )}
          </div>
        </section>

        <aside className="room-sidebar">
          <div className="sidebar-tabs">
            <button
              type="button"
              className={activeTab === 'chat' ? 'active' : ''}
              onClick={() => setActiveTab('chat')}
            >
              Chat
            </button>
            <button
              type="button"
              className={activeTab === 'people' ? 'active' : ''}
              onClick={() => setActiveTab('people')}
            >
              People ({participants.length})
            </button>
          </div>

          {activeTab === 'chat' ? (
            <ChatPanel messages={messages} onSend={sendChat} you={you} />
          ) : (
            <ul className="people-list">
              {participants.map((p) => (
                <li key={p.id} className="people-list-item">
                  <div className="people-list-info">
                    <span className="people-list-name">{p.name}</span>
                    {p.id === you?.id && <span className="people-list-you"> (you)</span>}
                    {p.id === hostId && <span className="badge badge--host">Host</span>}
                  </div>
                  {isHost && p.id !== you?.id && (
                    <div className="people-list-actions">
                      <button
                        type="button"
                        className="people-action-btn people-action-btn--switch"
                        onClick={() => switchHost(p.id)}
                        title={`Make ${p.name} host`}
                      >
                        Make host
                      </button>
                      <button
                        type="button"
                        className="people-action-btn people-action-btn--kick"
                        onClick={() => kickParticipant(p.id)}
                        title={`Remove ${p.name}`}
                      >
                        Kick
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
