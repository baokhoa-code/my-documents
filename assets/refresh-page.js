const BUTTON_ID = "refresh-page-button";

function createRefreshButton(referenceButton) {
  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.className = `${referenceButton.className} page-refresh-button`;
  button.setAttribute("aria-label", "Tải lại toàn bộ trang");
  button.title = "Tải lại trang";
  button.innerHTML = `
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 6v6h-6"></path>
      <path d="M20 12a8 8 0 1 0-2.34 5.66L20 15.32"></path>
    </svg>
  `;
  button.addEventListener("click", () => {
    if (button.classList.contains("is-refreshing")) return;
    button.classList.add("is-refreshing");
    button.setAttribute("aria-disabled", "true");
    window.setTimeout(() => window.location.reload(), 100);
  });
  return button;
}

function mountRefreshButton() {
  const searchButton = document.querySelector(
    '.app-header button[aria-label="Tìm"]',
  );
  if (!searchButton?.parentElement) return;

  const existing = document.getElementById(BUTTON_ID);
  if (existing) {
    if (existing.nextElementSibling !== searchButton) {
      searchButton.parentElement.insertBefore(existing, searchButton);
    }
    return;
  }

  searchButton.parentElement.insertBefore(
    createRefreshButton(searchButton),
    searchButton,
  );
}

const root = document.getElementById("root");
const observer = new MutationObserver(() =>
  window.requestAnimationFrame(mountRefreshButton),
);
if (root) observer.observe(root, { childList: true, subtree: true });

mountRefreshButton();
