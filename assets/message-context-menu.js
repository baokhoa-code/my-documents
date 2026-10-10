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
    optionsButton.click();
  }
}

document.addEventListener("contextmenu", openMessageMenu, true);
