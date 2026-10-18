/** Media events can remain queued across load()/source replacement. Read the
 * current TV element before accepting readiness; the event name is not proof. */
export function tvHasPlayableVideo(video) {
  return Boolean(video && !video.paused && !video.ended && !video.error
    && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0);
}

/** Reconcile readiness when an early queued `playing` event was not usable.
 * A later advancing media clock is evidence; metadata or elapsed wall time is
 * not. This observer never calls play, pause, load, seek or opens a request. */
export function observeTVPlaybackReadiness({video, getOwner, onReady}) {
  let owner = null, element = null, source = '', position = null, waiting = true;
  const disposers = [];
  const reset = () => { position = null; waiting = true; };
  const context = () => {
    const nextOwner = getOwner(), nextElement = video.element || video;
    const nextSource = String(nextElement.currentSrc || nextElement.src || '');
    if (nextOwner !== owner || nextElement !== element || nextSource !== source) {
      owner = nextOwner; element = nextElement; source = nextSource; reset();
    }
    return owner && tvHasPlayableVideo(video) && !video.seeking;
  };
  const accept = () => { waiting = false; onReady(owner); };
  const playing = () => {
    if (!context()) { reset(); return; }
    position = Number(video.currentTime);
    accept();
  };
  const progress = () => {
    if (!context()) { reset(); return; }
    const next = Number(video.currentTime), advancing = Number.isFinite(position)
      && Number.isFinite(next) && next > position;
    position = Number.isFinite(next) ? next : null;
    if (waiting && advancing) accept();
  };
  for (const [event, callback] of [['playing', playing], ['timeupdate', progress],
    ...['loadstart', 'emptied', 'waiting', 'pause', 'seeking', 'seeked', 'ended', 'error'].map(event => [event, reset])]) {
    video.addEventListener(event, callback);
    disposers.push(() => video.removeEventListener(event, callback));
  }
  return () => { for (const dispose of disposers) dispose(); owner = null; reset(); };
}
