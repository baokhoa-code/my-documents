import { isMobileMessageDevice } from "./message-context-menu.js?v=8";
import { installIOSInputFocus } from "./ios-input-focus.js?v=1";

let mediaHeight = window.innerHeight;
let keyboardOpen = false;
export const getChatMediaViewportHeight = () => mediaHeight;
export const isChatKeyboardOpen = () => keyboardOpen;

function modalIsVisible() {
  return [...document.querySelectorAll('[aria-modal="true"]')].some(element =>
    element.getClientRects().length && getComputedStyle(element).visibility !== "hidden");
}

export function installChatViewport(shell) {
  const viewport = window.visualViewport;
  let frame = 0, previous = null, pendingLatest = false, latestTimer = 0;
  let closedHeight = viewport?.height ?? window.innerHeight;
  mediaHeight = closedHeight;
  const originalStyle = shell.getAttribute("style");
  const body = shell.querySelector('.app-viewport-body');
  const restoreFocus = installIOSInputFocus(shell);
  let settleUntil = 0;

  function followAfterKeyboard() {
    clearTimeout(latestTimer);
    latestTimer = 0;
    if (!pendingLatest || keyboardOpen || modalIsVisible()) return;
    // Wait for the last keyboard frame, then perform one visible scroll.
    latestTimer = window.setTimeout(() => {
      latestTimer = 0;
      if (keyboardOpen || modalIsVisible()) return;
      const thread = shell.querySelector('[data-thread]');
      if (!thread) { pendingLatest = false; return; }
      pendingLatest = false;
      thread.scrollTo({ top: thread.scrollHeight,
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }, 120);
  }

  function update() {
    frame = 0;
    const mobile = isMobileMessageDevice();
    const zoomed = Math.abs((viewport?.scale ?? 1) - 1) > .01;
    // Page pinch zoom belongs to the browser, not the keyboard layout.
    if (zoomed) return;
    const height = Math.round(viewport?.height ?? window.innerHeight);
    const width = Math.round(viewport?.width ?? window.innerWidth);
    const top = Math.round(viewport?.offsetTop ?? 0);
    const left = Math.round(viewport?.offsetLeft ?? 0);
    const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
    const widthChanged = previous && Math.abs(previous.width - width) > 1;
    if (widthChanged) {
      closedHeight = Math.max(height, window.innerHeight);
      mediaHeight = closedHeight;
      keyboardOpen = false;
    }
    const wasOpen = keyboardOpen;
    keyboardOpen = mobile && Math.max(closedHeight, window.innerHeight) - height > 80 && Boolean(editing || wasOpen);
    if (!mobile || (!editing && !wasOpen)) closedHeight = height;
    // Keyboard animation must never resize the images or repeatedly rewrap captions.
    mediaHeight = mobile ? Math.max(mediaHeight, closedHeight) : height;

    const thread = shell.querySelector('[data-thread]');
    const scrollTop = thread?.scrollTop ?? 0;
    const remaining = thread ? Math.max(0, thread.scrollHeight - thread.scrollTop - thread.clientHeight) : 0;
    const resized = previous && (previous.height !== height || widthChanged);
    if (wasOpen && !keyboardOpen) pendingLatest = true;
    if (keyboardOpen) {
      pendingLatest = false;
      clearTimeout(latestTimer);
      latestTimer = 0;
    }
    const blocked = modalIsVisible();

    // Use document coordinates on mobile. WebKit's fixed-position compositor
    // can pan independently of layout; pageTop also covers the pan when offsetTop
    // is stale. Absolute positioning avoids adding that movement a second time.
    const pageTop = Math.max(viewport?.pageTop ?? 0, window.scrollY + top);
    const pageLeft = Math.max(viewport?.pageLeft ?? 0, window.scrollX + left);
    const frameHeight = mobile ? mediaHeight : height;
    const values = { position: mobile ? 'absolute' : 'fixed', top: `${mobile ? pageTop : top}px`, left: `${mobile ? pageLeft : left}px`,
      width: `${width}px`, height: `${frameHeight}px`, maxWidth: '100%', overflow: 'hidden' };
    for (const [property, value] of Object.entries(values)) {
      if (shell.style[property] !== value) shell.style[property] = value;
    }
    const inset = `${Math.max(0, frameHeight - height)}px`;
    if (body && body.style.marginBottom !== inset) body.style.marginBottom = inset;
    if (thread && !blocked) {
      if (mobile && resized && !widthChanged) {
        // Opening keeps the reading anchor. Closing must not jump to newest
        // before the keyboard has finished disappearing.
        thread.scrollTop = height < previous.height
          ? thread.scrollHeight - thread.clientHeight - remaining : scrollTop;
      }
    }
    const changed = !previous || Object.entries({ width, height, top, left, pageTop, pageLeft }).some(([key, value]) => previous[key] !== value);
    previous = { width, height, top, left, pageTop, pageLeft };
    if (pendingLatest && (changed || !latestTimer)) followAfterKeyboard();
    if (changed || wasOpen !== keyboardOpen) window.dispatchEvent(new Event('chatviewportchange'));
    // Home-screen WebKit can publish viewport offsets a frame after the resize
    // event. Read them through the keyboard transition even without another event.
    if (mobile && performance.now() < settleUntil) schedule();
  }

  function schedule() { if (!frame) frame = requestAnimationFrame(update); }
  function transition() { settleUntil = performance.now() + 700; schedule(); }
  const events = [[viewport, 'resize'], [viewport, 'scroll'], [window, 'resize'],
    [window, 'orientationchange'], [document, 'focusin'], [document, 'focusout']];
  events.forEach(([target, type]) => target?.addEventListener(type, transition, { passive: true }));
  // A keyboard may close while an image/menu is open. Follow newest once it exits.
  const observer = new MutationObserver(() => { if (pendingLatest && !keyboardOpen && !modalIsVisible()) schedule(); });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['hidden', 'aria-modal', 'data-overlay-state'] });
  update();
  return () => {
    cancelAnimationFrame(frame);
    clearTimeout(latestTimer);
    observer.disconnect();
    events.forEach(([target, type]) => target?.removeEventListener(type, transition));
    restoreFocus();
    if (originalStyle === null) shell.removeAttribute('style');
    else shell.setAttribute('style', originalStyle);
    body?.style.removeProperty('margin-bottom');
  };
}
