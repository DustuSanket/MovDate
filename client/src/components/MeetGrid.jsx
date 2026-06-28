import React, { useMemo } from 'react';
import MeetTile from './MeetTile.jsx';
import FloatingLocalTile from './FloatingLocalTile.jsx';

export default function MeetGrid({
  participants,
  you,
  hostId,
  localStream,
  screenStream,
  remoteStreams,
  speakerId,
  pinnedTrack, // currently single pinned for simplicity
  setPinnedTrack,
  layoutMode,
  localMicOff,
  localCameraOff
}) {
  // Flatten all available streams into "tiles"
  const tiles = useMemo(() => {
    const list = [];
    
    // 1. Local user
    list.push({
      id: you?.id || 'local',
      peerId: you?.id || 'local',
      name: you?.name || 'You',
      isYou: true,
      isHost: you?.id === hostId,
      stream: localStream,
      playbackMuted: true, // We mute our own local video tile to avoid echo
      muted: localMicOff,
      cameraOff: localCameraOff,
      isScreen: false
    });

    if (screenStream) {
      list.push({
        id: (you?.id || 'local') + '-screen',
        peerId: you?.id || 'local',
        name: (you?.name || 'You') + "'s Screen",
        isYou: true,
        isHost: you?.id === hostId,
        stream: screenStream,
        muted: true,
        cameraOff: false,
        isScreen: true
      });
    }

    // 2. Remote participants
    participants.filter(p => p.id !== (you?.id || 'local')).forEach((p) => {
      const pStreams = remoteStreams[p.id] || [];
      
      if (pStreams.length === 0) {
        // No streams yet, add a placeholder tile
        list.push({
          id: p.id,
          peerId: p.id,
          name: p.name,
          isYou: false,
          isHost: p.id === hostId,
          stream: null,
          muted: p.muted,
          cameraOff: p.cameraOff,
          isScreen: false
        });
      } else {
        // Multiple streams (e.g., camera + screen share)
        pStreams.forEach((stream, index) => {
          // A very simple heuristic: if it has no audio but has video, it might be a screen share.
          // Or if it's the second stream, assume it's a screen share.
          const isScreen = index > 0;
          list.push({
            id: p.id + '-' + index,
            peerId: p.id,
            name: isScreen ? p.name + "'s Screen" : p.name,
            isYou: false,
            isHost: p.id === hostId,
            stream: stream,
            muted: p.muted, // if screen share, we might want to mute the video element, but WebRTC streams handle audio natively
            cameraOff: isScreen ? false : p.cameraOff,
            isScreen: isScreen
          });
        });
      }
    });

    return list;
  }, [participants, you, hostId, localStream, screenStream, remoteStreams]);

  // Handle pinning logic
  let renderTiles = tiles;
  let pinnedTiles = [];
  
  if (pinnedTrack) {
    pinnedTiles = tiles.filter(t => t.id === pinnedTrack);
    renderTiles = tiles.filter(t => t.id !== pinnedTrack);
  } else if (layoutMode === 'showcase' || layoutMode === 'spotlight' || layoutMode === 'auto') {
    // Auto defaults to grid unless there's a screen share, then it acts like showcase
    const hasScreen = tiles.find(t => t.isScreen);
    if (layoutMode !== 'auto' || hasScreen) {
      const target = hasScreen || tiles.find(t => !t.isYou && !t.cameraOff) || tiles[0];
      if (target) {
        pinnedTiles = [target];
        renderTiles = tiles.filter(t => t.id !== target.id);
      }
    }
  }

  // If spotlight, we hide the filmstrip completely
  const isSpotlight = layoutMode === 'spotlight' || (layoutMode === 'auto' && pinnedTiles.length > 0 && renderTiles.length === 0);
  const isShowcase = pinnedTiles.length > 0 && !isSpotlight;

  let floatingLocalTileProps = null;
  if (!isShowcase && tiles.length > 1) {
    const localIdx = renderTiles.findIndex(t => t.isYou && !t.isScreen);
    if (localIdx !== -1) {
      floatingLocalTileProps = renderTiles[localIdx];
      renderTiles = renderTiles.filter((_, i) => i !== localIdx);
    }
  }

  return (
    <div className={`meet-grid-layout ${isShowcase ? 'is-showcase' : isSpotlight ? 'is-spotlight' : 'is-grid'}`}>
      {(isShowcase || isSpotlight) && (
        <div className="meet-showcase-area">
          {pinnedTiles.map((tile) => (
            <MeetTile
              key={tile.id}
              {...tile}
              speakerId={speakerId}
              isPinned={true}
              onTogglePin={() => setPinnedTrack(null)}
            />
          ))}
        </div>
      )}
      
      {!isSpotlight && (
        <div className="meet-filmstrip">
          {renderTiles.map((tile) => (
            <MeetTile
              key={tile.id}
              {...tile}
              speakerId={speakerId}
              isPinned={false}
              onTogglePin={() => setPinnedTrack(tile.id)}
            />
          ))}
        </div>
      )}

      {floatingLocalTileProps && (
        <FloatingLocalTile tileProps={floatingLocalTileProps} />
      )}
    </div>
  );
}
