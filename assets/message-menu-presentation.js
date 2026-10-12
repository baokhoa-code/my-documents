import { createMessageSnapshot, getMessageHoldBounds, hideMessageSource, releaseMessageHold } from "./message-context-menu.js?v=8";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const move = (x, y, scale = 1) => `translate(${x}px, ${y}px) scale(${scale})`;
const backgroundLocks = new WeakMap();

function lockBackground(message) {
  const background = message.closest("#root");
  if (!background) return () => {};
  let lock = backgroundLocks.get(background);
  if (!lock) {
    lock = { inert: background.inert, owners: 0 };
    backgroundLocks.set(background, lock);
  }
  lock.owners++;
  background.inert = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--lock.owners === 0) {
      background.inert = lock.inert;
      backgroundLocks.delete(background);
    }
  };
}

export function createMessageMenuPresentation(root, menu, message) {
  const source = message.querySelector("article");
  const preview = root.querySelector(".message-menu-preview");
  const backdrop = root.querySelector(".message-menu-backdrop");
  const sourceBounds = getMessageHoldBounds(message) ?? source.getBoundingClientRect();
  const snapshot = createMessageSnapshot(source);
  const sourceWidth = snapshot.width, sourceHeight = snapshot.height;
  const restoreSource = hideMessageSource(source);
  releaseMessageHold(message);
  preview.append(snapshot.clone);
  Object.assign(preview.style, { width: `${sourceWidth}px`, height: `${sourceHeight}px`, borderRadius: snapshot.borderRadius });
  preview.style.transform = move(sourceBounds.left, sourceBounds.top, sourceBounds.width / sourceWidth);
  backdrop.style.opacity = "0";
  menu.style.opacity = "0";
  const restoreBackground = lockBackground(message);

  let animations = [], revision = 0, disposed = false, closing = false, opened = false, resizeFrame = 0;
  let previousLayout = "";
  const sourcePosition = () => {
    const bounds = source.getBoundingClientRect();
    return move(bounds.left, bounds.top, bounds.width / sourceWidth);
  };
  function layout() {
    const viewport = window.visualViewport;
    const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
    const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
    const safeBottom = parseFloat(getComputedStyle(root).paddingBottom) || 12;
    const bottom = top + height - safeBottom, gap = 12;
    const menuWidth = Math.min(280, width - 24);
    menu.style.width = `${menuWidth}px`;
    menu.style.maxHeight = `${Math.max(88, height - 120)}px`;
    const menuHeight = menu.offsetHeight;
    const scale = Math.min(1, (width - 24) / sourceWidth, Math.max(32, height - 24 - safeBottom - menuHeight - gap) / sourceHeight);
    const bounds = source.getBoundingClientRect();
    const right = clamp(bounds.right, left + 12 + sourceWidth * scale, left + width - 12);
    const y = clamp(bounds.top, top + 12, bottom - menuHeight - gap - sourceHeight * scale);
    return {
      preview: move(right - sourceWidth * scale, y, scale),
      menu: {
        left: clamp(right - menuWidth, left + 12, left + width - menuWidth - 12),
        top: y + sourceHeight * scale + gap,
      },
    };
  }
  function current() {
    return {
      preview: getComputedStyle(preview).transform,
      menu: getComputedStyle(menu).transform,
      menuLeft: parseFloat(menu.style.left) || 0,
      menuTop: parseFloat(menu.style.top) || 0,
      opacity: getComputedStyle(menu).opacity,
      backdrop: getComputedStyle(backdrop).opacity,
    };
  }
  function animate(element, frames, duration, easing) {
    Object.assign(element.style, frames[frames.length - 1]);
    if (reducedMotion.matches || typeof element.animate !== "function") return;
    animations.push(element.animate(frames, { duration, easing, fill: "both" }));
  }
  function cancelAnimations() {
    animations.forEach(animation => animation.cancel());
    animations = [];
  }
  function transition(phase) {
    if (disposed) return Promise.resolve(false);
    const from = current(), target = layout(), token = ++revision;
    cancelAnimations();
    closing = phase === "exit";
    // Keep the backdrop interactive until unmount so closing taps cannot reach the app.
    menu.inert = closing;
    root.dataset.overlayState = closing ? "closing" : "opening";
    previousLayout = JSON.stringify(target);
    const duration = closing ? 220 : 280;
    const easing = closing ? "cubic-bezier(.4,0,.2,1)" : "cubic-bezier(.2,.9,.25,1.04)";
    // Position the scrollable menu normally so WebKit paints its entire viewport.
    menu.style.left = `${target.menu.left}px`;
    menu.style.top = `${target.menu.top}px`;
    const menuFrom = `translate(${from.menuLeft - target.menu.left}px, ${from.menuTop - target.menu.top}px) ${from.menu === "none" ? "" : from.menu}`;
    animate(backdrop, [{ opacity: from.backdrop }, { opacity: closing ? "0" : "1" }], closing ? 220 : 230, "ease-out");
    animate(preview, [{ transform: from.preview }, { transform: closing ? sourcePosition() : target.preview }], duration, easing);
    animate(menu, [
      { transform: opened ? menuFrom : "translateY(12px) scale(.9)", opacity: from.opacity },
      { transform: closing ? "translateY(10px) scale(.94)" : "none", opacity: closing ? "0" : "1" },
    ], duration, easing);
    opened = true;
    return Promise.all(animations.map(animation => animation.finished.then(() => true, () => false))).then(results => {
      if (disposed || revision !== token || results.some(result => !result)) return false;
      // Retain the finished entry frames until exit; cancelling here can leave stale WebKit clips.
      if (closing) cancelAnimations();
      root.dataset.overlayState = closing ? "closed" : "open";
      return true;
    });
  }
  function resize() {
    if (closing || disposed || resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      if (JSON.stringify(layout()) !== previousLayout) transition("enter");
    });
  }
  const observer = new ResizeObserver(resize);
  observer.observe(menu);
  window.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("scroll", resize);
  return {
    open: () => transition("enter"),
    close: () => transition("exit"),
    dispose() {
      if (disposed) return;
      disposed = true;
      revision++;
      cancelAnimationFrame(resizeFrame);
      cancelAnimations();
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("scroll", resize);
      restoreBackground();
      restoreSource();
      preview.replaceChildren();
    },
  };
}
