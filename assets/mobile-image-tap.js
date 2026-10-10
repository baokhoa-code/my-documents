import { isMobileMessageDevice } from "./message-context-menu.js?v=6";

const HOLD_DELAY = 520;
const MOVE_THRESHOLD = 10;
let multiTouchVersion = 0;
document.addEventListener("touchstart", event => {
  if (event.touches.length > 1) multiTouchVersion++;
}, { capture: true, passive: true });

function consumeFollowupClick({ clientX, clientY }) {
  // The keyboard can move the original button before the browser's delayed click.
  function cleanup() {
    clearTimeout(timeout);
    document.removeEventListener("click", click, true);
    document.removeEventListener("pointerdown", cleanup, true);
  }
  function click(event) {
    if (event.detail && Math.hypot(event.clientX - clientX, event.clientY - clientY) <= MOVE_THRESHOLD) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    cleanup();
  }
  const timeout = setTimeout(cleanup, 400);
  document.addEventListener("click", click, true);
  document.addEventListener("pointerdown", cleanup, true);
}

export function createMobileImageTapHandlers(onTap, enabled) {
  let press = null, touchPress = null;
  const cancel = () => { press = null; touchPress = null; };
  const cancelPointer = () => { press = null; };
  function finish(event, point, coordinates) {
    cancel();
    if (!enabled() || !point || point.version !== multiTouchVersion || performance.now() - point.started >= HOLD_DELAY) return;
    const row = event.currentTarget.closest(".message-row");
    if (row?.querySelector('button[aria-label="Tùy chọn tin nhắn"]')?.getAttribute("aria-expanded") === "true") return;
    event.preventDefault();
    consumeFollowupClick(coordinates);
    onTap(event);
  }
  return {
    cancel,
    props: {
      onPointerDown(event) {
        if (!enabled() || !isMobileMessageDevice() || event.pointerType === "mouse" || event.isPrimary === false) {
          cancel();
          return;
        }
        press = { id: event.pointerId, x: event.clientX, y: event.clientY, started: performance.now(), version: multiTouchVersion };
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
      },
      onPointerMove(event) {
        if (press?.id === event.pointerId && Math.hypot(event.clientX - press.x, event.clientY - press.y) > MOVE_THRESHOLD) cancel();
      },
      onPointerUp(event) {
        const point = press;
        if (point?.id === event.pointerId) finish(event, point, event);
      },
      onPointerCancel: cancelPointer,
      onLostPointerCapture: cancelPointer,
      onTouchStart(event) {
        if (!enabled() || !isMobileMessageDevice() || event.touches.length !== 1) { cancel(); return; }
        const touch = event.touches[0];
        touchPress = { id: touch.identifier, x: touch.clientX, y: touch.clientY, started: press?.started ?? performance.now(), version: multiTouchVersion };
      },
      onTouchMove(event) {
        const touch = [...event.touches].find(touch => touch.identifier === touchPress?.id);
        if (event.touches.length !== 1 || touch && Math.hypot(touch.clientX - touchPress.x, touch.clientY - touchPress.y) > MOVE_THRESHOLD) cancel();
      },
      onTouchEnd(event) {
        const point = touchPress;
        const touch = [...event.changedTouches].find(touch => touch.identifier === point?.id);
        // WebKit retains the touch target when viewport changes retarget pointerup.
        if (!event.touches.length && touch) finish(event, point, touch);
        else cancel();
      },
      onTouchCancel: cancel,
    },
  };
}
