const MESSAGE_SELECTOR = ".message-row";
const OPTIONS_SELECTOR = 'button[aria-label="Tùy chọn tin nhắn"]';

const mobilePointer = window.matchMedia("(hover: none) and (pointer: coarse)");

export function isMobileMessageDevice() {
  return Boolean(
    navigator.userAgentData?.mobile ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1) ||
    mobilePointer.matches,
  );
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const holdFeedback = new WeakMap();

export function animateMessageHold(message, point) {
  if (!isMobileMessageDevice() || reducedMotion.matches) return;
  const bubble = message?.querySelector("article");
  if (!bubble || typeof bubble.animate !== "function" || holdFeedback.has(bubble)) return;

  const bounds = bubble.getBoundingClientRect();
  const x = Math.max(0, Math.min(bounds.width, (point?.x ?? bounds.left + bounds.width / 2) - bounds.left));
  const y = Math.max(0, Math.min(bounds.height, (point?.y ?? bounds.top + bounds.height / 2) - bounds.top));
  const diameter = Math.hypot(Math.max(x, bounds.width - x), Math.max(y, bounds.height - y)) * 2;
  const layer = document.createElement("span");
  layer.className = "message-hold-ripple-layer";
  layer.setAttribute("aria-hidden", "true");
  const wave = document.createElement("span");
  wave.className = "message-hold-ripple-wave";
  Object.assign(wave.style, {
    left: `${x}px`, top: `${y}px`, width: `${diameter}px`, height: `${diameter}px`,
    marginLeft: `${-diameter / 2}px`, marginTop: `${-diameter / 2}px`,
  });
  layer.append(wave);
  bubble.classList.add("message-hold-target");
  bubble.append(layer);
  const animations = [
    wave.animate([
      { transform: "scale(0)", opacity: 0.3 },
      { transform: "scale(1)", opacity: 0.16, offset: 0.65 },
      { transform: "scale(1)", opacity: 0 },
    ], { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" }),
    bubble.animate([
      { transform: "scale(1)" },
      { transform: "scale(.97)", offset: 0.2 },
      { transform: "scale(1.025)", offset: 0.55 },
      { transform: "scale(.995)", offset: 0.8 },
      { transform: "scale(1)" },
    ], { duration: 380, easing: "ease-out" }),
  ];
  holdFeedback.set(bubble, animations);
  Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
    layer.remove();
    bubble.classList.remove("message-hold-target");
    holdFeedback.delete(bubble);
  });
}

function updateMobileSelection() {
  document.documentElement.classList.toggle("mobile-message-menus", isMobileMessageDevice());
}

function preventMobileSelection(event) {
  if (!isMobileMessageDevice() || !(event.target instanceof Element)) return;
  const message = event.target.closest(MESSAGE_SELECTOR);
  if (!message?.closest("[data-thread]")) return;
  event.preventDefault();
}

updateMobileSelection();
mobilePointer.addEventListener("change", updateMobileSelection);
document.addEventListener("selectstart", preventMobileSelection, true);
document.addEventListener("dragstart", preventMobileSelection, true);

function openMessageMenu(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const message = target.closest(MESSAGE_SELECTOR);
  if (!message || !message.closest("[data-thread]")) return;

  const optionsButton = message.querySelector(OPTIONS_SELECTOR);
  if (!(optionsButton instanceof HTMLButtonElement)) return;

  event.preventDefault();
  event.stopPropagation();
  if (isMobileMessageDevice()) window.getSelection()?.removeAllRanges();

  if (optionsButton.getAttribute("aria-expanded") !== "true") {
    animateMessageHold(message, { x: event.clientX, y: event.clientY });
    optionsButton.click();
  }
}

document.addEventListener("contextmenu", openMessageMenu, true);
