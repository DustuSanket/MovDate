import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { loadYouTubeAPI } from '../lib/youtubeLoader.js';

const VideoPlayer = forwardRef(function VideoPlayer(
  { source, onAutoplayBlocked, onAutoplaySuccess, onMutedAutoplay, onPlaybackError, isHost, onHostPlayPause },
  ref
) {
  const containerRef = useRef(null);
  const ytPlayerRef = useRef(null);
  const fileVideoRef = useRef(null);
  const readyRef = useRef(false);
  const pendingRef = useRef(null);
  const hasPlayedRef = useRef(false);
  const [isBuffering, setIsBuffering] = useState(false);

  // ── Embed sync helpers ──────────────────────────────────────────────
  // Generic <iframe> embeds (tpead.net, etc.) don't expose a postMessage
  // API, so we can't actually press play/pause/seek inside them. Instead
  // we surface the host's action as a synced countdown/banner so everyone
  // presses play at roughly the same moment, or knows to pause/seek
  // themselves to match.
  const [embedCountdown, setEmbedCountdown] = useState(null);
  const [embedBanner, setEmbedBanner] = useState(null);
  const embedCountdownTimerRef = useRef(null);
  const embedBannerTimerRef = useRef(null);

  function formatTime(t) {
    const total = Math.max(0, Math.floor(t || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function runEmbedCountdown() {
    setEmbedBanner(null);
    if (embedBannerTimerRef.current) clearTimeout(embedBannerTimerRef.current);
    if (embedCountdownTimerRef.current) clearInterval(embedCountdownTimerRef.current);
    let n = 3;
    setEmbedCountdown(n);
    embedCountdownTimerRef.current = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        clearInterval(embedCountdownTimerRef.current);
        embedCountdownTimerRef.current = null;
        setEmbedCountdown(null);
      } else {
        setEmbedCountdown(n);
      }
    }, 1000);
  }

  function showEmbedBanner(text, ms = 4000) {
    if (embedCountdownTimerRef.current) {
      clearInterval(embedCountdownTimerRef.current);
      embedCountdownTimerRef.current = null;
      setEmbedCountdown(null);
    }
    setEmbedBanner(text);
    if (embedBannerTimerRef.current) clearTimeout(embedBannerTimerRef.current);
    embedBannerTimerRef.current = setTimeout(() => setEmbedBanner(null), ms);
  }

  useEffect(() => {
    return () => {
      if (embedCountdownTimerRef.current) clearInterval(embedCountdownTimerRef.current);
      if (embedBannerTimerRef.current) clearTimeout(embedBannerTimerRef.current);
    };
  }, []);

  // Reset embed sync UI whenever the source itself changes (new link loaded).
  useEffect(() => {
    setEmbedCountdown(null);
    setEmbedBanner(null);
    if (embedCountdownTimerRef.current) clearInterval(embedCountdownTimerRef.current);
    if (embedBannerTimerRef.current) clearTimeout(embedBannerTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.type, source?.url]);

  // Guards against transient null source during source transitions.
  // When the host switches from YouTube to local file (or vice versa),
  // the source prop can briefly flash to null before the new value is set.
  // This ref keeps the last valid source to prevent a jarring flash of
  // the "No video loaded" placeholder and an accidental onError call
  // from a revoked blob URL.
  const lastSourceRef = useRef(null);
  const sourceTransitionRef = useRef(false);
  if (source) {
    lastSourceRef.current = source;
    sourceTransitionRef.current = false;
  } else if (lastSourceRef.current) {
    // Source went null but we had something before — likely a transition
    sourceTransitionRef.current = true;
  }

  // Tracks the last authoritative state so non-hosts can snap back
  const authoritativeRef = useRef({ kind: 'pause', time: 0 });

  // Set to true RIGHT BEFORE we call playVideo/pauseVideo/seekTo ourselves.
  // onStateChange checks this to know "we caused this, don't react to it".
  //
  // This is a GRACE WINDOW, not a single-use flag. A single programmatic call
  // (e.g. seekTo + pauseVideo back to back) can fire several onStateChange
  // events as YouTube settles — typically BUFFERING before landing on the
  // real PLAYING/PAUSED state. If we cleared this flag on the *first* event
  // we saw, that first (transient) event would consume it, and the *real*
  // settling event right behind it would be misread as a fresh user action.
  // For a host that meant a duplicate play/pause got emitted to the server,
  // which the rest of the room then had to re-apply on top of an already-
  // correct state — the seek-then-resync stutter people see as "glitching".
  // A timed window absorbs the whole burst instead of just the first event.
  const programmaticRef = useRef(false);
  const programmaticTimerRef = useRef(null);

  function markProgrammatic(ms = 600) {
    programmaticRef.current = true;
    if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
    programmaticTimerRef.current = setTimeout(() => {
      programmaticRef.current = false;
    }, ms);
  }

  function clearProgrammatic() {
    if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
    programmaticRef.current = false;
  }

  // When the host clicks directly on the embedded YouTube player, the click
  // also moves keyboard focus into that (cross-origin) iframe. Once that
  // happens, arrow-key presses go to YouTube's document, not ours, and our
  // own keyboard shortcuts (10s skip) silently stop working — they're not
  // blocked or glitched, they just never arrive. Handing focus straight back
  // to the page keeps "click the video to pause" and "use the arrow keys"
  // from stepping on each other.
  function returnFocusToPage() {
    requestAnimationFrame(() => {
      if (document.activeElement?.tagName === 'IFRAME') {
        document.activeElement.blur();
      }
    });
  }

  // Keep stable refs to props used inside callbacks
  const isHostRef = useRef(isHost);
  const onHostPlayPauseRef = useRef(onHostPlayPause);
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);
  useEffect(() => { onHostPlayPauseRef.current = onHostPlayPause; }, [onHostPlayPause]);

  function applyToYT(kind, time) {
    const yt = ytPlayerRef.current;
    if (!yt) return;

    markProgrammatic(); // mark as our own action before touching the player

    if (kind !== 'play' && !hasPlayedRef.current && typeof time === 'number') {
      yt.cueVideoById({ videoId: source.id, startSeconds: time });
      // cueVideoById doesn't reliably trigger onStateChange the way play/pause/
      // seek do, so there's nothing for the grace window to absorb — clear it
      // immediately instead of leaving it armed for the next real event.
      clearProgrammatic();
      return;
    }

    if (typeof time === 'number') yt.seekTo(time, true);
    if (kind === 'play') {
      yt.playVideo();
      hasPlayedRef.current = true;
    }
    if (kind === 'pause') {
      yt.pauseVideo();
    }
    // flag clears itself once the grace window elapses, after the player settles
  }

  function applyAction(action) {
    if (!action) return;
    const { kind, time } = action;
    if (source?.type === 'youtube') {
      applyToYT(kind, time);
    } else if (source?.type === 'embed') {
      // No control surface into the iframe — surface the host's action as
      // shared UI instead of trying (and failing) to drive the player.
      if (kind === 'play') {
        runEmbedCountdown();
      } else if (kind === 'pause') {
        showEmbedBanner('⏸ Host paused — pause yours too');
      } else if (kind === 'seek') {
        showEmbedBanner(`⏩ Host jumped to ${formatTime(time)} — seek yours to match`);
      }
    } else {
      const el = fileVideoRef.current;
      if (!el) return;

      // Mark this as our own programmatic call BEFORE touching the element.
      // The "lock out non-hosts" effect below listens for native play/pause/
      // seeking events to snap back anything a participant triggers directly
      // (e.g. OS media keys) — but el.play()/el.pause()/setting currentTime
      // fire those exact same native events themselves. Without this flag,
      // the lockout listener can't tell "the user did something" apart from
      // "we just called play() to apply a sync event", and immediately
      // pauses the video we just started — which interrupts (and rejects)
      // the in-flight play() promise with AbortError. That rejection lands
      // in the catch below and looks identical to a real autoplay block, so
      // every legitimate sync-driven play was self-aborting and showing the
      // "browser blocked autoplay" banner even though the browser never
      // actually blocked anything.
      markProgrammatic();

      if (typeof time === 'number') el.currentTime = time;
      if (kind === 'play') {
        el.play().then(() => {
          onAutoplaySuccess?.();
        }).catch((err1) => {
          if (err1.name !== 'NotAllowedError') return;
          markProgrammatic();
          el.muted = true;
          el.play()
            .then(() => onMutedAutoplay?.())
            .catch((err2) => {
              if (err2.name === 'NotAllowedError') onAutoplayBlocked?.();
            });
        });
      }
      if (kind === 'pause') el.pause();
    }
  }

  function getExpectedTime() {
    const { kind, time, updatedAt } = authoritativeRef.current;
    if (kind === 'play' && updatedAt) {
      return time + (Date.now() - updatedAt) / 1000;
    }
    return time ?? 0;
  }

  function dispatch(kind, time) {
    authoritativeRef.current = { 
      kind: kind === 'seek' ? authoritativeRef.current.kind || 'pause' : kind, 
      time: time ?? 0, 
      updatedAt: Date.now() 
    };
    const action = { kind, time };
    if (readyRef.current) {
      applyAction(action);
    } else {
      pendingRef.current = action;
    }
  }

  function flushPending() {
    readyRef.current = true;
    if (pendingRef.current) {
      applyAction(pendingRef.current);
      pendingRef.current = null;
    }
  }

  useImperativeHandle(ref, () => ({
    playAt(time)       { dispatch('play',  time); },
    pauseAt(time)      { dispatch('pause', time); },
    seekTo(time)       { dispatch('seek',  time); },
    resumeLocal()      {
      const { kind } = authoritativeRef.current;
      const expectedTime = getExpectedTime();
      applyAction({ kind, time: expectedTime });
    },
    unmute()           {
      if (source?.type === 'youtube') {
        ytPlayerRef.current?.unMute?.();
      } else if (fileVideoRef.current) {
        fileVideoRef.current.muted = false;
      }
    },
    setVolume(vol)     {
      if (source?.type === 'youtube') {
        ytPlayerRef.current?.setVolume?.(vol);
      } else if (fileVideoRef.current) {
        fileVideoRef.current.volume = Math.max(0, Math.min(100, vol)) / 100;
      }
    },
    getCurrentTime()   {
      if (source?.type === 'youtube') return ytPlayerRef.current?.getCurrentTime?.() ?? 0;
      return fileVideoRef.current?.currentTime ?? 0;
    },
    getDuration()      {
      if (source?.type === 'youtube') return ytPlayerRef.current?.getDuration?.() ?? 0;
      return fileVideoRef.current?.duration ?? 0;
    },
  }));

  // ── YouTube setup ──────────────────────────────────────────────────
  useEffect(() => {
    readyRef.current    = false;
    pendingRef.current  = null;
    hasPlayedRef.current = false;
    authoritativeRef.current = { kind: 'pause', time: 0 };
    clearProgrammatic();

    if (source?.type !== 'youtube') return undefined;

    let cancelled = false;

    loadYouTubeAPI().then((YT) => {
      if (cancelled || !containerRef.current) return;

      const player = new YT.Player(containerRef.current, {
        videoId: source.id,
        playerVars: {
          autoplay:       0,
          controls:       0,
          modestbranding: 1,
          rel:            0,
          playsinline:    1,
          disablekb:      1,
        },
        events: {
          onReady: flushPending,
          onStateChange(event) {
            try {
              // Was this change caused by our own applyToYT call? If so, it's
              // still within the grace window — ignore it and let the timer
              // (not this handler) decide when we're done suppressing. See the
              // comment on programmaticRef above for why we don't clear it here.
              if (programmaticRef.current) {
                return;
              }

              // Only PLAYING/PAUSED are meaningful play/pause transitions.
              // BUFFERING, CUED, UNSTARTED, ENDED are noise we don't act on —
              // reacting to them was the other half of the duplicate-event bug.
              const { PLAYING, PAUSED, BUFFERING } = YT.PlayerState;
              
              if (event.data === BUFFERING) setIsBuffering(true);
              if (event.data === PLAYING || event.data === PAUSED) setIsBuffering(false);

              if (event.data !== PLAYING && event.data !== PAUSED) {
                return;
              }

              if (isHostRef.current) {
                // Host clicked the video directly — treat it like a real
                // play/pause and notify Room so it can emit to the server +
                // update state, exactly like pressing the website's button.
                const currentTime = player.getCurrentTime() ?? 0;
                const kind = event.data === PLAYING ? 'play' : 'pause';
                // Update authoritative so future reverts are correct
                authoritativeRef.current = { kind, time: currentTime, updatedAt: Date.now() };
                hasPlayedRef.current = true;
                onHostPlayPauseRef.current?.({ kind, time: currentTime });
                // Clicking the iframe stole keyboard focus — give it back so
                // arrow-key seek shortcuts keep working immediately after.
                returnFocusToPage();
              } else {
                // Non-host triggered a change — snap back to authoritative state
                const { kind } = authoritativeRef.current;
                const expectedTime = getExpectedTime();
                markProgrammatic();
                setTimeout(() => applyAction({ kind, time: expectedTime }), 50);
              }
            } catch (err) {
              console.error('YT onStateChange error', err);
            }
          },
        },
      });

      ytPlayerRef.current = player;
    });

    return () => {
      cancelled = true;
      if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
      try {
        ytPlayerRef.current?.destroy?.();
      } catch (e) {
        console.error('YT destroy error', e);
      }
      ytPlayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.type, source?.id]);

  // ── <video> file: lock out non-hosts ──────────────────────────────
  useEffect(() => {
    const el = fileVideoRef.current;
    if (!el || source?.type !== 'file') return;

    // Fresh video, fresh attempt at unmuted autoplay — don't carry over a
    // mute flag set by the muted-autoplay fallback for a previous file.
    el.muted = false;

    function handlePlay() {
      if (programmaticRef.current) return; // our own dispatch() call, not a real direct interaction
      if (!isHostRef.current) {
        el.pause();
        el.currentTime = authoritativeRef.current.time ?? el.currentTime;
      }
    }
    function handlePause() {
      if (programmaticRef.current) return;
      if (!isHostRef.current) {
        const { kind } = authoritativeRef.current;
        const expectedTime = getExpectedTime();
        markProgrammatic();
        if (kind === 'play') {
          el.currentTime = expectedTime;
          el.play().catch(() => {});
        } else {
          el.currentTime = expectedTime;
        }
      }
    }

    function handleSeeked() {
      if (programmaticRef.current) return;
      if (!isHostRef.current) {
        const expectedTime = getExpectedTime();
        if (Math.abs(el.currentTime - expectedTime) > 1.5) {
          markProgrammatic();
          el.currentTime = expectedTime;
        }
      }
    }

    function handleWaiting() { setIsBuffering(true); }
    function handlePlaying() { setIsBuffering(false); }
    function handleCanPlay() { setIsBuffering(false); }

    el.addEventListener('play', handlePlay);
    el.addEventListener('pause', handlePause);
    el.addEventListener('seeked', handleSeeked);
    el.addEventListener('waiting', handleWaiting);
    el.addEventListener('playing', handlePlaying);
    el.addEventListener('canplay', handleCanPlay);

    return () => {
      el.removeEventListener('play',    handlePlay);
      el.removeEventListener('pause',   handlePause);
      el.removeEventListener('seeked', handleSeeked);
      el.removeEventListener('waiting', handleWaiting);
      el.removeEventListener('playing', handlePlaying);
      el.removeEventListener('canplay', handleCanPlay);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.type, source?.url]);

  // ── Render ─────────────────────────────────────────────────────────
  // Use the real source if available, or keep showing the last source
  // during a brief transition (avoids flash of empty placeholder).
  const renderSource = source || (sourceTransitionRef.current ? lastSourceRef.current : null);

  if (!renderSource) {
    return (
      <div className="video-stage video-stage--empty">
        <div className="empty-stage-content">
          <svg
            className="empty-stage-tv"
            viewBox="0 0 100 100"
            width="80"
            height="80"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* TV Body */}
            <rect x="15" y="25" width="70" height="50" rx="8" />
            {/* TV Antenna */}
            <path d="M35 10 L50 25 L65 10" />
            <circle cx="33" cy="8" r="3" fill="currentColor" />
            <circle cx="67" cy="8" r="3" fill="currentColor" />
            {/* Sleeping Eyes (Zz) */}
            <path d="M35 45 Q40 50 45 45" />
            <path d="M55 45 Q60 50 65 45" />
          </svg>
          <div className="empty-stage-z-group">
            <span className="empty-stage-z empty-stage-z-1">z</span>
            <span className="empty-stage-z empty-stage-z-2">Z</span>
            <span className="empty-stage-z empty-stage-z-3">z</span>
          </div>
          <p>No video loaded yet.</p>
        </div>
      </div>
    );
  }

  const isYouTube = renderSource.type === 'youtube';
  const isFile = renderSource.type === 'file';
  const isEmbed = renderSource.type === 'embed';

  return (
    <div className="video-stage">
      {/* YouTube container is ALWAYS in the DOM so that ytPlayer.destroy() 
          can run safely without throwing uncatchable async errors when switching to a file. */}
      <div
        ref={containerRef}
        style={{ 
          position: 'absolute', 
          inset: 0, 
          width: '100%', 
          height: '100%',
          display: isYouTube ? 'block' : 'none'
        }}
      />
      {/* Non-host overlay: blocks all pointer events reaching the iframe */}
      {isYouTube && !isHost && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 10 }} />
      )}

      {/* Local file player */}
      {isFile && (
        <>
          <video
            ref={fileVideoRef}
            src={renderSource.url}
            playsInline
            controls={false}
            onLoadedMetadata={flushPending}
            onError={() => {
              if (sourceTransitionRef.current) return;
              onPlaybackError?.();
            }}
            style={{ pointerEvents: 'none' }}
          />
          {renderSource.isLocal && (
            <div className="local-file-badge" title="Playing from your local device — only you can see this">
              📁 Local file
            </div>
          )}
        </>
      )}

      {/* Generic embed player (e.g. tpead.net, or any pasted <iframe> link).
          No postMessage API to hook into, so we can't sync play/pause/seek
          the way we do for YouTube — each viewer just has their own iframe
          and presses play locally. */}
      {isEmbed && (
        <iframe
          key={renderSource.url}
          src={renderSource.url}
          width="100%"
          height="100%"
          style={{ position: 'absolute', inset: 0, border: 'none' }}
          allow="autoplay; fullscreen"
          allowFullScreen
          scrolling="no"
          frameBorder="0"
          referrerPolicy="no-referrer"
          title="Embedded video"
        />
      )}

      {/* Embed sync UI: countdown before everyone presses play, or a
          banner nudging viewers to pause/seek to match the host. */}
      {isEmbed && embedCountdown != null && (
        <div className="embed-sync-overlay" style={{
          position: 'absolute', inset: 0, zIndex: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.55)', pointerEvents: 'none',
        }}>
          <div style={{ textAlign: 'center', color: '#fff' }}>
            <div style={{ fontSize: '3rem', fontWeight: 700, lineHeight: 1 }}>
              {embedCountdown}
            </div>
            <div style={{ fontSize: '0.95rem', opacity: 0.9, marginTop: 8 }}>
              Press play together…
            </div>
          </div>
        </div>
      )}
      {isEmbed && embedBanner && (
        <div className="embed-sync-banner" style={{
          position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
          zIndex: 20, background: 'rgba(0,0,0,0.75)', color: '#fff',
          padding: '8px 14px', borderRadius: 8, fontSize: '0.9rem',
        }}>
          {embedBanner}
        </div>
      )}

      {/* Buffering Spinner */}
      {isBuffering && (
        <div className="buffering-spinner-overlay">
          <div className="waiting-spinner" aria-hidden="true" />
        </div>
      )}
    </div>
  );
});

export default VideoPlayer;
