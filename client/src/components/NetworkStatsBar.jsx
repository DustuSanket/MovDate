function formatKbps(kbps) {
  if (!kbps || kbps <= 0) return '0 Kbps';
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(1)} Mbps`;
  return `${Math.round(kbps)} Kbps`;
}

function WifiIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 8.5c5.5-5 14.5-5 20 0" />
      <path d="M5 12.5c3.9-3.3 10.1-3.3 14 0" />
      <path d="M8.5 16.3c2.1-1.7 4.9-1.7 7 0" />
      <circle cx="12" cy="19.5" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20V8" />
      <path d="M7 13l5-5 5 5" />
      <path d="M4 20h16" />
    </svg>
  );
}

export default function NetworkStatsBar({ pingMs, downloadKbps, uploadKbps, hasPeers, showUpload }) {
  return (
    <div className="network-stats-bar" title="Live connection stats">
      <span className="network-stat" title="Ping (round-trip time)">
        <span className="network-stat-icon" aria-hidden="true"><WifiIcon /></span>
        <span className="network-stat-value">{hasPeers && pingMs != null ? `${pingMs} ms` : '-- ms'}</span>
      </span>
      <span className="network-stat" title="Download speed">
        <span className="network-stat-icon" aria-hidden="true"><DownloadIcon /></span>
        <span className="network-stat-value">{hasPeers ? formatKbps(downloadKbps) : '--'}</span>
      </span>
      {showUpload && (
        <span className="network-stat" title="Upload speed">
          <span className="network-stat-icon" aria-hidden="true"><UploadIcon /></span>
          <span className="network-stat-value">{hasPeers ? formatKbps(uploadKbps) : '--'}</span>
        </span>
      )}
    </div>
  );
}
