import { useCallback, useEffect, useRef, useState } from 'react';

const SPEAKER_SUPPORTED =
  typeof window !== 'undefined' &&
  typeof window.HTMLMediaElement !== 'undefined' &&
  'setSinkId' in window.HTMLMediaElement.prototype;

export function useLocalMedia({ permissions = { mic: false, camera: false, answered: false }, screenResolution = 'auto', screenFps = 'auto' } = {}) {
  const [stream, setStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [error, setError] = useState(null);
  const [deviceError, setDeviceError] = useState(null);
  const [muted, setMuted] = useState(true);
  const [cameraOff, setCameraOff] = useState(true);
  
  const [shouldAcquire, setShouldAcquire] = useState({ audio: false, video: false });

  const [mics, setMics] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [speakers, setSpeakers] = useState([]);
  const [selectedMicId, setSelectedMicId] = useState('');
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [selectedSpeakerId, setSelectedSpeakerId] = useState('');

  const streamRef = useRef(null);
  const mutedRef = useRef(false);
  const cameraOffRef = useRef(false);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { cameraOffRef.current = cameraOff; }, [cameraOff]);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setMics(list.filter((d) => d.kind === 'audioinput'));
      setCameras(list.filter((d) => d.kind === 'videoinput'));
      setSpeakers(list.filter((d) => d.kind === 'audiooutput'));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const reqAudio = shouldAcquire.audio || (permissions.answered && permissions.mic);
    const reqVideo = shouldAcquire.video || (permissions.answered && permissions.camera);

    if (!reqAudio && !reqVideo) return undefined;

    const currentStream = streamRef.current;
    const hasAudio = currentStream?.getAudioTracks().length > 0;
    const hasVideo = currentStream?.getVideoTracks().length > 0;

    const needAudio = reqAudio && !hasAudio;
    const needVideo = reqVideo && !hasVideo;

    if (!needAudio && !needVideo) return undefined;

    let active = true;

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser doesn't support camera/mic access.");
      return undefined;
    }

    setError(null);

    navigator.mediaDevices
      .getUserMedia({ video: needVideo, audio: needAudio })
      .then((mediaStream) => {
        if (!active) {
          mediaStream.getTracks().forEach((track) => track.stop());
          return;
        }

        const oldTracks = currentStream ? currentStream.getTracks() : [];
        const newStream = new MediaStream([...oldTracks, ...mediaStream.getTracks()]);
        
        streamRef.current = newStream;
        setStream(newStream);

        if (needAudio) {
          setMuted(false);
          setSelectedMicId(mediaStream.getAudioTracks()[0]?.getSettings().deviceId || '');
        }
        if (needVideo) {
          setCameraOff(false);
          setSelectedCameraId(mediaStream.getVideoTracks()[0]?.getSettings().deviceId || '');
        }
        refreshDevices();
      })
      .catch((err) => {
        setError(
          err.name === 'NotAllowedError'
            ? 'Camera/mic access blocked. Allow access in your browser.'
            : 'Could not access camera or mic.'
        );
      });

    navigator.mediaDevices.addEventListener?.('devicechange', refreshDevices);

    return () => {
      active = false;
      navigator.mediaDevices.removeEventListener?.('devicechange', refreshDevices);
    };
  }, [refreshDevices, permissions, shouldAcquire]);

  function toggleMic() {
    if (!streamRef.current || streamRef.current.getAudioTracks().length === 0) {
      setShouldAcquire(prev => ({ ...prev, audio: true }));
      return;
    }
    const nextMuted = !muted;
    streamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMuted(nextMuted);
  }

  function toggleCamera() {
    if (!streamRef.current || streamRef.current.getVideoTracks().length === 0) {
      setShouldAcquire(prev => ({ ...prev, video: true }));
      return;
    }
    const nextOff = !cameraOff;
    streamRef.current.getVideoTracks().forEach((track) => {
      track.enabled = !nextOff;
    });
    setCameraOff(nextOff);
  }

  async function toggleScreenShare() {
    if (screenStream) {
      screenStream.getTracks().forEach((t) => t.stop());
      setScreenStream(null);
      return;
    }

    try {
      let videoConstraints = true;
      if (screenResolution !== 'auto' || screenFps !== 'auto') {
        videoConstraints = {};
        
        if (screenResolution === '1080') { videoConstraints.width = 1920; videoConstraints.height = 1080; }
        else if (screenResolution === '720') { videoConstraints.width = 1280; videoConstraints.height = 720; }
        else if (screenResolution === '480') { videoConstraints.width = 854; videoConstraints.height = 480; }
        else if (screenResolution === '360') { videoConstraints.width = 640; videoConstraints.height = 360; }
        
        if (screenFps !== 'auto') {
          videoConstraints.frameRate = parseInt(screenFps, 10);
        }
      }

      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: true
      });
      
      // When user clicks browser's built-in "Stop sharing" button
      displayStream.getVideoTracks()[0].onended = () => {
        setScreenStream(null);
      };
      
      setScreenStream(displayStream);
    } catch (err) {
      console.warn("Screen share cancelled or failed:", err);
    }
  }

  // Swaps in a new mic/camera track in place, on the SAME MediaStream object
  // that's already attached to the local preview and (via the mesh hook) to
  // every peer connection. Mutating tracks on a live MediaStream — rather
  // than creating a brand new stream/object reference — means the local
  // <video>/<audio> preview updates itself automatically; the caller still
  // needs to push the new track into any active RTCRtpSenders (Room wires
  // that up via useMeshCall's replaceLocalTrack), since swapping a track on
  // a stream doesn't touch connections that already negotiated the old one.
  const switchDevice = useCallback(async (kind, deviceId) => {
    if (!deviceId) return null;
    const isAudio = kind === 'mic';
    if (!streamRef.current || (isAudio ? streamRef.current.getAudioTracks().length === 0 : streamRef.current.getVideoTracks().length === 0)) {
      setShouldAcquire(prev => ({ ...prev, [isAudio ? 'audio' : 'video']: true }));
      return null;
    }
    const currentId = isAudio
      ? streamRef.current?.getAudioTracks()[0]?.getSettings().deviceId
      : streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId;
    if (deviceId === currentId) return null;

    setDeviceError(null);
    try {
      const constraints = isAudio
        ? { audio: { deviceId: { exact: deviceId } } }
        : { video: { deviceId: { exact: deviceId } } };
      const freshStream = await navigator.mediaDevices.getUserMedia(constraints);
      const newTrack = isAudio ? freshStream.getAudioTracks()[0] : freshStream.getVideoTracks()[0];
      if (!newTrack) return null;

      newTrack.enabled = isAudio ? !mutedRef.current : !cameraOffRef.current;

      const target = streamRef.current;
      if (target) {
        const oldTracks = isAudio ? target.getAudioTracks() : target.getVideoTracks();
        oldTracks.forEach((track) => {
          target.removeTrack(track);
          track.stop();
        });
        target.addTrack(newTrack);
      }

      if (isAudio) setSelectedMicId(deviceId);
      else setSelectedCameraId(deviceId);
      refreshDevices();

      return newTrack;
    } catch (err) {
      setDeviceError(
        isAudio
          ? "Couldn't switch microphone — it may be in use by another app."
          : "Couldn't switch camera — it may be in use by another app."
      );
      return null;
    }
  }, [refreshDevices]);

  const switchMic = useCallback((deviceId) => switchDevice('mic', deviceId), [switchDevice]);
  const switchCamera = useCallback((deviceId) => switchDevice('camera', deviceId), [switchDevice]);

  // Output (speaker) device has no track to swap — it's applied per
  // <audio>/<video> element via HTMLMediaElement.setSinkId, wherever each
  // participant's remote audio is actually rendered (ParticipantTile).
  const switchSpeaker = useCallback((deviceId) => {
    setSelectedSpeakerId(deviceId);
  }, []);

  const requestPermission = useCallback(() => {
    setShouldAcquire({ audio: true, video: true });
  }, []);

  return {
    stream,
    screenStream,
    error,
    deviceError,
    muted,
    cameraOff,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    devices: { mics, cameras, speakers },
    selectedMicId,
    selectedCameraId,
    selectedSpeakerId,
    speakerSupported: SPEAKER_SUPPORTED,
    switchMic,
    switchCamera,
    switchSpeaker,
    requestPermission,
  };
}
