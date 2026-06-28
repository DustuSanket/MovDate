export default function MeetLayoutModal({ layoutMode, setLayoutMode, onClose }) {
  const layouts = [
    { id: 'auto', name: 'Auto (dynamic)', icon: '✨' },
    { id: 'grid', name: 'Tiled (legacy)', icon: '🔲' },
    { id: 'spotlight', name: 'Spotlight', icon: '🎯' },
    { id: 'showcase', name: 'Sidebar', icon: '📝' }
  ];

  return (
    <div className="settings-modal-overlay" onClick={onClose}>
      <div className="settings-modal-content meet-layout-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '400px', height: 'auto' }}>
        <div className="settings-modal-header">
          <h2>Adjust view</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="settings-modal-body" style={{ display: 'block', padding: '1.5rem', overflowY: 'auto' }}>
          <p className="layout-help-text" style={{ margin: '0 0 1.5rem', color: 'var(--color-text-muted)' }}>
            Selection is saved for future meetings
          </p>
          <div className="layout-options">
            {layouts.map((layout) => (
              <label 
                key={layout.id} 
                className={`layout-option ${layoutMode === layout.id ? 'is-selected' : ''}`}
              >
                <div className="layout-option-left">
                  <input
                    type="radio"
                    name="layout"
                    value={layout.id}
                    checked={layoutMode === layout.id}
                    onChange={(e) => setLayoutMode(e.target.value)}
                  />
                  <span>{layout.name}</span>
                </div>
                <div className="layout-option-icon">{layout.icon}</div>
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
