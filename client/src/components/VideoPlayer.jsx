import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { loadYouTubeAPI } from '../lib/youtubeLoader.js';

const VideoPlayer = forwardRef(function VideoPlayer(
  { source, onAutoplayBlocked, onMutedAutoplay, onPlaybackError, isHost, onHostPlayPause },
  ref
) {
  const containerRef = useRef(null);
  const ytPlayerRef = useRef(null);
  const fileVideoRef = useRef(null);
  const readyRef = useRef(false);
  const pendingRef = useRef(null);
  const hasPlayedRef = useRef(false);

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
        el.play().catch(() => {
          // Unmuted autoplay needs a gesture in the same call stack on most
          // browsers, and "play" almost always arrives here asynchronously
          // (a socket round-trip after the host pressed play, or a
          // sync-request reply on join) — never a literal click — so the
          // unmuted attempt fails essentially every time, not just
          // occasionally. Muted autoplay has no such restriction anywhere,
          // so retry muted instead of leaving the video fully stalled: the
          // viewer stays in sync visually right away and can unmute with a
          // single tap, rather than having to hit "play" and fall out of
          // sync until they do.
          markProgrammatic();
          el.muted = true;
          el.play()
            .then(() => onMutedAutoplay?.())
            .catch(() => onAutoplayBlocked?.());
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
            const { PLAYING, PAUSED } = YT.PlayerState;
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
          },
        },
      });

      ytPlayerRef.current = player;
    });

    return () => {
      cancelled = true;
      if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
      ytPlayerRef.current?.destroy?.();
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

    el.addEventListener('play', handlePlay);
    el.addEventListener('pause', handlePause);
    el.addEventListener('seeked', handleSeeked);

    return () => {
      el.removeEventListener('play',    handlePlay);
      el.removeEventListener('pause',   handlePause);
      el.removeEventListener('seeked', handleSeeked);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.type, source?.url]);

  // ── Render ─────────────────────────────────────────────────────────
  if (!source) {
    return (
      <div className="video-stage video-stage--empty">
        <p>No video loaded yet.</p>
      </div>
    );
  }

  if (source.type === 'youtube') {
    return (
      <div className="video-stage">
        <div
          ref={containerRef}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        />
        {/* Non-host overlay: blocks all pointer events reaching the iframe */}
        {!isHost && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 10 }} />
        )}
      </div>
    );
  }

  if (source.type === 'file') {
    // Local files play via the browser's native hardware decoder — no
    // re-encoding needed. The .video-stage CSS rule stretches the element
    // to fill its container at any resolution (object-fit: contain keeps
    // the aspect ratio), so a 1080p file fills full screen properly instead
    // of being capped to a small fixed box.
    const isLocal = source.isLocal;
    return (
      <div className="video-stage">
        <video
          ref={fileVideoRef}
          src={source.url}
          playsInline
          controls={false}
          onLoadedMetadata={flushPending}
          onError={() => onPlaybackError?.()}
          style={{ pointerEvents: 'none' }}
        />
        {isLocal && (
          <div className="local-file-badge" title="Playing from your local device — only you can see this">
            📁 Local file
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="video-stage video-stage--empty">
      <p>This link can't be played here.</p>
    </div>
  );
});

export default VideoPlayer;
