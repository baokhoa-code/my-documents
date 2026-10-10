const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const activeMotion = new WeakMap();

export function cancelOverlayMotion(element) {
  const motion = element && activeMotion.get(element);
  if (!motion) return;
  activeMotion.delete(element);
  motion.animations.forEach(animation => animation.cancel());
  if (motion.phase === "exit") element.inert = motion.previousInert;
  delete element.dataset.overlayState;
}

export function animateOverlay(element, phase, kind = "dialog") {
  if (!element) return Promise.resolve(true);
  const previous = activeMotion.get(element);
  const interrupted = previous && !previous.finished;
  const panel = kind === "dialog"
    ? element.querySelector(".mfa-card, [role='alertdialog']") || element
    : element;
  // Read the current frame before cancelling, so a quick reopen continues smoothly.
  const opacity = getComputedStyle(element).opacity;
  const transform = getComputedStyle(panel).transform;
  const previousInert = previous?.phase === "exit" ? previous.previousInert : element.inert;
  cancelOverlayMotion(element);
  element.inert = phase === "exit" ? true : previousInert;
  element.dataset.overlayState = phase === "enter" ? "opening" : "closing";
  const motion = { phase, previousInert, animations: [], finished: false };
  activeMotion.set(element, motion);

  if (!reducedMotion.matches && typeof element.animate === "function") {
    const options = {
      duration: phase === "enter" ? 200 : 160,
      easing: phase === "enter" ? "cubic-bezier(.2,.8,.2,1)" : "cubic-bezier(.4,0,1,1)",
      fill: "both",
    };
    motion.animations.push(element.animate([
      { opacity: phase === "enter" && !interrupted ? 0 : opacity },
      { opacity: phase === "enter" ? 1 : 0 },
    ], options));
    // Full-screen previews only fade; their image coordinates stay stable while zooming.
    if (kind === "menu" || kind === "dialog") {
      const offset = kind === "menu" ? "translateY(-6px) scale(.97)" : "translateY(12px) scale(.97)";
      motion.animations.push(panel.animate([
        { transform: phase === "enter" && !interrupted ? offset : transform },
        { transform: phase === "enter" ? "none" : offset },
      ], options));
    }
  }

  return Promise.all(motion.animations.map(animation =>
    animation.finished.then(() => true, () => false),
  )).then(results => {
    if (activeMotion.get(element) !== motion || results.some(finished => !finished)) return false;
    motion.finished = true;
    element.dataset.overlayState = phase === "enter" ? "open" : "closed";
    if (phase === "enter") motion.animations.forEach(animation => animation.cancel());
    return true;
  });
}
