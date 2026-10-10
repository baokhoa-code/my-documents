const touchDevice = window.matchMedia("(hover: none) and (pointer: coarse)");
const standalone = window.matchMedia("(display-mode: standalone)");
const screenOrientation = window.screen?.orientation;
const guard = document.createElement("section");
guard.id = "mobile-portrait-guard";
guard.hidden = true;
guard.tabIndex = -1;
guard.setAttribute("role", "dialog");
guard.setAttribute("aria-modal", "true");
guard.setAttribute("aria-labelledby", "mobile-portrait-title");
guard.setAttribute("aria-describedby", "mobile-portrait-description");
guard.innerHTML = `
  <div class="mobile-portrait-content">
    <svg aria-hidden="true" width="72" height="72" viewBox="0 0 72 72" fill="none"
         stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="24" y="13" width="24" height="46" rx="5"></rect>
      <path d="M32 19h8M34 53h4M15 28a23 23 0 0 1 8-13M15 28v-9M15 28h9M57 44a23 23 0 0 1-8 13M57 44v9M57 44h-9"></path>
    </svg>
    <h2 id="mobile-portrait-title">Vui lòng xoay điện thoại về chiều dọc</h2>
    <p id="mobile-portrait-description">My Documents chỉ sử dụng chiều dọc trên thiết bị di động.</p>
  </div>
`;
document.body.append(guard);

let blocked = false;
let returnFocus = null;
let locking = false;
const previousInert = new Map();
const activePointers = new Map();

function isMobile() {
  return Boolean(
    navigator.userAgentData?.mobile ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1) ||
    touchDevice.matches,
  );
}

function isLandscape() {
  // Device orientation stays stable when the keyboard shrinks a portrait viewport.
  const type = screenOrientation?.type;
  if (type?.startsWith("landscape")) return true;
  if (type?.startsWith("portrait")) return false;
  if (typeof window.orientation === "number") {
    return Math.abs(window.orientation % 180) === 90;
  }
  if (screen.width > 0 && screen.height > 0 && screen.width !== screen.height) {
    return screen.width > screen.height;
  }
  return window.innerWidth > window.innerHeight;
}

function blockAppChildren() {
  for (const child of document.body.children) {
    if (child === guard || previousInert.has(child)) continue;
    previousInert.set(child, child.inert);
    child.inert = true;
  }
}

function updateOrientation() {
  const nextBlocked = isMobile() && isLandscape();
  if (nextBlocked === blocked) return;
  blocked = nextBlocked;
  document.documentElement.classList.toggle("is-mobile-landscape", blocked);
  guard.hidden = !blocked;
  if (blocked) {
    // Cancel an unfinished image drag/pinch before covering it, without closing the preview.
    for (const event of activePointers.values()) {
      event.target.dispatchEvent(new PointerEvent("pointercancel", {
        bubbles: true, pointerId: event.pointerId, pointerType: event.pointerType,
        clientX: event.clientX, clientY: event.clientY,
      }));
      for (let element = event.target; element; element = element.parentElement) {
        if (element.hasPointerCapture?.(event.pointerId)) element.releasePointerCapture(event.pointerId);
      }
    }
    activePointers.clear();
    returnFocus = document.activeElement;
    returnFocus?.blur?.();
    blockAppChildren();
    guard.focus({ preventScroll: true });
  } else {
    for (const [element, inert] of previousInert) element.inert = inert;
    previousInert.clear();
    if (returnFocus?.isConnected && !returnFocus.closest("[inert]") && returnFocus.getClientRects().length) {
      returnFocus.focus({ preventScroll: true });
    }
    returnFocus = null;
  }
}

async function tryPortraitLock() {
  if (!isMobile() || document.hidden || locking || typeof screenOrientation?.lock !== "function") return;
  locking = true;
  try {
    await screenOrientation.lock("portrait");
  } catch {
    // Normal browser tabs may reject native locking; the portrait guard remains active.
  } finally {
    locking = false;
    updateOrientation();
  }
}

function orientationChanged() {
  updateOrientation();
  requestAnimationFrame(updateOrientation);
  tryPortraitLock();
}

// Portals (image preview and account manager) remain mounted but cannot be used sideways.
new MutationObserver(() => { if (blocked) blockAppChildren(); })
  .observe(document.body, { childList: true });

function stopLandscapeInteraction(event) {
  if (!blocked) return;
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
}

window.addEventListener("pointerdown", event => { if (!blocked) activePointers.set(event.pointerId, event); }, { capture: true, passive: true });
for (const type of ["pointerup", "pointercancel"]) {
  window.addEventListener(type, event => activePointers.delete(event.pointerId), { capture: true, passive: true });
}
// A user gesture can allow locking in a standalone or fullscreen browser context.
window.addEventListener("pointerup", tryPortraitLock, { once: true, capture: true, passive: true });
for (const type of ["keydown", "click", "pointerdown", "pointermove", "pointerup", "touchstart", "touchmove", "touchend", "wheel"]) {
  window.addEventListener(type, stopLandscapeInteraction, { capture: true, passive: false });
}
window.addEventListener("orientationchange", orientationChanged, { passive: true });
screenOrientation?.addEventListener?.("change", orientationChanged);
window.addEventListener("resize", updateOrientation, { passive: true });
window.addEventListener("pageshow", orientationChanged);
document.addEventListener("fullscreenchange", orientationChanged);
document.addEventListener("visibilitychange", () => { if (!document.hidden) orientationChanged(); });
touchDevice.addEventListener?.("change", orientationChanged);
standalone.addEventListener?.("change", tryPortraitLock);
updateOrientation();
tryPortraitLock();
