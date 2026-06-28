import React, { useState } from 'react';

export default function MeetTopBar({ roomId }) {
  const [copied, setCopied] = useState(false);

  function copyLink() {
    const url = `${window.location.origin}/meet/${roomId}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="meet-top-bar">
      <div className="meet-top-bar-left">
        <span className="meet-room-id">Meeting code: {roomId}</span>
        <button className="copy-link-btn" onClick={copyLink}>
          {copied ? '✓ Copied' : '🔗 Copy link'}
        </button>
      </div>

      <div className="meet-top-bar-right">
      </div>
    </div>
  );
}
