import React, { useState, useEffect, useRef } from 'react';
import MeetTile from './MeetTile.jsx';

export default function FloatingLocalTile({ tileProps }) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  
  // Start positioned bottom-right
  const [pos, setPos] = useState({ 
    x: window.innerWidth - 320, 
    y: window.innerHeight - (300 * (9/16)) - 100 
  });
  const [width, setWidth] = useState(300);
  const containerRef = useRef(null);

  // Keep inside bounds on resize
  useEffect(() => {
    const handleWindowResize = () => {
      setPos(prev => ({
        x: Math.max(0, Math.min(prev.x, window.innerWidth - width)),
        y: Math.max(0, Math.min(prev.y, window.innerHeight - (containerRef.current?.clientHeight || 0)))
      }));
    };
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, [width]);

  const handleDragStart = (e) => {
    // Only drag from header background, not buttons
    if (e.target.closest('button')) return;
    
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startPosX = pos.x;
    const startPosY = pos.y;

    const handleMove = (moveEvent) => {
      setPos({
        x: Math.max(0, Math.min(startPosX + moveEvent.clientX - startX, window.innerWidth - width)),
        y: Math.max(0, Math.min(startPosY + moveEvent.clientY - startY, window.innerHeight - (containerRef.current?.clientHeight || 0)))
      });
    };

    const handleUp = () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
  };

  const isLeft = pos.x + width / 2 < window.innerWidth / 2;
  const isTop = pos.y + (containerRef.current?.clientHeight || 0) / 2 < window.innerHeight / 2;
  
  // Determine resize handle location (opposite of the quadrant it resides in)
  // e.g. if Top-Right quadrant (!isLeft, isTop), handle is Bottom-Left
  const handleProps = {
    bottom: isTop ? 0 : 'auto',
    top: !isTop ? 0 : 'auto',
    right: isLeft ? 0 : 'auto',
    left: !isLeft ? 0 : 'auto',
    cursor: (isTop === isLeft) ? 'nwse-resize' : 'nesw-resize'
  };

  const handleResizeStart = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = width;
    const startPosX = pos.x;
    const startPosY = pos.y;
    const aspectRatio = containerRef.current?.clientHeight / width || (9/16);

    const handleMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      
      let newWidth = startWidth;
      let newX = startPosX;
      let newY = startPosY;

      // Handle is on the Right
      if (isLeft) {
        newWidth = Math.max(150, Math.min(600, startWidth + dx));
      } else {
        // Handle is on the Left
        newWidth = Math.max(150, Math.min(600, startWidth - dx));
        newX = startPosX + (startWidth - newWidth);
      }

      // Maintain opposite corner's Y position
      if (!isTop) {
        // Handle is on Top, increasing width means increasing height, pushing Y UP
        const oldHeight = startWidth * aspectRatio;
        const newHeight = newWidth * aspectRatio;
        newY = startPosY + (oldHeight - newHeight);
      }

      // Constrain X to window
      if (newX < 0) {
        newWidth += newX;
        newX = 0;
      } else if (newX + newWidth > window.innerWidth) {
        newWidth = window.innerWidth - newX;
      }
      
      // Constrain Y to window
      if (newY < 0) {
        const diff = 0 - newY;
        newWidth -= diff / aspectRatio;
        newY = 0;
        if (!isLeft) newX = startPosX + (startWidth - newWidth);
      } else if (newY + newWidth * aspectRatio > window.innerHeight) {
        newWidth = (window.innerHeight - newY) / aspectRatio;
        if (!isLeft) newX = startPosX + (startWidth - newWidth);
      }

      setWidth(newWidth);
      setPos({ x: newX, y: newY });
    };

    const handleUp = () => {
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
    };

    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
  };

  if (isCollapsed) {
    return (
      <div 
        className="floating-local-tile is-collapsed"
        style={{ left: pos.x, top: pos.y }}
        onClick={() => setIsCollapsed(false)}
        title="Show my camera"
      >
        <span className="floating-collapse-icon">📷</span>
      </div>
    );
  }

  return (
    <div 
      className="floating-local-tile is-expanded"
      style={{ left: pos.x, top: pos.y, width: width }}
      ref={containerRef}
    >
      <div className="floating-tile-header" onPointerDown={handleDragStart}>
        <span className="floating-tile-title">You</span>
        <button 
          className="floating-collapse-btn" 
          onClick={(e) => { e.stopPropagation(); setIsCollapsed(true); }}
          title="Minimize camera"
        >
          _
        </button>
      </div>
      
      <div className="floating-tile-content">
        <MeetTile {...tileProps} />
      </div>

      <div 
        className="floating-resize-handle"
        style={{ 
          top: handleProps.top, 
          bottom: handleProps.bottom, 
          left: handleProps.left, 
          right: handleProps.right, 
          cursor: handleProps.cursor 
        }}
        onPointerDown={handleResizeStart}
      />
    </div>
  );
}
