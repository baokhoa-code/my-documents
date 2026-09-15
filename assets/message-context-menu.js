const MESSAGE_SELECTOR = ".message-row";
const OPTIONS_SELECTOR = 'button[aria-label="Tùy chọn tin nhắn"]';

function openMessageMenu(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  const message = target.closest(MESSAGE_SELECTOR);
  if (!message || !message.closest("[data-thread]")) return;

  const optionsButton = message.querySelector(OPTIONS_SELECTOR);
  if (!(optionsButton instanceof HTMLButtonElement)) return;

  event.preventDefault();
  event.stopPropagation();

  if (optionsButton.getAttribute("aria-expanded") !== "true") {
    optionsButton.click();
  }
}

document.addEventListener("contextmenu", openMessageMenu, true);
