import { isChatKeyboardOpen } from "./chat-viewport.js?v=4";

const SCROLL_AWAY_THRESHOLD = 64;

let thread = null;
let updateFrame = 0;
const button = document.createElement("button");
button.type = "button";
button.className = "grid size-11 place-items-center rounded-full border border-line bg-bubble text-accent shadow-lg";
button.setAttribute("aria-label", "Đi đến tin nhắn mới nhất");
button.title = "Tin nhắn mới nhất";
button.hidden = true;
button.style.cssText = [
  "position:fixed",
  "z-index:60",
  "transform:translateX(-100%)",
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

function isAwayFromLatest() {
  if (!thread) return false;
  const remaining = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
  return remaining > SCROLL_AWAY_THRESHOLD;
}

function modalIsVisible() {
  return [...document.querySelectorAll('[aria-modal="true"]')].some(modal =>
    modal.getClientRects().length > 0 && getComputedStyle(modal).visibility !== "hidden",
  );
}

function updateButton() {
  if (
    !thread ||
    !thread.isConnected ||
    modalIsVisible() ||
    isChatKeyboardOpen() ||
    !isAwayFromLatest()
  ) {
    button.hidden = true;
    return;
  }

  const rect = thread.getBoundingClientRect();
  if (!rect.width || !rect.height) { button.hidden = true; return; }
  button.style.left = `${rect.right - 12}px`;
  button.style.top = `${Math.max(rect.top + 12, rect.bottom - 60)}px`;
  button.hidden = false;
}

function bindThread(nextThread) {
  if (thread === nextThread) {
    updateButton();
    return;
  }

  thread?.removeEventListener("scroll", updateButton);
  resizeObserver?.disconnect();
  thread = nextThread;
  thread?.addEventListener("scroll", updateButton, { passive: true });
  if (thread) resizeObserver?.observe(thread);
  updateButton();
}

function findThread() {
  bindThread(document.querySelector("[data-thread]"));
}

function scheduleUpdate() {
  if (updateFrame) return;
  updateFrame = requestAnimationFrame(() => {
    updateFrame = 0;
    findThread();
  });
}

button.addEventListener("click", () => {
  if (!thread) return;
  thread.scrollTo({ top: thread.scrollHeight, behavior: "smooth" });
});

const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleUpdate) : null;
const observer = new MutationObserver(records => {
  if (records.some(record => !button.contains(record.target))) scheduleUpdate();
});
// Native dialogs live outside React's root and toggle visibility without being removed.
observer.observe(document.body, {
  childList: true, subtree: true, attributes: true,
  attributeFilter: ["hidden", "aria-modal", "aria-hidden", "data-overlay-state"],
});

window.addEventListener("chatviewportchange", scheduleUpdate);
window.addEventListener("resize", scheduleUpdate, { passive: true });

findThread();
