let loadingPromise = null;

export function loadYouTubeAPI() {
  if (window.YT && window.YT.Player) {
    return Promise.resolve(window.YT);
  }
  if (loadingPromise) return loadingPromise;

  loadingPromise = new Promise((resolve) => {
    const previousCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousCallback?.();
      resolve(window.YT);
    };

    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(script);
  });

  return loadingPromise;
}
