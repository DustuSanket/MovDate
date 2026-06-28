import { useState } from 'react';

export default function InviteBar({ roomId }) {
  const [copied, setCopied] = useState(false);
  const link = window.location.href;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be blocked on insecure (non-HTTPS) origins; the room
      // code is still shown so people can copy it manually.
    }
  }

  return (
    <div className="invite-bar">
      <span className="invite-label">Room {roomId}</span>
      <button type="button" onClick={handleCopy}>
        {copied ? 'Link copied' : 'Copy invite link'}
      </button>
    </div>
  );
}
