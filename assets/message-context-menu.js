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

export function isMessageBubbleTarget(row, target) {
  if (!(target instanceof Element) || !row?.contains(target)) return false;
  const article = row.querySelector('article');
  const bubble = article?.matches('.media-message') ? article.firstElementChild : article;
  return Boolean(bubble?.contains(target));
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const holdFeedback = new WeakMap();
const hiddenMessages = new WeakMap();

export function hideMessageSource(source) {
  let state = hiddenMessages.get(source);
  if (!state) {
    state = { opacity: source.style.opacity, owners: 0 };
    hiddenMessages.set(source, state);
  }
  state.owners++;
  source.style.opacity = "0";
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    if (--state.owners === 0) {
      source.style.opacity = state.opacity;
      hiddenMessages.delete(source);
    }
  };
}

export function createMessageSnapshot(source) {
  const style = getComputedStyle(source);
  const width = parseFloat(style.width) || source.offsetWidth;
  const height = parseFloat(style.height) || source.offsetHeight;
  const clone = source.cloneNode(true);
  clone.removeAttribute("id");
  clone.querySelectorAll("[id]").forEach(element => element.removeAttribute("id"));
  clone.querySelectorAll(".message-hold-ripple-layer").forEach(element => element.remove());
  clone.classList.remove("message-hold-target");
  Object.assign(clone.style, {
    width: `${width}px`, height: `${height}px`, maxWidth: "none",
    margin: "0", visibility: "visible", opacity: "1", transform: "none",
  });
  return { clone, width, height, borderRadius: style.borderRadius };
}

function clearHoldFeedback(bubble, motion) {
  motion.detachObserver?.disconnect();
  motion.animations.forEach(animation => animation.cancel());
  motion.layer.remove();
  if (holdFeedback.get(bubble) === motion) {
    motion.restoreSource();
    holdFeedback.delete(bubble);
  }
}

export function beginMessageHold(message, point) {
  if (!isMobileMessageDevice() || reducedMotion.matches || point?.target?.closest(OPTIONS_SELECTOR)) return;
  if (message?.querySelector(OPTIONS_SELECTOR)?.getAttribute("aria-expanded") === "true") return;
  const bubble = message?.querySelector("article");
  if (!bubble || typeof bubble.animate !== "function") return;
  const previous = holdFeedback.get(bubble);
  const initialTransform = previous ? getComputedStyle(previous.preview).transform : "scale(1)";
  if (previous) clearHoldFeedback(bubble, previous);

  const bounds = bubble.getBoundingClientRect();
  const frame = message.closest("[data-thread]").getBoundingClientRect();
  const snapshot = createMessageSnapshot(bubble);
  const x = Math.max(0, Math.min(bounds.width, (point?.x ?? bounds.left + bounds.width / 2) - bounds.left));
  const y = Math.max(0, Math.min(bounds.height, (point?.y ?? bounds.top + bounds.height / 2) - bounds.top));
  const diameter = Math.hypot(Math.max(x, bounds.width - x), Math.max(y, bounds.height - y)) * 2;
  const layer = document.createElement("span");
  layer.className = "message-hold-overlay";
  layer.setAttribute("aria-hidden", "true");
  layer.inert = true;
  Object.assign(layer.style, { left: `${frame.left}px`, top: `${frame.top}px`, width: `${frame.width}px`, height: `${frame.height}px` });
  const preview = document.createElement("div");
  preview.className = "message-hold-preview";
  Object.assign(preview.style, {
    left: `${bounds.left - frame.left}px`, top: `${bounds.top - frame.top}px`,
    width: `${snapshot.width}px`, height: `${snapshot.height}px`, borderRadius: snapshot.borderRadius,
  });
  const ripple = document.createElement("span");
  ripple.className = "message-hold-ripple-layer";
  const wave = document.createElement("span");
  wave.className = "message-hold-ripple-wave";
  Object.assign(wave.style, {
    left: `${x}px`, top: `${y}px`, width: `${diameter}px`, height: `${diameter}px`,
    marginLeft: `${-diameter / 2}px`, marginTop: `${-diameter / 2}px`,
  });
  ripple.append(wave);
  snapshot.clone.classList.add("message-hold-target");
  snapshot.clone.append(ripple);
  preview.append(snapshot.clone);
  layer.append(preview);
  document.body.append(layer);
  // Keep the real message's transform and clipping layer unchanged on WebKit.
  const restoreSource = hideMessageSource(bubble);
  const motion = { phase: "press", layer, preview, wave, bounds, restoreSource, animations: [
    wave.animate([
      { transform: "scale(0)", opacity: 0.06, offset: 0 },
      { transform: "scale(.85)", opacity: 0.1, offset: 0.7 },
      { transform: "scale(1)", opacity: 0, offset: 1 },
    ], { duration: 520, easing: "cubic-bezier(.2,0,.2,1)", fill: "forwards" }),
    preview.animate([
      { transform: initialTransform },
      { transform: "scale(.975)" },
    ], { duration: 520, easing: "cubic-bezier(.2,0,.2,1)", fill: "forwards" }),
  ] };
  holdFeedback.set(bubble, motion);
  motion.detachObserver = new MutationObserver(() => {
    if (!bubble.isConnected) clearHoldFeedback(bubble, motion);
  });
  motion.detachObserver.observe(document.body, { childList: true, subtree: true });
}

export function releaseMessageHold(message) {
  const bubble = message?.querySelector("article"), motion = bubble && holdFeedback.get(bubble);
  if (!motion) return;
  clearHoldFeedback(bubble, motion);
}

export function getMessageHoldBounds(message) {
  const motion = holdFeedback.get(message?.querySelector("article"));
  return motion?.preview.getBoundingClientRect();
}

export function confirmMessageHold(message, point) {
  const bubble = message?.querySelector("article");
  if (bubble && !holdFeedback.has(bubble)) beginMessageHold(message, point);
  const motion = bubble && holdFeedback.get(bubble);
  if (motion?.phase === "press") motion.phase = "confirmed";
}

export function cancelMessageHold(message) {
  const bubble = message?.querySelector("article"), motion = bubble && holdFeedback.get(bubble);
  if (!motion) return;
  const bounds = bubble.getBoundingClientRect();
  if (!bubble.isConnected || Math.abs(bounds.top - motion.bounds.top) > 1 || Math.abs(bounds.left - motion.bounds.left) > 1) {
    clearHoldFeedback(bubble, motion);
    return;
  }
  if (motion.phase === "canceled") return;
  if (reducedMotion.matches) { clearHoldFeedback(bubble, motion); return; }
  const transform = getComputedStyle(motion.preview).transform;
  const waveStyle = getComputedStyle(motion.wave);
  const waveTransform = waveStyle.transform, opacity = waveStyle.opacity;
  motion.animations.forEach(animation => animation.cancel());
  motion.phase = "canceled";
  motion.animations = [
    motion.wave.animate([{ transform: waveTransform, opacity }, { transform: waveTransform, opacity: 0 }], { duration: 160, easing: "ease-out" }),
    motion.preview.animate([{ transform }, { transform: "scale(1)" }], { duration: 180, easing: "cubic-bezier(.22,.61,.36,1)" }),
  ];
  Promise.allSettled(motion.animations.map(animation => animation.finished)).then(() => {
    if (holdFeedback.get(bubble) === motion) clearHoldFeedback(bubble, motion);
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
  if (!message || !message.closest("[data-thread]") || !isMessageBubbleTarget(message, target)) return;

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
