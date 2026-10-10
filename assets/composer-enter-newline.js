const COMPOSER_SELECTOR = "textarea.composer-input";
const boundComposers = new WeakSet();
const desktopKeyboard = window.matchMedia("(hover: hover) and (pointer: fine)");

function keepEnterForNewLine(event) {
  if (
    event.key === "Enter" &&
    (!desktopKeyboard.matches || event.shiftKey || event.isComposing || event.keyCode === 229)
  ) {
    event.stopPropagation();
  }
}

function bindComposer(composer) {
  composer.setAttribute("enterkeyhint", desktopKeyboard.matches ? "send" : "enter");
  if (boundComposers.has(composer)) return;

  boundComposers.add(composer);
  composer.addEventListener("keydown", keepEnterForNewLine);
}

function bindComposers() {
  document.querySelectorAll(COMPOSER_SELECTOR).forEach(bindComposer);
}

const root = document.getElementById("root");
const observer = new MutationObserver(bindComposers);

if (root) observer.observe(root, { childList: true, subtree: true });
desktopKeyboard.addEventListener?.("change", bindComposers);
bindComposers();
