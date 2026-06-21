import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

function extractRoomId(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/\/room\/([^/?#]+)/);
  return match ? match[1] : trimmed;
}

export default function Home() {
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [protectedRoom, setProtectedRoom] = useState(false);
  const navigate = useNavigate();

  function handleCreate(event) {
    event.preventDefault();
    if (!name.trim()) return;
    const roomId = generateRoomId();
    navigate(`/room/${roomId}`, { state: { name: name.trim(), protected: protectedRoom } });
  }

  function handleJoin(event) {
    event.preventDefault();
    if (!name.trim() || !joinCode.trim()) return;
    const roomId = extractRoomId(joinCode);
    navigate(`/room/${roomId}`, { state: { name: name.trim() } });
  }

  return (
    <div className="home">
      <div className="film-strip" aria-hidden="true" />

      <header className="home-header">
        <div className="home-logo">
          <img src="/logo.png" alt="MovDate logo" />
          <span className="logo-mark">MovDate</span>
        </div>
        <p className="tagline">Your virtual movie date — press play together 🍿</p>
      </header>

      <main className="home-cards">
        <form className="home-card" onSubmit={handleCreate}>
          <h2>🎬 Start a date</h2>
          <p>Create a room, share the link, and pick what you watch once everyone's in.</p>

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
          <h2>💌 Join a date</h2>
          <p>Got a link or room code from someone special? Drop it in here.</p>

          <label htmlFor="join-name">Your name</label>
          <input
            id="join-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Priya"
            required
          />

          <label htmlFor="join-code">Room link or code</label>
          <input
            id="join-code"
            value={joinCode}
            onChange={(event) => setJoinCode(event.target.value)}
            placeholder="movdate.app/room/ab12cd or ab12cd"
            required
          />

          <button type="submit">Join room 💕</button>
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
    </div>
  );
}
