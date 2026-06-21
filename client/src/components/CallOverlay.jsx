import { useRef, useState } from 'react';
import ParticipantTile from './ParticipantTile.jsx';
import DeviceSettings from './DeviceSettings.jsx';

// Floating participant strip shown over the video while it's full screen
// (the normal in-page CallGrid isn't visible once the browser's native
// Fullscreen API takes over, so this is the only place people see faces
// during full screen). It's intentionally self-contained: layout, size and
// position all live in local state and reset the next time full screen is
// entered, rather than trying to persist a "correct" spot across renders.
//
// - Click the layout button to cycle bottom bar -> side bar -> floating grid.
// - Drag the handle (the grip + label strip) to reposition.
// - Drag the corner handle to resize the tiles.
const LAYOUTS = ['top-bar', 'bottom-bar', 'floating-horizontal', 'floating-vertical'];
const LAYOUT_LABELS = {
  'top-bar': 'Top bar',
  'bottom-bar': 'Bottom bar',
  'floating-horizontal': 'Floating horizontal',
  'floating-vertical': 'Floating vertical',
};

const MIN_TILE = 72;
const MAX_TILE = 200;
const DEFAULT_TILE = 110;

// Tiny self-contained eye / eye-off icon — no icon library in this project,
// and an actual eye reads more clearly here than an emoji across platforms.
function EyeIcon({ off }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <line x1="2" y1="2" x2="22" y2="22" />}
    </svg>
  );
}

export default function CallOverlay({
  participants,
  you,
  hostId,
  localStream,
  remoteStreams,
  boundsRef,
  muted,
  cameraOff,
  onToggleMic,
  onToggleCamera,
  devices,
  selectedMicId,
  selectedCameraId,
  selectedSpeakerId,
  speakerSupported,
  onChangeMic,
  onChangeCamera,
  onChangeSpeaker,
  deviceError,
  onDeviceSettingsOpenChange,
  onRequestPermission,
}) {
  const [layout, setLayout] = useState('bottom-bar');
  const [tileSize, setTileSize] = useState(DEFAULT_TILE);
  // null means "use the CSS default position for the current layout";
  // it becomes a concrete {x, y} (px, relative to boundsRef) once dragged.
  const [position, setPosition] = useState(null);
  // Collapses the tile strip while keeping the handle (and this toggle)
  // on screen, so faces can be tucked away without leaving full screen.
  // Resets to visible next time full screen is entered, same as layout/size.
  const [tilesHidden, setTilesHidden] = useState(false);

  const overlayRef = useRef(null);
  const dragRef = useRef(null);
  const resizeRef = useRef(null);

  function cycleLayout() {
    setLayout((prev) => LAYOUTS[(LAYOUTS.indexOf(prev) + 1) % LAYOUTS.length]);
    setPosition(null);
  }

  function toggleTilesHidden() {
    setTilesHidden((prev) => !prev);
  }

  function clampToBounds(pos) {
    const bounds = boundsRef?.current?.getBoundingClientRect();
    const overlay = overlayRef.current?.getBoundingClientRect();
    if (!bounds || !overlay) return pos;
    const maxX = Math.max(bounds.width - overlay.width, 0);
    const maxY = Math.max(bounds.height - overlay.height, 0);
    return {
      x: Math.min(Math.max(pos.x, 0), maxX),
      y: Math.min(Math.max(pos.y, 0), maxY),
    };
  }

  function handleDragPointerDown(event) {
    if (event.target.closest('button, select, .device-settings-panel')) return;
    // Only floating layouts can be dragged
    if (!layout.startsWith('floating')) return;

    const bounds = boundsRef?.current?.getBoundingClientRect();
    const overlay = overlayRef.current?.getBoundingClientRect();
    if (!bounds || !overlay) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startPos: position ?? { x: overlay.left - bounds.left, y: overlay.top - bounds.top },
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleDragPointerMove(event) {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    const dx = event.clientX - dragRef.current.startX;
    const dy = event.clientY - dragRef.current.startY;
    setPosition(
      clampToBounds({
        x: dragRef.current.startPos.x + dx,
        y: dragRef.current.startPos.y + dy,
      })
    );
  }

  function handleDragPointerUp(event) {
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  function handleResizePointerDown(event) {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startSize: tileSize,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleResizePointerMove(event) {
    if (!resizeRef.current || resizeRef.current.pointerId !== event.pointerId) return;
    const delta = event.clientX - resizeRef.current.startX + (event.clientY - resizeRef.current.startY);
    const next = Math.round(resizeRef.current.startSize + delta / 2);
    setTileSize(Math.min(MAX_TILE, Math.max(MIN_TILE, next)));
  }

  function handleResizePointerUp(event) {
    resizeRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  const positionStyle = position
    ? { left: `${position.x}px`, top: `${position.y}px`, right: 'auto', bottom: 'auto', transform: 'none' }
    : undefined;

  return (
    <div
      ref={overlayRef}
      className={`call-overlay call-overlay--${layout}${tilesHidden ? ' call-overlay--collapsed' : ''}`}
      style={{ ...positionStyle, '--tile-size': `${tileSize}px` }}
    >
      <div
        className="call-overlay-handle"
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        onPointerCancel={handleDragPointerUp}
      >
        <span className="call-overlay-grip" aria-hidden="true" />
        <span className="call-overlay-count">
          {participants.length} {participants.length === 1 ? 'person' : 'people'}
        </span>
        <div className="call-overlay-actions">
          <button type="button" onClick={onToggleMic} className={muted ? 'is-off' : ''}>
            {muted ? 'Unmute' : 'Mute'}
          </button>
          <button type="button" onClick={onToggleCamera} className={cameraOff ? 'is-off' : ''}>
            {cameraOff ? 'Cam on' : 'Cam off'}
          </button>
          <DeviceSettings
            compact
            devices={devices}
            selectedMicId={selectedMicId}
            selectedCameraId={selectedCameraId}
            selectedSpeakerId={selectedSpeakerId}
            speakerSupported={speakerSupported}
            onChangeMic={onChangeMic}
            onChangeCamera={onChangeCamera}
            onChangeSpeaker={onChangeSpeaker}
            deviceError={deviceError}
            onOpenChange={onDeviceSettingsOpenChange}
            onRequestPermission={onRequestPermission}
          />
          <button
            type="button"
            className="call-overlay-eye-btn"
            onClick={toggleTilesHidden}
            title={tilesHidden ? 'Show faces' : 'Hide faces'}
            aria-label={tilesHidden ? 'Show faces' : 'Hide faces'}
            aria-pressed={tilesHidden}
          >
            <EyeIcon off={tilesHidden} />
          </button>
          <button
            type="button"
            className="call-overlay-layout-btn"
            onClick={cycleLayout}
            title={`Layout: ${LAYOUT_LABELS[layout]} — click to change`}
          >
            ⬚
          </button>
        </div>
      </div>

      {!tilesHidden && (
        <div className="call-overlay-tiles">
          {participants.map((participant) => {
            const isYou = participant.id === you?.id;
            return (
              <ParticipantTile
                key={participant.id}
                name={participant.name}
                isYou={isYou}
                isHost={participant.id === hostId}
                muted={participant.muted}
                cameraOff={participant.cameraOff}
                stream={isYou ? localStream : remoteStreams[participant.id]}
                speakerId={selectedSpeakerId}
              />
            );
          })}
        </div>
      )}

      {!tilesHidden && (
        <div
          className="call-overlay-resize"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={handleResizePointerUp}
          onPointerCancel={handleResizePointerUp}
          title="Drag to resize"
          aria-hidden="true"
        />
      )}
    </div>
  );
}
