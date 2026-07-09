import { useEffect, useRef, useState } from 'react';
import { useLocation, useParams, useNavigate } from 'react-router-dom';
import { useRoomSocket } from '../hooks/useRoomSocket.js';
import { useLocalMedia } from '../hooks/useLocalMedia.js';
import { useMeshCall } from '../hooks/useMeshCall.js';
import MeetGrid from '../components/MeetGrid.jsx';
import PreJoinScreen from '../components/PreJoinScreen.jsx';
import MeetLayoutModal from '../components/MeetLayoutModal.jsx';
import MeetKnockToast from '../components/MeetKnockToast.jsx';
import MeetTopBar from '../components/MeetTopBar.jsx';
import ParticipantsPanel from '../components/ParticipantsPanel.jsx';
import ChatPanel from '../components/ChatPanel.jsx';
import SettingsModal from '../components/SettingsModal.jsx';
import PermissionModal from '../components/PermissionModal.jsx';

export default function Meet() {
  const { roomId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const [name, setName] = useState(() => {
    return location.state?.name || sessionStorage.getItem(`movdate_name_${roomId}`) || '';
  });
  const [pendingName, setPendingName] = useState('');

  useEffect(() => {
    if (name) sessionStorage.setItem(`movdate_name_${roomId}`, name);
  }, [name, roomId]);

  const [activeTab, setActiveTab] = useState('chat'); // 'chat' or 'participants'
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
  
  const [pinnedTrack, setPinnedTrack] = useState(null); // { peerId, trackId, isScreen }
  const [layoutMode, setLayoutMode] = useState('auto'); // 'auto', 'grid', 'showcase'
  const [screenResolution, setScreenResolution] = useState(() => localStorage.getItem('movdate_screen_res') || 'auto');
  const [screenFps, setScreenFps] = useState(() => localStorage.getItem('movdate_screen_fps') || 'auto');

  useEffect(() => {
    localStorage.setItem('movdate_screen_res', screenResolution);
    localStorage.setItem('movdate_screen_fps', screenFps);
  }, [screenResolution, screenFps]);

  const [layoutModalOpen, setLayoutModalOpen] = useState(false);
  const [activeSidebar, setActiveSidebar] = useState(null); // 'chat' | 'participants' | null
  const [controlsVisible, setControlsVisible] = useState(true);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [step, setStep] = useState('prejoin'); // 'prejoin' -> 'connecting' -> 'joined'
  const hideControlsTimeout = useRef(null);

  const wantsProtected = location.state?.protected || false;
  const isCreating = location.state?.isCreating || false;

  const [hostSecret] = useState(() => sessionStorage.getItem(`movdate_host_${roomId}`) || null);

  const {
    participants,
    you,
    hostId,
    isHost,
    messages,
    status,
    connectionError,
    kicked,
    isProtected,
    waitingKnocks,
    reconnectToken,
    sendChat,
    updateMediaState,
    switchHost,
    kickParticipant,
    admitParticipant,
    rejectParticipant,
    setProtected,
    forceParticipantMute,
    forceParticipantCamera,
    hostSecret: returnedHostSecret,
  } = useRoomSocket(roomId, name, { 
    protected: wantsProtected, 
    hostSecret, 
    isCreating,
    kind: 'meet',
    enabled: step !== 'prejoin',
    onForceMute: () => !muted && toggleMic(),
    onForceCameraOff: () => !cameraOff && toggleCamera(),
  });

  useEffect(() => {
    if (returnedHostSecret) {
      localStorage.setItem('movdate_host_secret_' + roomId, returnedHostSecret);
    }
  }, [returnedHostSecret, roomId]);

  const handleMouseMove = () => {
    setControlsVisible(true);
    if (hideControlsTimeout.current) clearTimeout(hideControlsTimeout.current);
    hideControlsTimeout.current = setTimeout(() => {
      // Don't hide controls if a modal or sidebar is open
      setControlsVisible(false);
    }, 3000);
  };

  useEffect(() => {
    return () => {
      if (hideControlsTimeout.current) clearTimeout(hideControlsTimeout.current);
    };
  }, []);

  const {
    stream: localStream,
    screenStream,
    error: mediaError,
    deviceError,
    muted,
    cameraOff,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    devices,
    selectedMicId,
    selectedCameraId,
    selectedSpeakerId,
    speakerSupported,
    switchMic,
    switchCamera,
    switchSpeaker,
    requestPermission,
  } = useLocalMedia({ permissions: mediaPerms, screenResolution, screenFps });

  const { remoteStreams, replaceLocalTrack } = useMeshCall({ you, participants, localStream, screenStream, reconnectToken });

  const [connectCountdown, setConnectCountdown] = useState(60);
  useEffect(() => {
    if (status !== 'connecting' || !name || step === 'prejoin') return undefined;
    setConnectCountdown(60);
    const timer = setInterval(() => {
      setConnectCountdown((prev) => {
        if (prev <= 1) { clearInterval(timer); return 0; }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [status, name, step]);

  useEffect(() => {
    if (status === 'joined' && step !== 'joined') {
      setStep('ready');
      const timer = setTimeout(() => setStep('joined'), 1500);
      return () => clearTimeout(timer);
    }
  }, [status, step]);

  useEffect(() => {
    if (!you) return;
    updateMediaState({ muted, cameraOff });
  }, [muted, cameraOff, you, updateMediaState]);

  // The error state is handled by navigating back to Home with the error message
  useEffect(() => {
    if (status === 'error' && connectionError) {
      navigate('/', { state: { error: connectionError }, replace: true });
    }
  }, [status, connectionError, navigate]);

  function handleJoinSubmit(event) {
    event.preventDefault();
    if (pendingName.trim()) {
      setName(pendingName.trim());
    }
  }

  // ─── Screens before the main room UI ───────────────────────────────────────

  if (!name) {
    return (
      <div className="join-gate theme-meet">
        <div className="home-card">
          <h2>Join this Meeting</h2>
          <p>Meeting {roomId}</p>
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

  if (step !== 'joined') {
    return (
      <>
        <PreJoinScreen
          roomId={roomId}
          name={name}
          localStream={localStream}
          muted={muted}
          cameraOff={cameraOff}
          toggleMic={toggleMic}
          toggleCamera={toggleCamera}
          onJoin={() => setStep('connecting')}
          onOpenSettings={() => setDeviceSettingsOpen(true)}
          step={step}
          status={status}
          connectCountdown={connectCountdown}
          isCreating={isCreating}
        />
        {deviceSettingsOpen && (
          <SettingsModal
            devices={devices}
            selectedMicId={selectedMicId}
            selectedCameraId={selectedCameraId}
            selectedSpeakerId={selectedSpeakerId}
            speakerSupported={speakerSupported}
            onChangeMic={switchMic}
            onChangeCamera={switchCamera}
            onChangeSpeaker={switchSpeaker}
            onRequestPermission={requestPermission}
            deviceError={deviceError}
            isProtected={isProtected}
            setProtected={setProtected}
            onClose={() => setDeviceSettingsOpen(false)}
          />
        )}
      </>
    );
  }

  // ─── Main Meeting UI ────────────────────────────────────────────────────────
  return (
    <div className={`room meet-mode theme-meet ${activeSidebar ? 'has-sidebar' : ''}`}>
      <div 
        className={`room-stage meet-stage ${!controlsVisible && !activeSidebar && !deviceSettingsOpen && !layoutModalOpen ? 'hide-controls' : ''}`}
        onMouseMove={handleMouseMove}
      >
        <MeetTopBar roomId={roomId} />
        
        <MeetKnockToast 
          knocks={waitingKnocks}
          onAdmit={admitParticipant}
          onReject={rejectParticipant}
        />

        <div className="stage-content">
          <MeetGrid
            participants={participants}
            you={you}
            hostId={hostId}
            localStream={localStream}
            screenStream={screenStream}
            remoteStreams={remoteStreams}
            speakerId={selectedSpeakerId}
            pinnedTrack={pinnedTrack}
            setPinnedTrack={setPinnedTrack}
            layoutMode={layoutMode}
            localMicOff={muted}
            localCameraOff={cameraOff}
          />
          
          <div className="meet-controls-bar">
            <div className="controls-center">
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
              <button
                className={`control-btn ${screenStream ? 'active' : ''}`}
                onClick={toggleScreenShare}
                title={screenStream ? 'Stop screen share' : 'Share screen'}
              >
                🖥️
              </button>
              
              <button
                className={`control-btn mobile-more-btn ${mobileMoreOpen ? 'active' : ''}`}
                onClick={() => setMobileMoreOpen(prev => !prev)}
                title="More options"
              >
                ⋮
              </button>

              <div className={`more-controls-group ${mobileMoreOpen ? 'is-open' : ''}`}>
                <button
                  className="control-btn"
                  onClick={() => { setLayoutModalOpen(true); setMobileMoreOpen(false); }}
                  title="Change layout"
                >
                  🔲
                </button>
                <button
                  className="control-btn"
                  onClick={() => { setDeviceSettingsOpen(true); setMobileMoreOpen(false); }}
                  title="Settings"
                >
                  ⚙️
                </button>
                <button
                  className={`control-btn ${activeSidebar === 'participants' ? 'active' : ''}`}
                  onClick={() => { setActiveSidebar(prev => prev === 'participants' ? null : 'participants'); setMobileMoreOpen(false); }}
                  title="People"
                >
                  👥
                </button>
                <button
                  className={`control-btn ${activeSidebar === 'chat' ? 'active' : ''}`}
                  onClick={() => { setActiveSidebar(prev => prev === 'chat' ? null : 'chat'); setMobileMoreOpen(false); }}
                  title="Chat"
                >
                  💬
                </button>
              </div>
            </div>
            <div className="controls-right">
               <button className="control-btn leave-btn danger" onClick={() => window.location.href = '/'}>
                 Leave 🚪
               </button>
            </div>
          </div>
        </div>
      </div>

      {activeSidebar === 'participants' && (
        <ParticipantsPanel
          participants={participants}
          you={you}
          hostId={hostId}
          isHost={isHost}
          onClose={() => setActiveSidebar(null)}
          onPin={setPinnedTrack}
          onKick={kickParticipant}
          onForceMute={forceParticipantMute}
          onForceCameraOff={forceParticipantCamera}
        />
      )}

      {activeSidebar === 'chat' && (
        <ChatPanel
          messages={messages}
          onSend={sendChat}
          you={you}
          isSidebar={true}
          onClose={() => setActiveSidebar(null)}
        />
      )}

      {layoutModalOpen && (
        <MeetLayoutModal 
          layoutMode={layoutMode} 
          setLayoutMode={setLayoutMode} 
          onClose={() => setLayoutModalOpen(false)} 
        />
      )}

      {deviceSettingsOpen && (
        <SettingsModal
          devices={devices}
          selectedMicId={selectedMicId}
          selectedCameraId={selectedCameraId}
          selectedSpeakerId={selectedSpeakerId}
          speakerSupported={speakerSupported}
          screenResolution={screenResolution}
          screenFps={screenFps}
          onChangeMic={switchMic}
          onChangeCamera={switchCamera}
          onChangeSpeaker={switchSpeaker}
          onChangeScreenResolution={setScreenResolution}
          onChangeScreenFps={setScreenFps}
          onRequestPermission={requestPermission}
          deviceError={deviceError}
          isProtected={isProtected}
          setProtected={setProtected}
          onClose={() => setDeviceSettingsOpen(false)}
        />
      )}

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

      {mediaError && <div className="media-error-toast">{mediaError}</div>}
      {deviceError && <div className="media-error-toast">{deviceError}</div>}
    </div>
  );
}
