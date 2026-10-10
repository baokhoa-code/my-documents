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

function clearHoldFeedback(bubble, motion) {
  motion.animations.forEach(animation => animation.cancel());
  motion.layer.remove();
  if (holdFeedback.get(bubble) === motion) {
    bubble.classList.remove("message-hold-target");
    holdFeedback.delete(bubble);
  }
}

export function beginMessageHold(message, point) {
  if (!isMobileMessageDevice() || reducedMotion.matches || point?.target?.closest(OPTIONS_SELECTOR)) return;
  const bubble = message?.querySelector("article");
  if (!bubble || typeof bubble.animate !== "function") return;
  const previous = holdFeedback.get(bubble);
  const initialTransform = previous ? getComputedStyle(bubble).transform : "scale(1)";
  if (previous) clearHoldFeedback(bubble, previous);

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
  const motion = { phase: "press", layer, wave, animations: [
    wave.animate([
      { transform: "scale(0)", opacity: 0.06 },
      { transform: "scale(1)", opacity: 0.16 },
    ], { duration: 520, easing: "cubic-bezier(.2,0,.2,1)", fill: "forwards" }),
    bubble.animate([
      { transform: initialTransform },
      { transform: "scale(.975)" },
    ], { duration: 520, easing: "cubic-bezier(.2,0,.2,1)", fill: "forwards" }),
  ] };
  holdFeedback.set(bubble, motion);
}

function finishMessageHold(message, confirmed) {
  const bubble = message?.querySelector("article"), motion = bubble && holdFeedback.get(bubble);
  if (!motion || motion.phase !== "press") return;
  if (reducedMotion.matches) { clearHoldFeedback(bubble, motion); return; }
  // Continue from the currently rendered frame instead of restarting at full size.
  const transform = getComputedStyle(bubble).transform;
  const waveStyle = getComputedStyle(motion.wave);
  const waveTransform = waveStyle.transform, opacity = waveStyle.opacity;
  motion.animations.forEach(animation => animation.cancel());
  motion.phase = confirmed ? "confirmed" : "canceled";
  motion.animations = [
    motion.wave.animate([
      { transform: waveTransform, opacity },
      { transform: "scale(1)", opacity: 0 },
    ], { duration: confirmed ? 240 : 160, easing: "ease-out" }),
    bubble.animate(confirmed ? [
      { transform },
      { transform: "scale(1.008)", offset: 0.65 },
      { transform: "scale(1)" },
    ] : [
      { transform },
      { transform: "scale(1)" },
    ], { duration: confirmed ? 260 : 180, easing: "cubic-bezier(.22,.61,.36,1)" }),
  ];
  Promise.allSettled(motion.animations.map(animation => animation.finished)).then(() => {
    if (holdFeedback.get(bubble) === motion) clearHoldFeedback(bubble, motion);
  });
}

export function confirmMessageHold(message, point) {
  const bubble = message?.querySelector("article");
  if (bubble && !holdFeedback.has(bubble)) beginMessageHold(message, point);
  finishMessageHold(message, true);
}

export function cancelMessageHold(message) {
  finishMessageHold(message, false);
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
    confirmMessageHold(message, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : void 0);
    optionsButton.click();
  }
}

document.addEventListener("contextmenu", openMessageMenu, true);
