/**
 * LocalFilePrompt
 *
 * Shown to participants when the host plays a local file.
 * Two paths:
 *   1. "Load my own copy" — instant, full quality
 *   2. "Stream from host" — P2P DataChannel download; shows progress bar,
 *      then auto-dismisses when ready
 *
 * Also renders a persistent "Switch source" button after a choice is made,
 * so participants can change their mind at any time.
 */
export default function LocalFilePrompt({
  fileName,
  onPickFile,
  onUseStream,
  streamReady,
  streamError,
  streamProgress,   // 0–100
  wantStream,       // true if user chose "Stream from host"
  dismissed,
}) {
  const isStreaming = wantStream && !streamReady;

  function handleFilePick(event) {
    const file = event.target.files?.[0];
    if (file) onPickFile(file);
    event.target.value = '';
  }

  if (dismissed) return null;

  return (
    <div className="local-prompt-backdrop">
      <div className="local-prompt-modal" role="dialog" aria-modal="true">
        <div className="local-prompt-icon">🎬</div>
        <h2 className="local-prompt-title">Host is playing a local file</h2>
        <p className="local-prompt-filename">
          <span className="local-prompt-label">File:</span> {fileName}
        </p>

        {/* Show progress bar while streaming */}
        {isStreaming && (
          <div className="local-prompt-progress-wrap">
            {streamProgress > 0 ? (
              <>
                <div className="local-prompt-progress-bar">
                  <div
                    className="local-prompt-progress-fill"
                    style={{ width: `${streamProgress}%` }}
                  />
                </div>
                <span className="local-prompt-progress-label">
                  Receiving from host… {streamProgress}%
                </span>
              </>
            ) : (
              <div className="local-prompt-connecting">
                <div className="waiting-spinner" aria-hidden="true" style={{ width: '24px', height: '24px', borderWidth: '2px', borderTopColor: 'var(--color-rose)' }} />
                <span className="local-prompt-progress-label">Connecting to host...</span>
              </div>
            )}
          </div>
        )}

        {streamReady && (
          <p className="local-prompt-ready">
            ✅ Stream ready! Starting playback…
          </p>
        )}

        {streamError && (
          <p className="local-prompt-error">{streamError}</p>
        )}

        {/* Only show options if not already streaming */}
        {!isStreaming && !streamReady && (
          <>
            <p className="local-prompt-desc">Choose how you want to watch:</p>
            <div className="local-prompt-options">
              {/* Option 1: own copy */}
              <label className="local-prompt-option local-prompt-option--pick">
                <input
                  type="file"
                  accept="video/*,.mp4,.webm,.mkv,.mov,.avi,.m4v"
                  style={{ display: 'none' }}
                  onChange={handleFilePick}
                />
                <div className="local-prompt-option-icon">📁</div>
                <div className="local-prompt-option-text">
                  <strong>Load my own copy</strong>
                  <span>Pick the same file from your device — instant, best quality</span>
                </div>
              </label>

              {/* Option 2: P2P stream */}
              <button
                type="button"
                className="local-prompt-option local-prompt-option--stream"
                onClick={onUseStream}
              >
                <div className="local-prompt-option-icon">📡</div>
                <div className="local-prompt-option-text">
                  <strong>Stream from host</strong>
                  <span>Downloads peer-to-peer · playback starts when ready · may take a moment</span>
                </div>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
