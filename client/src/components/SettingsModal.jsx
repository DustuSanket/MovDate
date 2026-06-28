import React, { useState } from 'react';

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

export default function MeetSettingsModal({
  devices,
  selectedMicId,
  selectedCameraId,
  selectedSpeakerId,
  speakerSupported,
  screenResolution,
  screenFps,
  onChangeMic,
  onChangeCamera,
  onChangeSpeaker,
  onChangeScreenResolution,
  onChangeScreenFps,
  onRequestPermission,
  deviceError,
  isProtected,
  setProtected,
  onClose
}) {
  const [activeTab, setActiveTab] = useState('audio-video'); // 'audio-video' or 'security'

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div className="settings-modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-header">
          <h2>Settings</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="settings-modal-body">
          <div className="settings-tabs">
            <button 
              className={`settings-tab ${activeTab === 'audio-video' ? 'active' : ''}`}
              onClick={() => setActiveTab('audio-video')}
            >
              🎙️ Audio & Video
            </button>
            <button 
              className={`settings-tab ${activeTab === 'security' ? 'active' : ''}`}
              onClick={() => setActiveTab('security')}
            >
              🛡️ Security
            </button>
          </div>

          <div className="settings-tab-content">
            {activeTab === 'audio-video' && (
              <div className="settings-device-panel">
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
                
                <div className="device-select">
                  <label htmlFor="screen-res">Presentation Resolution</label>
                  <select
                    id="screen-res"
                    value={screenResolution || 'auto'}
                    onChange={(e) => onChangeScreenResolution && onChangeScreenResolution(e.target.value)}
                  >
                    <option value="auto">Auto (Browser Default)</option>
                    <option value="1080">1080p</option>
                    <option value="720">720p</option>
                    <option value="480">480p</option>
                    <option value="360">360p</option>
                  </select>
                </div>
                
                <div className="device-select">
                  <label htmlFor="screen-fps">Presentation Framerate</label>
                  <select
                    id="screen-fps"
                    value={screenFps || 'auto'}
                    onChange={(e) => onChangeScreenFps && onChangeScreenFps(e.target.value)}
                  >
                    <option value="auto">Auto (Browser Default)</option>
                    <option value="60">60 FPS</option>
                    <option value="30">30 FPS</option>
                    <option value="24">24 FPS</option>
                  </select>
                </div>

                {deviceError && <p className="device-settings-error">{deviceError}</p>}
              </div>
            )}

            {activeTab === 'security' && (
              <div className="settings-security-panel">
                <div className="setting-row">
                  <div className="setting-info">
                    <h3>Protected (Ask to join)</h3>
                    <p>When turned on, anyone who tries to join must be approved by the host first.</p>
                  </div>
                  <label className="toggle-switch">
                    <input 
                      type="checkbox" 
                      checked={isProtected}
                      onChange={(e) => setProtected(e.target.checked)}
                    />
                    <span className="slider round"></span>
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
