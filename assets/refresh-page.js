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

let reloading = false;

export async function reloadFromFirebase() {
  if (reloading) return;
  reloading = true;
  try {
    await resetLocalData();
    window.location.reload();
  } catch (error) {
    reloading = false;
    window.__myDocumentsResetting = false;
    window.dispatchEvent(new Event("my-documents:reset-cancel"));
    throw error;
  }
}
