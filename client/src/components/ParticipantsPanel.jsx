import React, { useState, useEffect, useRef } from 'react';

export default function ParticipantsPanel({
  participants,
  you,
  hostId,
  isHost,
  onClose,
  onPin,
  onKick,
  onForceMute,
  onForceCameraOff
}) {
  const [openMenuId, setOpenMenuId] = useState(null);
  const menuRef = useRef(null);

  // Close dropdown if clicked outside
  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpenMenuId(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const allUsers = [
    { ...you, isYou: true },
    ...participants.filter(p => p.id !== you?.id).map(p => ({ ...p, isYou: false }))
  ];

  return (
    <div className="sidebar-panel participants-panel">
      <div className="sidebar-header">
        <h2>People ({allUsers.length})</h2>
        <button className="close-btn" onClick={onClose}>✕</button>
      </div>

      <div className="sidebar-content">
        <ul className="participants-list">
          {allUsers.map(user => {
            const isTargetHost = user.id === hostId;
            const menuOpen = openMenuId === user.id;

            return (
              <li key={user.id} className="participant-item">
                <div className="participant-info">
                  <div className="participant-avatar">
                    {user.name ? user.name[0].toUpperCase() : '?'}
                  </div>
                  <div className="participant-details">
                    <span className="participant-name">
                      {user.name} {user.isYou && '(You)'}
                    </span>
                    {isTargetHost && <span className="host-badge">Host</span>}
                  </div>
                </div>

                <div className="participant-actions">
                  <span className="media-status" title={user.muted ? "Muted" : "Mic On"}>
                    {user.muted ? '🔇' : '🎙️'}
                  </span>
                  <span className="media-status" title={user.cameraOff ? "Camera Off" : "Camera On"}>
                    {user.cameraOff ? '🚫' : '📸'}
                  </span>

                  {/* 3-dots Menu Button */}
                  <div className="menu-container" ref={menuOpen ? menuRef : null}>
                    <button 
                      className="more-options-btn" 
                      onClick={() => setOpenMenuId(menuOpen ? null : user.id)}
                    >
                      ⋮
                    </button>
                    
                    {menuOpen && (
                      <div className="dropdown-menu">
                        <button onClick={() => { onPin(user.id); setOpenMenuId(null); }}>
                          📌 Pin to screen
                        </button>
                        
                        {isHost && !user.isYou && (
                          <>
                            <hr />
                            <button onClick={() => { onForceMute(user.id); setOpenMenuId(null); }}>
                              🔇 Mute microphone
                            </button>
                            <button onClick={() => { onForceCameraOff(user.id); setOpenMenuId(null); }}>
                              🚫 Stop video
                            </button>
                            <button className="danger" onClick={() => { onKick(user.id); setOpenMenuId(null); }}>
                              🚪 Remove from call
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
