const SCROLL_AWAY_THRESHOLD = 64;
const KEYBOARD_HEIGHT_THRESHOLD = 80;

let thread = null;

const button = document.createElement("button");
button.type = "button";
button.className = "grid size-11 place-items-center rounded-full border border-line bg-bubble text-accent shadow-lg";
button.setAttribute("aria-label", "Đi đến tin nhắn mới nhất");
button.title = "Tin nhắn mới nhất";
button.hidden = true;
button.style.cssText = [
  "position:fixed",
  "z-index:60",
  "transform:translateX(-50%)",
  "transition:opacity 150ms ease, transform 150ms ease",
].join(";");
button.innerHTML = `
  <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round">
    <path d="m6 9 6 6 6-6"></path>
  </svg>
`;
document.body.append(button);

function keyboardIsOpen() {
  const viewport = window.visualViewport;
  return Boolean(viewport && window.innerHeight - viewport.height > KEYBOARD_HEIGHT_THRESHOLD);
}

function isAwayFromLatest() {
  if (!thread) return false;
  const remaining = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
  return remaining > SCROLL_AWAY_THRESHOLD;
}

function updateButton() {
  if (!thread || !thread.isConnected || keyboardIsOpen() || !isAwayFromLatest()) {
    button.hidden = true;
    return;
  }

  const rect = thread.getBoundingClientRect();
  button.style.left = `${rect.left + rect.width / 2}px`;
  button.style.top = `${Math.max(rect.top + 12, rect.bottom - 60)}px`;
  button.hidden = false;
}

function bindThread(nextThread) {
  if (thread === nextThread) {
    updateButton();
    return;
  }

  thread?.removeEventListener("scroll", updateButton);
  thread = nextThread;
  thread?.addEventListener("scroll", updateButton, { passive: true });
  updateButton();
}

function findThread() {
  bindThread(document.querySelector("[data-thread]"));
}

button.addEventListener("click", () => {
  if (!thread) return;
  thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
});

const observer = new MutationObserver(() => requestAnimationFrame(findThread));
observer.observe(document.getElementById("root"), { childList: true, subtree: true });

window.addEventListener("resize", updateButton, { passive: true });
window.addEventListener("orientationchange", updateButton, { passive: true });
window.visualViewport?.addEventListener("resize", updateButton, { passive: true });
window.visualViewport?.addEventListener("scroll", updateButton, { passive: true });

findThread();
