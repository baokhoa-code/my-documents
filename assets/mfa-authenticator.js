const FIREBASE_CONFIG_URL = "./hub/firebase-config.json";
const FIREBASE_PATH = "hub/mfaAccounts";
const CACHE_KEY = "my-documents-mfa-accounts-v2";
const LEGACY_VALUE_KEY = "my-documents-local-totp-v1";
const LEGACY_DB = "my-documents-local-vault";
const LEGACY_STORE = "keys";
const LEGACY_KEY_ID = "totp-aes-v1";

let accounts = normalizeAccounts(readCache());
let databaseUrl = "";
let stream = null;
let pollTimer = null;
let tickTimer = null;
let initialized = false;
let currentView = "list";
let searchQuery = "";
let syncPromise = null;
let returnFocus = null;

const decoder = new TextDecoder();

function readCache() {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeCache() {
  if (window.__myDocumentsResetting) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(accounts));
  } catch {
    // Đồng bộ Firebase vẫn hoạt động khi bộ nhớ trình duyệt đã đầy.
  }
}

function normalizeBase32(value) {
  return value.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = normalizeBase32(value);
  if (!clean) throw new Error("Khóa bí mật đang trống.");
  if (clean.length < 2 || /[^A-Z2-7=\s-]/i.test(value)) {
    throw new Error("Khóa MFA không đúng định dạng Base32.");
  }
  let bits = "";
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("Khóa bí mật không đúng định dạng Base32.");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return new Uint8Array(bytes);
}

function parseOtpAuth(value) {
  const input = value.trim();
  if (!input.toLowerCase().startsWith("otpauth://")) {
    if (input) decodeBase32(input);
    return {
      secret: normalizeBase32(input),
      label: "Tài khoản MFA",
      issuer: "MFA",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    };
  }
  const url = new URL(input);
  if (url.protocol !== "otpauth:" || url.hostname !== "totp") {
    throw new Error("QR này không phải mã TOTP.");
  }
  const label = decodeURIComponent(url.pathname.replace(/^\//, "")) || "Tài khoản MFA";
  const secret = url.searchParams.get("secret") || "";
  decodeBase32(secret);
  return {
    secret: normalizeBase32(secret),
    label,
    issuer: url.searchParams.get("issuer") || label.split(":")[0] || "MFA",
    algorithm: (url.searchParams.get("algorithm") || "SHA1").toUpperCase(),
    digits: Number(url.searchParams.get("digits") || 6),
    period: Number(url.searchParams.get("period") || 30),
  };
}

async function generateTotp(account, now = Date.now()) {
  const hash = { SHA1: "SHA-1", SHA256: "SHA-256", SHA512: "SHA-512" }[account.algorithm];
  if (!hash || ![6, 8].includes(account.digits) || !Number.isFinite(account.period) || account.period < 15) {
    throw new Error("Thông số TOTP không được hỗ trợ.");
  }
  const counter = BigInt(Math.floor(now / 1000 / account.period));
  const message = new Uint8Array(8);
  let remaining = counter;
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase32(account.secret),
    { name: "HMAC", hash },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = digest[digest.length - 1] & 15;
  const number =
    (((digest[offset] & 127) << 24) |
      (digest[offset + 1] << 16) |
      (digest[offset + 2] << 8) |
      digest[offset + 3]) %
    10 ** account.digits;
  return String(number).padStart(account.digits, "0");
}

async function loadFirebaseConfig() {
  const response = await fetch(`${FIREBASE_CONFIG_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Không tải được cấu hình Firebase.");
  const config = await response.json();
  if (!config.databaseURL) throw new Error("Cấu hình Firebase thiếu databaseURL.");
  databaseUrl = config.databaseURL.replace(/\/$/, "");
}

function firebaseEndpoint(child = "") {
  const suffix = child ? `/${encodeURIComponent(child)}` : "";
  return `${databaseUrl}/${FIREBASE_PATH}${suffix}.json`;
}

function normalizeAccount(value, id = value?.id) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const label = String(value.label || value.issuer || "Tài khoản");
  const legacyEmail = label.includes(":") ? label.slice(label.indexOf(":") + 1).trim() : label;
  return {
    ...value,
    id,
    platform: String(value.platform || (value.issuer && value.issuer !== "MFA" ? value.issuer : label.split(":")[0])),
    email: String(value.email ?? (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(legacyEmail) ? legacyEmail : "")),
    password: String(value.password ?? ""),
    secret: normalizeBase32(String(value.secret || "")),
    label,
    issuer: String(value.issuer || "MFA"),
    algorithm: String(value.algorithm || "SHA1").toUpperCase(),
    digits: Number(value.digits || 6),
    period: Number(value.period || 30),
  };
}

function normalizeAccounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([id, account]) => [id, normalizeAccount(account, id)])
      .filter(([, account]) => account),
  );
}

async function fetchAccounts() {
  const response = await fetch(`${firebaseEndpoint()}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Firebase HTTP ${response.status}`);
  accounts = normalizeAccounts(await response.json());
  writeCache();
  if (!modal.hidden && currentView === "list") refreshAccountList();
}

async function saveAccount(account) {
  if (!databaseUrl) await loadFirebaseConfig();
  const id = account.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const record = { ...normalizeAccount(account, id), updatedAt: Date.now() };
  const response = await fetch(firebaseEndpoint(id), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(record),
  });
  if (!response.ok) throw new Error(`Firebase HTTP ${response.status}`);
  accounts[id] = record;
  writeCache();
}

async function removeAccount(id) {
  const response = await fetch(firebaseEndpoint(id), { method: "DELETE" });
  if (!response.ok) throw new Error(`Firebase HTTP ${response.status}`);
  delete accounts[id];
  writeCache();
}

function applyStreamEvent(event, isPatch) {
  try {
    const payload = JSON.parse(event.data);
    const parts = String(payload.path || "/").split("/").filter(Boolean);
    function put(path, value) {
      if (!path.length) { accounts = normalizeAccounts(value); return; }
      let target = accounts;
      for (const key of path.slice(0, -1)) target = target[key] ||= {};
      const key = path.at(-1);
      if (value == null) delete target[key];
      else target[key] = value;
    }
    if (isPatch) {
      for (const [key, value] of Object.entries(payload.data || {})) put([...parts, ...key.split("/")], value);
    } else put(parts, payload.data);
    accounts = normalizeAccounts(accounts);
    writeCache();
    if (!modal.hidden && currentView === "list") refreshAccountList();
  } catch {
    // EventSource tự kết nối lại; lần mở tiếp theo luôn tải snapshot mới.
  }
}

function startRealtimeSync() {
  if (window.__myDocumentsResetting) return;
  if ("EventSource" in window) {
    stream?.close();
    stream = new EventSource(firebaseEndpoint());
    stream.addEventListener("put", (event) => applyStreamEvent(event, false));
    stream.addEventListener("patch", (event) => applyStreamEvent(event, true));
  } else {
    clearInterval(pollTimer);
    pollTimer = window.setInterval(() => fetchAccounts().catch(() => {}), 5000);
  }
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function migrateLegacyAccount() {
  const raw = localStorage.getItem(LEGACY_VALUE_KEY);
  if (!raw) return;
  try {
    const record = JSON.parse(raw);
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(LEGACY_DB, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let key;
    try {
      key = await new Promise((resolve, reject) => {
        const request = db.transaction(LEGACY_STORE).objectStore(LEGACY_STORE).get(LEGACY_KEY_ID);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
    if (!key) return;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(record.iv) },
      key,
      base64ToBytes(record.data),
    );
    const account = JSON.parse(decoder.decode(plaintext));
    if (account.secret) await saveAccount(account);
    localStorage.removeItem(LEGACY_VALUE_KEY);
  } catch {
    // Giữ dữ liệu cũ nguyên vẹn nếu không thể chuyển đổi.
  }
}

window.addEventListener("my-documents:reset-local", () => {
  stream?.close();
  stream = null;
  clearInterval(pollTimer);
  clearInterval(tickTimer);
});

window.addEventListener("my-documents:reset-cancel", () => {
  if (!initialized) return;
  startRealtimeSync();
  startTicker();
});

async function initializeSync() {
  if (initialized) return;
  if (!syncPromise) {
    syncPromise = (async () => {
      await loadFirebaseConfig();
      await fetchAccounts();
      await migrateLegacyAccount();
      startRealtimeSync();
      initialized = true;
    })().finally(() => { syncPromise = null; });
  }
  await syncPromise;
}

const icons = {
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>',
  edit: '<path d="m16 3 5 5-12 12-6 1 1-6Z"></path><path d="m14 5 5 5"></path>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"></path>',
  plus: '<path d="M12 5v14M5 12h14"></path>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 5 5"></path>',
  close: '<path d="m6 6 12 12M6 18 18 6"></path>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"></circle><path d="m21 2-9.6 9.6M15 7l2 2m1-5 2 2"></path>',
  check: '<path d="m5 12 4 4L19 6"></path>',
};
function icon(name) {
  return `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`;
}

const modal = document.createElement("div");
modal.className = "mfa-modal";
modal.hidden = true;
modal.innerHTML = `
  <section class="mfa-card" role="dialog" aria-modal="true" aria-labelledby="mfa-title" tabindex="-1">
    <header class="mfa-head">
      <div class="mfa-heading"><span class="mfa-heading-icon">${icon("key")}</span><div><h2 id="mfa-title">Tài khoản & mật khẩu</h2><p class="mfa-meta">Lưu tài khoản · Mã xác thực tự cập nhật</p></div></div>
      <button class="mfa-close" type="button" aria-label="Đóng quản lý tài khoản">${icon("close")}</button>
    </header>
    <div class="mfa-body" data-mfa-body></div>
    <div class="mfa-toast" role="status" aria-live="polite" hidden></div>
  </section>
`;
document.body.append(modal);
const body = modal.querySelector("[data-mfa-body]");
let toastTimer = null;

function notify(message) {
  const toast = modal.querySelector(".mfa-toast");
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2000);
}

function showError(message) {
  const error = body.querySelector("[data-mfa-error]");
  if (error) error.textContent = message;
}

async function copyValue(value, label, button) {
  if (!value) return;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else {
      const input = document.createElement("textarea");
      input.value = value;
      input.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      modal.append(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      button?.focus();
      if (!copied) throw new Error("Clipboard unavailable");
    }
    notify(`Đã sao chép ${label.toLowerCase()}`);
  } catch {
    notify("Không sao chép được. Bạn có thể chọn và sao chép trực tiếp.");
  }
}

function startTicker() {
  clearInterval(tickTimer);
  if (modal.hidden || currentView !== "list") return;
  async function tick() {
    for (const card of body.querySelectorAll("[data-mfa-account]")) {
      const account = accounts[card.dataset.mfaAccount];
      if (!account?.secret) continue;
      try {
        const code = await generateTotp(account);
        if (!card.isConnected) continue;
        const remaining = account.period - (Math.floor(Date.now() / 1000) % account.period);
        const button = card.querySelector("[data-mfa-code]");
        button.textContent = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : `${code.slice(0, 4)} ${code.slice(4)}`;
        button.dataset.code = code;
        button.disabled = false;
        card.querySelector("[data-mfa-progress]").style.width = `${(remaining / account.period) * 100}%`;
        card.querySelector("[data-mfa-countdown]").textContent = `${remaining}s`;
      } catch {
        const button = card.querySelector("[data-mfa-code]");
        button.textContent = "Lỗi mã";
        button.disabled = true;
        delete button.dataset.code;
        card.querySelector("[data-mfa-countdown]").textContent = "Kiểm tra khóa MFA";
      }
    }
  }
  tick();
  tickTimer = window.setInterval(tick, 1000);
}

function credentialRow(label, value, mono = false) {
  const row = document.createElement("div");
  row.className = "mfa-credential";
  const text = document.createElement("button");
  text.type = "button";
  text.className = "mfa-credential-content";
  text.setAttribute("aria-label", `Bấm để sao chép ${label.toLowerCase()}`);
  text.title = `Sao chép ${label.toLowerCase()}`;
  text.disabled = !value;
  text.addEventListener("click", () => copyValue(value, label, text));
  const caption = document.createElement("span");
  caption.className = "mfa-field-label";
  caption.textContent = label;
  const content = document.createElement("span");
  content.className = `mfa-value${mono ? " mfa-mono" : ""}${value ? "" : " mfa-value-empty"}`;
  content.textContent = value || "Chưa thêm";
  text.append(caption, content);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "mfa-copy";
  copy.setAttribute("aria-label", `Sao chép ${label.toLowerCase()}`);
  copy.title = copy.getAttribute("aria-label");
  copy.innerHTML = icon("copy");
  copy.disabled = !value;
  copy.addEventListener("click", () => copyValue(value, label, copy));
  row.append(text, copy);
  return row;
}

function createAccountCard(account) {
  const card = document.createElement("article");
  card.className = "mfa-account";
  card.dataset.mfaAccount = account.id;
  card.innerHTML = `
    <div class="mfa-card-head">
      <div class="mfa-account-heading"><span class="mfa-platform-icon" data-mfa-avatar></span><div><h3><button class="mfa-platform-value" data-mfa-platform type="button" aria-label="Sao chép nền tảng" title="Sao chép nền tảng"></button></h3><span class="mfa-account-badge" data-mfa-badge></span></div></div>
      <div class="mfa-actions"><button class="mfa-icon-button" type="button" data-mfa-edit aria-label="Sửa tài khoản" title="Sửa tài khoản">${icon("edit")}</button><button class="mfa-icon-button mfa-danger" type="button" data-mfa-delete aria-label="Xóa tài khoản" title="Xóa tài khoản">${icon("trash")}</button></div>
    </div>
    <div class="mfa-credentials" data-mfa-credentials></div>
    <div class="mfa-otp" data-mfa-otp>
      <div class="mfa-row"><span class="mfa-field-label">Mã xác thực</span><span class="mfa-countdown" data-mfa-countdown></span></div>
      <div class="mfa-row"><button class="mfa-code" type="button" data-mfa-code disabled aria-label="Sao chép mã xác thực">··· ···</button><button class="mfa-copy" type="button" data-mfa-copy-code aria-label="Sao chép code" title="Sao chép code">${icon("copy")}</button></div>
      <div class="mfa-progress"><span data-mfa-progress></span></div>
    </div>
  `;
  card.querySelector("[data-mfa-platform]").textContent = account.platform;
  card.querySelector("[data-mfa-platform]").addEventListener("click", (event) => copyValue(account.platform, "Nền tảng", event.currentTarget));
  card.querySelector("[data-mfa-avatar]").textContent = account.platform.slice(0, 1).toUpperCase();
  card.querySelector("[data-mfa-badge]").textContent = account.secret ? "Có MFA" : "Tài khoản";
  let colorIndex = 0;
  for (const char of account.platform) colorIndex = (colorIndex + char.codePointAt(0)) % 5;
  card.querySelector("[data-mfa-avatar]").dataset.color = colorIndex;
  const credentials = card.querySelector("[data-mfa-credentials]");
  credentials.append(credentialRow("Email / tên đăng nhập", account.email), credentialRow("Mật khẩu", account.password, true), credentialRow("Khóa MFA", account.secret, true));
  const codeButton = card.querySelector("[data-mfa-code]");
  const copyCode = card.querySelector("[data-mfa-copy-code]");
  for (const button of [codeButton, copyCode]) button.addEventListener("click", () => copyValue(codeButton.dataset.code, "Mã xác thực", button));
  if (!account.secret) {
    card.querySelector("[data-mfa-otp]").innerHTML = `<p class="mfa-no-otp">${icon("key")} Chưa có MFA</p>`;
  }
  card.querySelector("[data-mfa-edit]").addEventListener("click", () => renderSetup(account));
  card.querySelector("[data-mfa-delete]").addEventListener("click", async (event) => {
    const name = [account.platform, account.email].filter(Boolean).join(" · ");
    if (!window.confirm(`Xóa tài khoản “${name}” trên tất cả thiết bị?`)) return;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await removeAccount(account.id);
      refreshAccountList();
      notify("Đã xóa tài khoản");
    } catch (error) {
      button.disabled = false;
      showError(error instanceof Error ? error.message : "Không xóa được tài khoản.");
    }
  });
  return card;
}

function refreshAccountList() {
  const list = body.querySelector("[data-mfa-list]");
  if (!list) return;
  const query = searchQuery.trim().toLocaleLowerCase("vi");
  const all = Object.values(accounts).map((value) => normalizeAccount(value)).filter(Boolean);
  const sorted = all.filter((account) => `${account.platform} ${account.email} ${account.label}`.toLocaleLowerCase("vi").includes(query))
    .sort((a, b) => a.platform.localeCompare(b.platform, "vi") || a.email.localeCompare(b.email, "vi"));
  body.querySelector("[data-mfa-total]").textContent = `${all.length} tài khoản`;
  body.querySelector("[data-mfa-results]").textContent = query ? `${sorted.length} kết quả` : "";
  const focused = document.activeElement;
  const focusedCard = focused?.closest("[data-mfa-account]");
  const focusId = focusedCard?.dataset.mfaAccount;
  const focusLabel = focusId ? focused.getAttribute("aria-label") : null;
  list.replaceChildren();
  if (!sorted.length) {
    const empty = document.createElement("div");
    empty.className = "mfa-empty";
    empty.innerHTML = `${icon(query ? "search" : "key")}<h3></h3><p></p>`;
    empty.querySelector("h3").textContent = query ? "Không tìm thấy tài khoản" : "Chưa có tài khoản";
    empty.querySelector("p").textContent = query ? "Thử tìm bằng nền tảng hoặc email khác." : "Thêm nền tảng, email, mật khẩu và khóa MFA nếu có.";
    list.append(empty);
  } else {
    for (const account of sorted) list.append(createAccountCard(account));
  }
  if (focusId && focusLabel) {
    const card = [...list.children].find((element) => element.dataset.mfaAccount === focusId);
    const replacement = card && [...card.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === focusLabel);
    (replacement || body.querySelector("[data-mfa-search]")).focus({ preventScroll: true });
  }
  startTicker();
}

function renderList() {
  currentView = "list";
  clearInterval(tickTimer);
  body.innerHTML = `
    <div class="mfa-toolbar"><div><h3>Danh sách tài khoản</h3><p class="mfa-meta" data-mfa-total></p></div><button class="mfa-primary" data-mfa-add type="button">${icon("plus")}<span>Thêm tài khoản</span></button></div>
    <div class="mfa-search-wrap"><label class="mfa-search">${icon("search")}<input data-mfa-search type="search" placeholder="Tìm nền tảng, email…" aria-label="Tìm tài khoản" autocomplete="off"></label><span class="mfa-meta" data-mfa-results></span></div>
    <p class="mfa-error" data-mfa-error role="alert"></p>
    <div class="mfa-account-list" data-mfa-list></div>
  `;
  const search = body.querySelector("[data-mfa-search]");
  search.value = searchQuery;
  search.addEventListener("input", () => { searchQuery = search.value; refreshAccountList(); });
  body.querySelector("[data-mfa-add]").addEventListener("click", () => renderSetup());
  refreshAccountList();
  body.scrollTop = 0;
}

function renderSetup(existing = null) {
  currentView = "setup";
  clearInterval(tickTimer);
  body.innerHTML = `
    <div class="mfa-form-top"><button class="mfa-back" data-mfa-back type="button">← Danh sách tài khoản</button><span class="mfa-meta">${existing ? "Chỉnh sửa" : "Tài khoản mới"}</span></div>
    <form class="mfa-form" data-mfa-form autocomplete="off">
      <div class="mfa-form-heading"><h3>${existing ? "Sửa tài khoản" : "Thêm tài khoản"}</h3><p class="mfa-meta">Điền thông tin bạn muốn lưu. Khóa MFA là tùy chọn.</p></div>
      <div class="mfa-form-grid">
        <label class="mfa-form-label">Nền tảng <span class="mfa-required">*</span><input data-mfa-platform class="mfa-field" type="text" list="mfa-platforms" placeholder="Gmail, ChatGPT, Facebook…" maxlength="100" required><datalist id="mfa-platforms"><option value="Gmail"><option value="ChatGPT"><option value="Facebook"><option value="Instagram"><option value="Microsoft"><option value="Claude"><option value="GitHub"></datalist></label>
        <label class="mfa-form-label">Email / tên đăng nhập<input data-mfa-email class="mfa-field" type="text" inputmode="email" placeholder="email@example.com" spellcheck="false" autocapitalize="none" autocomplete="off"></label>
        <label class="mfa-form-label mfa-form-wide">Mật khẩu<input data-mfa-password class="mfa-field mfa-mono" type="text" placeholder="Nhập mật khẩu" spellcheck="false" autocapitalize="none" autocomplete="off"></label>
      </div>
      <div class="mfa-form-mfa"><div class="mfa-row"><h4>${icon("key")} Xác thực hai bước</h4><span class="mfa-optional">Tùy chọn</span></div><label class="mfa-form-label">Khóa MFA / mã thiết lập<textarea data-mfa-secret class="mfa-field mfa-mono" rows="2" spellcheck="false" autocapitalize="none" placeholder="Khóa Base32 hoặc đường dẫn otpauth://"></textarea></label><label class="mfa-file">${icon("plus")}<span>Đọc khóa từ ảnh QR</span><input data-mfa-file type="file" accept="image/*" aria-label="Chọn ảnh QR"></label><p class="mfa-meta" data-mfa-qr-status role="status"></p></div>
      <p class="mfa-error" data-mfa-error role="alert"></p>
      <div class="mfa-form-footer"><button class="mfa-secondary" data-mfa-cancel type="button">Hủy</button><button class="mfa-primary" data-mfa-save type="submit">${icon("check")}<span>${existing ? "Lưu thay đổi" : "Lưu tài khoản"}</span></button></div>
    </form>
  `;
  const form = body.querySelector("[data-mfa-form]");
  const platform = form.querySelector("[data-mfa-platform]");
  const email = form.querySelector("[data-mfa-email]");
  const password = form.querySelector("[data-mfa-password]");
  const secret = form.querySelector("[data-mfa-secret]");
  platform.value = existing?.platform || "";
  email.value = existing?.email || "";
  password.value = existing?.password || "";
  secret.value = existing?.secret || "";
  let otpOptions = existing ? { algorithm: existing.algorithm, digits: existing.digits, period: existing.period } : { algorithm: "SHA1", digits: 6, period: 30 };
  let saving = false;
  let scanVersion = 0;
  function backToList() { if (!saving) { renderList(); body.querySelector("[data-mfa-add]").focus(); } }
  body.querySelector("[data-mfa-back]").addEventListener("click", backToList);
  form.querySelector("[data-mfa-cancel]").addEventListener("click", backToList);
  secret.addEventListener("input", () => {
    scanVersion += 1;
    form.querySelector("[data-mfa-qr-status]").textContent = "";
    otpOptions = { algorithm: "SHA1", digits: 6, period: 30 };
  });
  form.querySelector("[data-mfa-file]").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const version = ++scanVersion;
    try {
      if (!("BarcodeDetector" in window)) throw new Error("Trình duyệt này chưa hỗ trợ đọc QR. Hãy dán khóa MFA vào ô bên trên.");
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const bitmap = await createImageBitmap(file);
      let codes;
      try { codes = await detector.detect(bitmap); } finally { bitmap.close(); }
      if (!form.isConnected || version !== scanVersion) return;
      if (!codes[0]?.rawValue) throw new Error("Không tìm thấy QR trong ảnh.");
      const scanned = parseOtpAuth(codes[0].rawValue);
      await generateTotp(scanned);
      if (!form.isConnected || version !== scanVersion) return;
      secret.value = scanned.secret;
      otpOptions = { algorithm: scanned.algorithm, digits: scanned.digits, period: scanned.period };
      if (!platform.value.trim()) platform.value = scanned.issuer;
      const candidate = normalizeAccount(scanned);
      if (!email.value.trim() && candidate.email) email.value = candidate.email;
      showError("");
      form.querySelector("[data-mfa-qr-status]").textContent = "Đã đọc khóa MFA từ QR.";
    } catch (error) {
      if (form.isConnected && version === scanVersion) showError(error instanceof Error ? error.message : "Không đọc được QR.");
    }
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    const button = form.querySelector("[data-mfa-save]");
    try {
      showError("");
      if (existing && !accounts[existing.id]) throw new Error("Tài khoản đã bị xóa trên thiết bị khác. Hãy quay lại danh sách.");
      const rawSecret = secret.value.trim();
      let otp = { ...otpOptions, secret: "" };
      if (rawSecret) {
        otp = rawSecret.toLowerCase().startsWith("otpauth://") ? parseOtpAuth(rawSecret) : { ...otpOptions, secret: rawSecret };
        await generateTotp(otp);
        otp.secret = normalizeBase32(otp.secret);
      }
      const account = {
        ...(existing ? accounts[existing.id] : {}),
        ...otp,
        platform: platform.value.trim(),
        email: email.value.trim(),
        password: password.value,
        label: [platform.value.trim(), email.value.trim()].filter(Boolean).join(":"),
        issuer: platform.value.trim(),
      };
      if (!account.platform) { platform.focus(); throw new Error("Vui lòng nhập nền tảng."); }
      saving = true;
      scanVersion += 1;
      form.querySelectorAll("input, textarea, button").forEach((input) => { input.disabled = true; });
      button.querySelector("span").textContent = "Đang lưu…";
      await saveAccount(account);
      // Bắt đầu nhận thay đổi trên thiết bị khác sau khi kết nối lại thành công.
      if (!initialized) initializeSync().catch(() => {});
      if (form.isConnected) { searchQuery = ""; renderList(); }
      notify(existing ? "Đã cập nhật tài khoản" : "Đã thêm tài khoản");
    } catch (error) {
      saving = false;
      if (!form.isConnected) return;
      form.querySelectorAll("input, textarea, button").forEach((input) => { input.disabled = false; });
      button.querySelector("span").textContent = existing ? "Lưu thay đổi" : "Lưu tài khoản";
      showError(error instanceof Error ? error.message : "Không lưu được tài khoản.");
    }
  });
  body.scrollTop = 0;
  platform.focus({ preventScroll: true });
}

async function openAuthenticator() {
  returnFocus = document.activeElement;
  modal.hidden = false;
  currentView = "list";
  body.innerHTML = `<p class="mfa-help mfa-loading">Đang tải tài khoản…</p>`;
  modal.querySelector(".mfa-close").focus();
  try {
    await initializeSync();
    await fetchAccounts();
    if (!modal.hidden && currentView === "list") renderList();
  } catch (error) {
    if (modal.hidden) return;
    renderList();
    showError(`${error instanceof Error ? error.message : "Không kết nối được Firebase."} Đang hiển thị dữ liệu lưu gần nhất.`);
  }
}

function closeAuthenticator() {
  modal.hidden = true;
  clearInterval(tickTimer);
  returnFocus?.focus?.();
}

modal.querySelector(".mfa-close").addEventListener("click", closeAuthenticator);
modal.addEventListener("click", (event) => event.target === modal && closeAuthenticator());
window.addEventListener("keydown", (event) => {
  if (modal.hidden) return;
  if (event.key === "Escape") { event.preventDefault(); closeAuthenticator(); }
  if (event.key !== "Tab") return;
  const focusable = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')].filter((element) => element.getClientRects().length);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first) { event.preventDefault(); modal.querySelector(".mfa-card").focus(); return; }
  if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
});

const headerButton = document.createElement("button");
headerButton.type = "button";
headerButton.className = "mfa-header-button text-fg";
headerButton.setAttribute("aria-label", "Quản lý tài khoản");
headerButton.title = "Tài khoản & mật khẩu";
headerButton.innerHTML = icon("key");
headerButton.addEventListener("click", openAuthenticator);

function mountHeaderButton() {
  const actions = document.querySelector(".app-header-actions");
  if (!actions || headerButton.isConnected) return;
  const search = actions.querySelector('[aria-label="Tìm"]');
  actions.insertBefore(headerButton, search || null);
}

const root = document.getElementById("root");
if (root) new MutationObserver(mountHeaderButton).observe(root, { childList: true, subtree: true });
mountHeaderButton();
