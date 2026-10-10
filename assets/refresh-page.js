const BUTTON_ID = "refresh-page-button";
const APP_STORAGE_KEY = /^(my-documents(?:[-.:]|$)|mydocuments(?:[-.:]|$))/i;

function clearStorage(storage) {
  for (const key of Object.keys(storage)) {
    if (APP_STORAGE_KEY.test(key)) storage.removeItem(key);
  }
}

async function clearDatabases() {
  if (!window.indexedDB) return;
  const databases = indexedDB.databases
    ? await indexedDB.databases()
    : [{ name: "my-documents-local-vault" }];
  await Promise.all(databases.filter(({ name }) => name && APP_STORAGE_KEY.test(name)).map(({ name }) =>
    new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      // Navigation closes connections from an older version of this page.
      request.onblocked = () => resolve();
    }),
  ));
}

async function clearAppCaches() {
  if (!window.caches) return;
  const directory = new URL("./", window.location.href);
  const names = await caches.keys();
  await Promise.all(names.map(async (name) => {
    if (APP_STORAGE_KEY.test(name)) { await caches.delete(name); return; }
    const cache = await caches.open(name);
    const requests = await cache.keys();
    await Promise.all(requests.filter(({ url }) => url.startsWith(directory.href)).map(request => cache.delete(request)));
  }));
  const registrations = await navigator.serviceWorker?.getRegistrations() || [];
  await Promise.all(registrations.filter(({ scope }) => scope.startsWith(directory.href)).map(registration => registration.unregister()));
}

async function resetLocalData() {
  window.__myDocumentsResetting = true;
  window.dispatchEvent(new Event("my-documents:reset-local"));
  clearStorage(localStorage);
  clearStorage(sessionStorage);
  await Promise.all([clearDatabases(), clearAppCaches()]);
  // A pending callback must not restore the old cache while cleanup is running.
  clearStorage(localStorage);
  clearStorage(sessionStorage);
}

function createRefreshButton(referenceButton) {
  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.className = `${referenceButton.className} page-refresh-button`;
  button.setAttribute("aria-label", "Xóa cache local và tải lại từ Firebase");
  button.title = "Xóa cache local và tải lại từ Firebase";
  button.innerHTML = `
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24"
         fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 6v6h-6"></path>
      <path d="M20 12a8 8 0 1 0-2.34 5.66L20 15.32"></path>
    </svg>
  `;
  button.addEventListener("click", async () => {
    if (button.classList.contains("is-refreshing")) return;
    button.classList.add("is-refreshing");
    button.disabled = true;
    button.setAttribute("aria-disabled", "true");
    try {
      await resetLocalData();
      window.location.reload();
    } catch (error) {
      window.__myDocumentsResetting = false;
      window.dispatchEvent(new Event("my-documents:reset-cancel"));
      button.classList.remove("is-refreshing");
      button.disabled = false;
      button.removeAttribute("aria-disabled");
      button.title = "Không xóa được cache local. Bấm để thử lại.";
      console.error("Không xóa được cache local", error);
    }
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
