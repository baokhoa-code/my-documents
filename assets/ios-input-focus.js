function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

// A native tap on an unfocused input asks WebKit to reveal it by panning the
// entire page. Focus within the user gesture, explicitly without that reveal.
export function installIOSInputFocus(shell) {
  let touch = null;
  function targetInput(target) {
    return target instanceof Element && shell.contains(target)
      ? target.closest('textarea.composer-input, .app-search input') : null;
  }
  function start(event) {
    touch = null;
    if (!isIOS() || event.touches.length !== 1) return;
    const input = targetInput(event.target);
    if (!input || document.activeElement === input) return;
    const point = event.touches[0];
    touch = { input, id: point.identifier, x: point.clientX, y: point.clientY, started: performance.now() };
  }
  function move(event) {
    if (!touch) return;
    const point = [...event.touches].find(point => point.identifier === touch.id);
    if (event.touches.length !== 1 || !point || Math.hypot(point.clientX - touch.x, point.clientY - touch.y) > 10) touch = null;
  }
  function end(event) {
    const pressed = touch;
    touch = null;
    if (!pressed || event.touches.length || performance.now() - pressed.started > 450) return;
    const point = [...event.changedTouches].find(point => point.identifier === pressed.id);
    if (!point || Math.hypot(point.clientX - pressed.x, point.clientY - pressed.y) > 10 || !pressed.input.isConnected) return;
    if (document.activeElement === pressed.input) return;
    event.preventDefault();
    pressed.input.focus({ preventScroll: true });
  }
  function cancel() { touch = null; }
  shell.addEventListener('touchstart', start, { capture: true, passive: true });
  shell.addEventListener('touchmove', move, { capture: true, passive: true });
  shell.addEventListener('touchend', end, { capture: true, passive: false });
  shell.addEventListener('touchcancel', cancel, { capture: true, passive: true });
  return () => {
    shell.removeEventListener('touchstart', start, true);
    shell.removeEventListener('touchmove', move, true);
    shell.removeEventListener('touchend', end, true);
    shell.removeEventListener('touchcancel', cancel, true);
    cancel();
  };
}
