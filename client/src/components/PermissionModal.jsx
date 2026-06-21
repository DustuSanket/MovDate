import { useEffect, useState } from 'react';

/**
 * PermissionModal
 *
 * Asks the user for mic and camera access one device at a time, with three
 * choices per device:
 *   • "This session only"  – grant now; browser may ask again next visit
 *   • "Always allow"       – grant now and store the preference in localStorage
 *   • "Not now"            – skip this device for this session
 *
 * Props
 *   onDone({ mic, camera })  – called once both devices have been handled.
 *                              Each value is 'granted' | 'denied'.
 */
export default function PermissionModal({ onDone }) {
  // Which device are we asking about right now?
  const [step, setStep] = useState('mic'); // 'mic' | 'camera'
  const [micResult, setMicResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // If the user previously chose "Always allow" for BOTH devices, we still
  // show the modal so the user always sees an explicit permission prompt
  // (the user specifically wants this), but we pre-start on mic step as
  // usual so they go through both choices.\n  // If only mic was "always", skip to camera step.
  useEffect(() => {
    const micAlways = localStorage.getItem('perm_mic') === 'always';
    if (micAlways) {
      setMicResult('granted');
      setStep('camera');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function requestDevice(kind, remember) {
    setBusy(true);
    setError(null);
    const constraints = kind === 'mic'
      ? { audio: true, video: false }
      : { audio: false, video: true };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      // Immediately stop the test tracks — the real hook will re-acquire them.
      stream.getTracks().forEach((t) => t.stop());
      if (remember) localStorage.setItem(`perm_${kind}`, 'always');
      return 'granted';
    } catch {
      return 'denied';
    } finally {
      setBusy(false);
    }
  }

  async function handleChoice(choice) {
    // choice: 'session' | 'always' | 'dismiss'
    if (busy) return;

    if (choice === 'dismiss') {
      // User skips this device entirely
      advance(step, 'denied');
      return;
    }

    const result = await requestDevice(step, choice === 'always');

    if (result === 'denied') {
      setError(
        step === 'mic'
          ? "Microphone access was blocked by the browser. You can change this in your browser's site settings."
          : "Camera access was blocked by the browser. You can change this in your browser's site settings."
      );
      // After a short delay let the user read the error, then move on
      setTimeout(() => {
        setError(null);
        advance(step, 'denied');
      }, 2500);
      return;
    }

    advance(step, 'granted');
  }

  function advance(device, result) {
    if (device === 'mic') {
      setMicResult(result);
      setStep('camera');
    } else {
      // camera step done
      onDone({ mic: micResult ?? 'denied', camera: result });
    }
  }

  const isMic = step === 'mic';
  const icon = isMic ? '🎙️' : '📷';
  const deviceLabel = isMic ? 'Microphone' : 'Camera';
  const description = isMic
    ? 'MovDate needs your microphone so others in the room can hear you.'
    : 'MovDate needs your camera so others in the room can see you.';

  return (
    <div className="perm-backdrop">
      <div className="perm-modal" role="dialog" aria-modal="true" aria-labelledby="perm-title">
        <div className="perm-icon">{icon}</div>
        <h2 id="perm-title">{deviceLabel} access</h2>
        <p className="perm-desc">{description}</p>

        {error && <p className="perm-error">{error}</p>}

        {!error && (
          <div className="perm-actions">
            <button
              type="button"
              className="perm-btn perm-btn--primary"
              onClick={() => handleChoice('always')}
              disabled={busy}
            >
              {busy ? 'Requesting…' : 'Allow whenever I visit'}
            </button>
            <button
              type="button"
              className="perm-btn perm-btn--secondary"
              onClick={() => handleChoice('session')}
              disabled={busy}
            >
              Allow this time only
            </button>
            <button
              type="button"
              className="perm-btn perm-btn--ghost"
              onClick={() => handleChoice('dismiss')}
              disabled={busy}
            >
              Not now
            </button>
          </div>
        )}

        <p className="perm-step-indicator">
          {isMic ? 'Step 1 of 2' : 'Step 2 of 2'}
        </p>
      </div>
    </div>
  );
}
