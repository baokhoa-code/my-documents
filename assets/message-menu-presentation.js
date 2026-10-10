import { releaseMessageHold } from "./message-context-menu.js?v=5";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const move = (x, y, scale = 1) => `translate(${x}px, ${y}px) scale(${scale})`;

export function createMessageMenuPresentation(root, menu, message) {
  const source = message.querySelector("article");
  const preview = root.querySelector(".message-menu-preview");
  const backdrop = root.querySelector(".message-menu-backdrop");
  const sourceBounds = source.getBoundingClientRect();
  const sourceWidth = source.offsetWidth, sourceHeight = source.offsetHeight;
  const previousVisibility = source.style.visibility;
  const clone = source.cloneNode(true);
  clone.removeAttribute("id");
  clone.querySelectorAll("[id]").forEach(element => element.removeAttribute("id"));
  clone.querySelectorAll(".message-hold-ripple-layer").forEach(element => element.remove());
  clone.classList.remove("message-hold-target");
  Object.assign(clone.style, {
    width: `${sourceWidth}px`, height: `${sourceHeight}px`, maxWidth: "none",
    margin: "0", visibility: "visible", transform: "none",
  });
  preview.append(clone);
  Object.assign(preview.style, { width: `${sourceWidth}px`, height: `${sourceHeight}px`, borderRadius: getComputedStyle(source).borderRadius });
  preview.style.transform = move(sourceBounds.left, sourceBounds.top, sourceBounds.width / sourceWidth);
  backdrop.style.opacity = "0";
  menu.style.opacity = "0";
  source.style.visibility = "hidden";
  releaseMessageHold(message);

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
      menu: move(clamp(right - menuWidth, left + 12, left + width - menuWidth - 12), y + sourceHeight * scale + gap),
    };
  }
  function current() {
    return {
      preview: getComputedStyle(preview).transform,
      menu: getComputedStyle(menu).transform,
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
    root.inert = closing;
    root.dataset.overlayState = closing ? "closing" : "opening";
    previousLayout = JSON.stringify(target);
    const duration = closing ? 220 : 280;
    const easing = closing ? "cubic-bezier(.4,0,.2,1)" : "cubic-bezier(.2,.9,.25,1.04)";
    animate(backdrop, [{ opacity: from.backdrop }, { opacity: closing ? "0" : "1" }], closing ? 220 : 230, "ease-out");
    animate(preview, [{ transform: from.preview }, { transform: closing ? sourcePosition() : target.preview }], duration, easing);
    animate(menu, [
      { transform: opened ? from.menu : `${target.menu} translateY(12px) scale(.9)`, opacity: from.opacity },
      { transform: closing ? `${target.menu} translateY(10px) scale(.94)` : target.menu, opacity: closing ? "0" : "1" },
    ], duration, easing);
    opened = true;
    return Promise.all(animations.map(animation => animation.finished.then(() => true, () => false))).then(results => {
      if (disposed || revision !== token || results.some(result => !result)) return false;
      cancelAnimations();
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
      source.style.visibility = previousVisibility;
      preview.replaceChildren();
    },
  };
}
