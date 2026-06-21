import { useEffect, useRef, useState } from 'react';

function DeviceSelect({ id, label, value, options, onChange, emptyLabel, onRequestPermission }) {
  return (
    <div className="device-select">
      <label htmlFor={id}>{label}</label>
      {options.length === 0 ? (
        <div className="device-settings-no-perm">
          No devices found.{' '}
          <button type="button" onClick={onRequestPermission}>
            Grant permission
          </button>{' '}
          to see your devices.
        </div>
      ) : (
        <select
          id={id}
          value={value || ''}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((device, index) => (
            <option key={device.deviceId || index} value={device.deviceId}>
              {device.label || `${label} ${index + 1}`}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// Mic / camera / speaker picker, the same idea as the device menu in any
// other meeting app. Renders as a small trigger button + popover so it can
// drop into both the normal call-actions row and the cramped fullscreen
// overlay bar without needing its own modal layer.
export default function DeviceSettings({
  devices,
  selectedMicId,
  selectedCameraId,
  selectedSpeakerId,
  speakerSupported,
  onChangeMic,
  onChangeCamera,
  onChangeSpeaker,
  onOpenChange,
  onRequestPermission,
  deviceError,
  compact,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return undefined;

    function handlePointerDown(event) {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event) {
      if (event.key === 'Escape') setOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div className={`device-settings${compact ? ' device-settings--compact' : ''}`} ref={wrapRef}>
      <button
        type="button"
        className="device-settings-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="true"
        title="Microphone, camera & speaker settings"
      >
        <span aria-hidden="true">⚙</span>
        {!compact && <span>Devices</span>}
      </button>

      {open && (
        <div className="device-settings-panel" role="menu">
          <DeviceSelect
            id="device-mic"
            label="Microphone"
            value={selectedMicId}
            options={devices.mics}
            onChange={onChangeMic}
            emptyLabel="No microphones found"
            onRequestPermission={onRequestPermission}
          />
          <DeviceSelect
            id="device-camera"
            label="Camera"
            value={selectedCameraId}
            options={devices.cameras}
            onChange={onChangeCamera}
            emptyLabel="No cameras found"
            onRequestPermission={onRequestPermission}
          />
          {speakerSupported ? (
            <DeviceSelect
              id="device-speaker"
              label="Speaker"
              value={selectedSpeakerId}
              options={devices.speakers}
              onChange={onChangeSpeaker}
              emptyLabel="No speakers found"
              onRequestPermission={onRequestPermission}
            />
          ) : (
            <p className="device-settings-note">
              Speaker selection isn't supported in this browser yet — audio plays through your
              system's default output.
            </p>
          )}
          {deviceError && <p className="device-settings-error">{deviceError}</p>}
        </div>
      )}
    </div>
  );
}
