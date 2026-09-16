const COMPOSER_SELECTOR = "textarea.composer-input";
const boundComposers = new WeakSet();

function keepEnterForNewLine(event) {
  if (event.key === "Enter") {
    event.stopPropagation();
  }
}

function bindComposer(composer) {
  if (boundComposers.has(composer)) return;

  boundComposers.add(composer);
  composer.setAttribute("enterkeyhint", "enter");
  composer.addEventListener("keydown", keepEnterForNewLine);
}

function bindComposers() {
  document.querySelectorAll(COMPOSER_SELECTOR).forEach(bindComposer);
}

const root = document.getElementById("root");
const observer = new MutationObserver(() =>
  window.requestAnimationFrame(bindComposers),
);

if (root) observer.observe(root, { childList: true, subtree: true });
bindComposers();
