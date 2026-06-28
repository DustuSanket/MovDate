import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useEffect } from 'react';

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

function extractRoomId(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/\/(?:room|meet)\/([^/?#]+)/);
  return match ? match[1] : trimmed;
}

export default function Home() {
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [protectedRoom, setProtectedRoom] = useState(false);
  const [mode, setMode] = useState('date'); // 'date' | 'meet'
  const navigate = useNavigate();
  const location = useLocation();
  const [errorModal, setErrorModal] = useState(null);

  // Capture the error from navigation state and clear it from history
  // so it doesn't pop up again if the user refreshes the page.
  useEffect(() => {
    if (location.state?.error) {
      setErrorModal(location.state.error);
      navigate('.', { replace: true, state: {} });
    }
  }, [location.state, navigate]);

  function handleCreate(event) {
    event.preventDefault();
    if (!name.trim()) return;
    const roomId = generateRoomId();
    const route = mode === 'meet' ? 'meet' : 'room';
    navigate(`/${route}/${roomId}`, { state: { name: name.trim(), protected: protectedRoom, isCreating: true } });
  }

  function handleJoin(event) {
    event.preventDefault();
    if (!name.trim() || !joinCode.trim()) return;
    const roomId = extractRoomId(joinCode);
    const route = mode === 'meet' ? 'meet' : 'room';
    navigate(`/${route}/${roomId}`, { state: { name: name.trim() } });
  }

  return (
    <div className={`home ${mode === 'meet' ? 'theme-meet' : ''}`}>
      <div className="film-strip" aria-hidden="true" />

      <header className="home-header">
        <div className="home-logo">
          <img src="/logo.png" alt="MovDate logo" />
          <span className="logo-mark">MovDate</span>
        </div>
        <p className="tagline">
          {mode === 'date' 
            ? 'Your virtual movie date — press play together 🍿' 
            : 'Your simple, private video meetings 📡'}
        </p>
      </header>

      <div className="mode-toggle-wrapper">
        <div className="mode-toggle">
          <button 
            type="button" 
            className={`mode-btn ${mode === 'date' ? 'is-active' : ''}`}
            onClick={() => setMode('date')}
          >
            Date 💘
          </button>
          <button 
            type="button" 
            className={`mode-btn ${mode === 'meet' ? 'is-active' : ''}`}
            onClick={() => setMode('meet')}
          >
            Meet 📡
          </button>
        </div>
      </div>

      <main className="home-cards">
        <form className="home-card" onSubmit={handleCreate}>
          <h2>{mode === 'date' ? '🎬 Start a date' : '📡 Start a meeting'}</h2>
          <p>
            {mode === 'date' 
              ? "Create a room, share the link, and pick what you watch once everyone's in."
              : "Create a meeting, share the link, and talk or share your screen."}
          </p>
          <p className="participant-limit-info">
            <small>ℹ️ Recommended max: 6-8 participants for best performance.</small>
          </p>

          <label htmlFor="create-name">Your name</label>
          <input
            id="create-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Priya"
            required
          />

          <label className="toggle-label" htmlFor="protected-toggle">
            <span className="toggle-label-text">
              🔒 Protected room
              <span className="toggle-hint">Participants wait for your approval before joining</span>
            </span>
            <span className={`toggle-switch${protectedRoom ? ' toggle-switch--on' : ''}`}>
              <input
                id="protected-toggle"
                type="checkbox"
                checked={protectedRoom}
                onChange={(e) => setProtectedRoom(e.target.checked)}
                className="toggle-input"
              />
              <span className="toggle-knob" />
            </span>
          </label>

          <button type="submit">Create room ✨</button>
        </form>

        <form className="home-card" onSubmit={handleJoin}>
          <h2>{mode === 'date' ? '🎫 Join a date' : '🎫 Join a meeting'}</h2>
          <p>Enter a code or link provided by the host.</p>
          <p className="participant-limit-info">
            <small>ℹ️ Recommended max: 6-8 participants for best performance.</small>
          </p>

          <label htmlFor="join-name">Your name</label>
          <input
            id="join-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Priya"
            required
          />

          <label htmlFor="join-code">{mode === 'date' ? 'Room link or code' : 'Meeting link or code'}</label>
          <input
            id="join-code"
            value={joinCode}
            onChange={(event) => setJoinCode(event.target.value)}
            placeholder={mode === 'date' ? "movdate.app/room/ab12cd or ab12cd" : "movdate.app/meet/ab12cd or ab12cd"}
            required
          />

          <button type="submit">{mode === 'date' ? 'Join room 💖' : 'Join meeting 🚀'}</button>
        </form>
      </main>

      <footer className="home-footer">
        <p>
          Works best with YouTube links and direct video files. DRM-protected streaming sites
          (Netflix, Disney+, Prime Video, etc.) can't be embedded — that's a platform restriction,
          not a MovDate one.
        </p>
      </footer>

      <div className="film-strip" aria-hidden="true" />

      {errorModal && (
        <div className="error-modal-overlay">
          <div className="error-modal">
            <button 
              className="close-btn" 
              onClick={() => setErrorModal(null)}
              aria-label="Close"
            >
              ×
            </button>
            <h2>Couldn't join</h2>
            <p>{errorModal}</p>
          </div>
        </div>
      )}
    </div>
  );
}
