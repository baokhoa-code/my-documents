import { animateOverlay, cancelOverlayMotion } from "./overlay-motion.js?v=1";

const FIREBASE_CONFIG_URL = "./hub/firebase-config.json";
const FIREBASE_PATH = "hub/mfaAccounts";
const CACHE_KEY = "my-documents-mfa-accounts-v2";
const LEGACY_VALUE_KEY = "my-documents-local-totp-v1";
const LEGACY_DB = "my-documents-local-vault";
const LEGACY_STORE = "keys";
const LEGACY_KEY_ID = "totp-aes-v1";
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LIMITS = {
  limit5h: { label: "Hết 5h", description: "Hạn mức 5 giờ" },
  limitWeek: { label: "Hết tuần", description: "Hạn mức tuần" },
};
const platformDomains = new Map([
  ["chatgpt", "chatgpt.com"], ["chatgptplus", "chatgpt.com"], ["codex", "chatgpt.com"], ["openai", "chatgpt.com"],
  ["gmail", "mail.google.com"], ["google", "google.com"], ["gemini", "gemini.google.com"], ["youtube", "youtube.com"],
  ["claude", "claude.ai"], ["anthropic", "claude.ai"],
  ["facebook", "facebook.com"], ["instagram", "instagram.com"], ["meta", "meta.com"],
  ["microsoft", "microsoft.com"], ["outlook", "outlook.com"], ["hotmail", "outlook.com"],
  ["github", "github.com"], ["apple", "apple.com"], ["discord", "discord.com"],
]);
const pendingLimits = new Map();
const deletingAccounts = new Set();

let accounts = normalizeAccounts(readCache());
let databaseUrl = "";
let stream = null;
let pollTimer = null;
let tickTimer = null;
let initialized = false;
let currentView = "list";
let searchQuery = "";
let usableOnly = false;
let nextUsableAt = Infinity;
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

function accountCreatedAt(value, id) {
  const saved = Number(value.createdAt);
  if (saved > 0 && saved <= 8.64e15) return saved;
  // Older account IDs start with the time they were generated, in base 36.
  const prefix = /^([0-9a-z]{8})[0-9a-z]{1,6}$/.exec(id)?.[1];
  const timestamp = Number.parseInt(prefix, 36);
  return timestamp >= Date.UTC(2000, 0, 1) && timestamp <= (Number(value.updatedAt) || Date.now())
    ? timestamp : 0;
}

function normalizeDeadline(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function normalizeAccount(value, id = value?.id) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const label = String(value.label || value.issuer || "Tài khoản");
  const legacyEmail = label.includes(":") ? label.slice(label.indexOf(":") + 1).trim() : label;
  return {
    ...value,
    id,
    createdAt: accountCreatedAt(value, id),
    limit5h: value.limit5h === true,
    limit5hUntil: normalizeDeadline(value.limit5hUntil),
    limitWeek: value.limitWeek === true,
    limitWeekUntil: normalizeDeadline(value.limitWeekUntil),
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

function putAccount(record, etag) {
  return fetch(firebaseEndpoint(record.id), {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(etag ? { "If-Match": etag } : {}) },
    body: JSON.stringify(record),
  });
}

async function addAccount(account) {
  if (!databaseUrl) await loadFirebaseConfig();
  const now = Date.now();
  const id = account.id || `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const record = { ...normalizeAccount(account, id), createdAt: accountCreatedAt(account, id) || now, updatedAt: now };
  const response = await putAccount(record, "null_etag");
  if (!response.ok) throw new Error(`Firebase HTTP ${response.status}`);
  accounts[id] = record;
  writeCache();
}

async function updateAccount(id, changes) {
  if (!databaseUrl) await loadFirebaseConfig();
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await fetch(firebaseEndpoint(id), {
      headers: { "X-Firebase-ETag": "true" },
      cache: "no-store",
    });
    if (!snapshot.ok) throw new Error(`Firebase HTTP ${snapshot.status}`);
    const current = normalizeAccount(await snapshot.json(), id);
    if (!current) throw new Error("Tài khoản đã bị xóa.");
    const etag = snapshot.headers.get("ETag");
    if (!etag) throw new Error("Không đọc được phiên bản tài khoản.");
    const updatedAt = Date.now();
    const response = await putAccount({ ...current, ...changes, updatedAt }, etag);
    if (response.status === 412) continue;
    if (!response.ok) throw new Error(`Firebase HTTP ${response.status}`);
    if (accounts[id]) {
      accounts[id] = { ...accounts[id], ...changes, createdAt: current.createdAt, updatedAt };
      writeCache();
    }
    return;
  }
  throw new Error("Tài khoản vừa được cập nhật. Hãy thử lại.");
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
    if (account.secret) await addAccount(account);
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
  more: '<circle cx="5" cy="12" r="1" fill="currentColor"></circle><circle cx="12" cy="12" r="1" fill="currentColor"></circle><circle cx="19" cy="12" r="1" fill="currentColor"></circle>',
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
      <h2 id="mfa-title">Tài khoản</h2>
      <button class="mfa-close" type="button" aria-label="Đóng quản lý tài khoản">${icon("close")}</button>
    </header>
    <div class="mfa-body" data-mfa-body></div>
    <div class="mfa-account-menu" id="mfa-account-menu" role="menu" aria-label="Tùy chọn tài khoản" hidden>
      <button type="button" role="menuitem" tabindex="-1" data-mfa-edit>${icon("edit")} Sửa</button>
      <button class="mfa-danger" type="button" role="menuitem" tabindex="-1" data-mfa-delete>${icon("trash")} Xóa</button>
    </div>
    <div class="mfa-week-overlay" hidden>
      <section class="mfa-week-dialog" role="dialog" aria-modal="true" aria-labelledby="mfa-week-title">
        <h3 id="mfa-week-title">Lượt tuần mở lại sau</h3>
        <form data-mfa-week-form>
          <div class="mfa-week-fields">
            <label class="mfa-form-label">Ngày<input class="mfa-field" type="number" name="days" min="0" step="1" inputmode="numeric" placeholder="0"></label>
            <label class="mfa-form-label">Giờ<input class="mfa-field" type="number" name="hours" min="0" step="1" inputmode="numeric" placeholder="0"></label>
          </div>
          <p class="mfa-week-error" role="alert"></p>
          <div class="mfa-week-actions"><button class="mfa-secondary" type="button" data-mfa-week-cancel>Hủy</button><button class="mfa-primary" type="submit">Lưu</button></div>
        </form>
      </section>
    </div>
    <div class="mfa-toast" role="status" aria-live="polite" hidden></div>
  </section>
`;
document.body.append(modal);
const body = modal.querySelector("[data-mfa-body]");
const panel = modal.querySelector(".mfa-card");
const head = modal.querySelector(".mfa-head");
const accountMenu = modal.querySelector("#mfa-account-menu");
const menuItems = [...accountMenu.querySelectorAll("button")];
const weekOverlay = modal.querySelector(".mfa-week-overlay");
const weekForm = weekOverlay.querySelector("[data-mfa-week-form]");
const weekDays = weekForm.elements.namedItem("days");
const weekHours = weekForm.elements.namedItem("hours");
const weekError = weekForm.querySelector(".mfa-week-error");
let accountMenuTrigger = null;
let weekAccountId = null;
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

function formatTimeRemaining(milliseconds) {
  if (milliseconds >= DAY) {
    const hours = Math.ceil(milliseconds / HOUR);
    return [`${Math.floor(hours / 24)} d`, hours % 24 && `${hours % 24} h`].filter(Boolean).join(" ");
  }
  const seconds = Math.ceil(milliseconds / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.ceil(milliseconds / MINUTE);
  const hours = Math.floor(minutes / 60);
  return [hours && `${hours} h`, minutes % 60 && `${minutes % 60} p`].filter(Boolean).join(" ");
}

function activeLimitDeadline(account, field, now) {
  if (!account[field]) return 0;
  const deadline = account[`${field}Until`];
  if (!deadline) return Infinity;
  return deadline > now ? deadline : 0;
}

function refreshLimits(card, account, now = Date.now()) {
  for (const input of card.querySelectorAll("[data-mfa-limit]")) {
    const field = input.dataset.mfaLimit;
    const state = pendingLimits.get(`${account.id}/${field}`) ?? account;
    const deadline = activeLimitDeadline(state, field, now);
    const { label, description } = LIMITS[field];
    const remaining = deadline && deadline !== Infinity ? `Còn ${formatTimeRemaining(deadline - now)}` : "";
    input.checked = Boolean(deadline);
    const status = input.nextElementSibling;
    const text = remaining || label;
    if (status.textContent !== text) status.textContent = text;
    const accessibleName = remaining ? `${description}: ${remaining}` : description;
    if (input.getAttribute("aria-label") !== accessibleName) input.setAttribute("aria-label", accessibleName);
    const title = deadline === Infinity ? "Bỏ tick rồi tick lại để bắt đầu đếm ngược" : description;
    if (input.parentElement.title !== title) input.parentElement.title = title;
  }
}

function findAccountCard(id) {
  return [...body.querySelectorAll("[data-mfa-account]")].find(card => card.dataset.mfaAccount === id);
}

async function saveLimit(accountId, field, deadline) {
  const account = accounts[accountId];
  const key = `${accountId}/${field}`;
  if (!account || pendingLimits.has(key)) return;
  const changes = { [field]: Boolean(deadline), [`${field}Until`]: deadline };
  pendingLimits.set(key, changes);
  const card = findAccountCard(accountId);
  if (card) {
    card.querySelector(`[data-mfa-limit="${field}"]`).setAttribute("aria-busy", "true");
    refreshLimits(card, account);
  }
  try {
    await updateAccount(accountId, changes);
    if (!initialized) initializeSync().catch(() => {});
  } catch (error) {
    notify(`Không lưu được hạn mức. ${error.message}`);
  } finally {
    pendingLimits.delete(key);
    if (!modal.hidden && currentView === "list") refreshAccountList();
  }
}

function openWeekEditor(accountId) {
  closeAccountMenu();
  weekAccountId = accountId;
  weekForm.reset();
  weekError.textContent = "";
  body.inert = true;
  head.inert = true;
  weekOverlay.hidden = false;
  weekDays.focus({ preventScroll: true });
}

function closeWeekEditor(restoreFocus = false) {
  if (weekAccountId === null) return;
  const accountId = weekAccountId;
  weekAccountId = null;
  weekOverlay.hidden = true;
  body.inert = false;
  head.inert = false;
  if (restoreFocus) {
    const input = findAccountCard(accountId)?.querySelector('[data-mfa-limit="limitWeek"]');
    (input || body.querySelector("[data-mfa-search]"))?.focus({ preventScroll: true });
  }
}

weekForm.addEventListener("input", () => { weekError.textContent = ""; });
weekForm.querySelector("[data-mfa-week-cancel]").addEventListener("click", () => closeWeekEditor(true));
weekOverlay.addEventListener("click", (event) => { if (event.target === weekOverlay) closeWeekEditor(true); });
weekForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (weekAccountId === null) return;
  const now = Date.now();
  const days = Number(weekDays.value);
  const hours = Number(weekHours.value);
  const deadline = now + days * DAY + hours * HOUR;
  if (![days, hours].every(value => Number.isSafeInteger(value) && value >= 0) || !Number.isSafeInteger(deadline) || deadline <= now) {
    weekError.textContent = "Nhập thời gian còn lại lớn hơn 0.";
    weekDays.focus({ preventScroll: true });
    return;
  }
  const accountId = weekAccountId;
  closeWeekEditor(true);
  void saveLimit(accountId, "limitWeek", deadline);
});

function startTicker() {
  clearInterval(tickTimer);
  if (modal.hidden || modal.dataset.overlayState === "closing" || currentView !== "list") return;
  async function tick() {
    const now = Date.now();
    if (now >= nextUsableAt) {
      refreshAccountList(now);
      return;
    }
    for (const card of body.querySelectorAll("[data-mfa-account]")) {
      const account = accounts[card.dataset.mfaAccount];
      if (!account || !card.isConnected) continue;
      refreshLimits(card, account, now);
      if (!account.secret) continue;
      const codeValue = card.querySelector("[data-mfa-code]");
      const copyCode = card.querySelector("[data-mfa-copy-code]");
      const countdown = card.querySelector("[data-mfa-countdown]");
      const progress = card.querySelector("[data-mfa-progress]");
      try {
        const code = await generateTotp(account);
        if (!card.isConnected) continue;
        const remaining = account.period - (Math.floor(Date.now() / 1000) % account.period);
        const split = code.length / 2;
        codeValue.textContent = `${code.slice(0, split)} ${code.slice(split)}`;
        copyCode.dataset.code = code;
        copyCode.disabled = false;
        progress.style.width = `${(remaining / account.period) * 100}%`;
        countdown.textContent = `${remaining}s`;
      } catch {
        if (!card.isConnected) continue;
        codeValue.textContent = "Lỗi mã";
        copyCode.disabled = true;
        delete copyCode.dataset.code;
        progress.style.width = "0";
        countdown.textContent = "";
      }
    }
  }
  tickTimer = window.setInterval(tick, 1000);
  tick();
}

function credentialRow(label, value) {
  const row = document.createElement("button");
  row.className = "mfa-credential";
  row.type = "button";
  row.title = `Sao chép ${label.toLowerCase()}`;
  row.setAttribute("aria-label", row.title);
  row.innerHTML = '<span class="mfa-value mfa-mono"></span>';
  row.querySelector(".mfa-value").textContent = value;
  row.addEventListener("click", () => copyValue(value, label, row));
  return row;
}

function closeAccountMenu(restoreFocus = false) {
  if (!accountMenuTrigger) return;
  const trigger = accountMenuTrigger;
  accountMenuTrigger = null;
  accountMenu.hidden = true;
  modal.removeEventListener("wheel", preventAccountMenuScroll);
  modal.removeEventListener("touchmove", preventAccountMenuScroll);
  trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger.focus({ preventScroll: true });
}

function toggleAccountMenu(trigger) {
  if (accountMenuTrigger === trigger) { closeAccountMenu(true); return; }
  closeAccountMenu();
  accountMenuTrigger = trigger;
  trigger.setAttribute("aria-expanded", "true");
  accountMenu.hidden = false;
  modal.addEventListener("wheel", preventAccountMenuScroll, { passive: false });
  modal.addEventListener("touchmove", preventAccountMenuScroll, { passive: false });
  const frame = panel.getBoundingClientRect();
  const anchor = trigger.getBoundingClientRect();
  const scale = frame.width / panel.offsetWidth || 1;
  const margin = 8;
  const gap = 4;
  const x = (anchor.right - frame.left) / scale - panel.clientLeft - accountMenu.offsetWidth;
  const down = (anchor.bottom - frame.top) / scale - panel.clientTop + gap;
  const up = (anchor.top - frame.top) / scale - panel.clientTop - accountMenu.offsetHeight - gap;
  const y = down + accountMenu.offsetHeight > panel.clientHeight - margin ? up : down;
  accountMenu.style.left = `${Math.max(margin, Math.min(x, panel.clientWidth - accountMenu.offsetWidth - margin))}px`;
  accountMenu.style.top = `${Math.max(margin, y)}px`;
  menuItems[0].focus({ preventScroll: true });
}

function selectedMenuAccount() {
  const card = accountMenuTrigger?.closest("[data-mfa-account]");
  return card && accounts[card.dataset.mfaAccount];
}

accountMenu.querySelector("[data-mfa-edit]").addEventListener("click", () => {
  const account = selectedMenuAccount();
  closeAccountMenu(true);
  if (account) renderSetup(account);
});
accountMenu.querySelector("[data-mfa-delete]").addEventListener("click", async () => {
  const account = selectedMenuAccount();
  const trigger = accountMenuTrigger;
  closeAccountMenu(true);
  if (!account || deletingAccounts.has(account.id)) return;
  const name = [account.platform, account.email].filter(Boolean).join(" · ");
  if (!window.confirm(`Xóa tài khoản “${name}” trên tất cả thiết bị?`)) return;
  deletingAccounts.add(account.id);
  trigger.disabled = true;
  try {
    await removeAccount(account.id);
    notify("Đã xóa tài khoản");
  } catch (error) {
    showError(error instanceof Error ? error.message : "Không xóa được tài khoản.");
  } finally {
    deletingAccounts.delete(account.id);
    trigger.disabled = false;
    if (!modal.hidden && currentView === "list") refreshAccountList();
  }
});

function renderPlatformLogo(button, platform) {
  const initial = button.querySelector("span");
  initial.textContent = [...platform.trim()][0]?.toUpperCase() || "?";
  button.title = `Sao chép nền tảng: ${platform}`;
  button.setAttribute("aria-label", button.title);
  button.addEventListener("click", () => copyValue(platform, "Nền tảng", button));

  const key = platform.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const domain = platformDomains.get(key);
  if (!domain) return;
  const logo = document.createElement("img");
  logo.alt = "";
  logo.hidden = true;
  logo.decoding = "async";
  logo.referrerPolicy = "no-referrer";
  logo.addEventListener("load", () => { logo.hidden = false; initial.hidden = true; }, { once: true });
  logo.addEventListener("error", () => logo.remove(), { once: true });
  logo.src = `https://icons.duckduckgo.com/ip3/${domain}.ico`;
  button.append(logo);
}

function createAccountCard(account) {
  const card = document.createElement("article");
  card.className = "mfa-account";
  card.dataset.mfaAccount = account.id;
  card.innerHTML = `
    <div class="mfa-card-head">
      <button class="mfa-platform-logo" data-mfa-platform type="button"><span aria-hidden="true"></span></button>
      <div class="mfa-limits" role="group" aria-label="Hạn mức">
        ${Object.keys(LIMITS).map(field => `<label class="mfa-limit"><input type="checkbox" data-mfa-limit="${field}"><span></span></label>`).join("")}
      </div>
      <button class="mfa-icon-button mfa-account-more" data-mfa-more type="button" aria-label="Tùy chọn tài khoản" aria-haspopup="menu" aria-controls="mfa-account-menu" aria-expanded="false" title="Tùy chọn tài khoản">${icon("more")}</button>
    </div>
    <div class="mfa-credentials"><h3></h3></div>
    ${account.secret ? `
      <button class="mfa-otp" type="button" data-mfa-copy-code aria-label="Sao chép mã xác thực" title="Sao chép mã xác thực" disabled>
        <span class="mfa-code" data-mfa-code>··· ···</span>
        <span class="mfa-countdown" data-mfa-countdown></span>
        <span class="mfa-progress" aria-hidden="true"><span data-mfa-progress></span></span>
      </button>` : ""}
  `;
  const nameValue = account.email || account.platform;
  const nameLabel = account.email ? "Tên đăng nhập" : "Nền tảng";
  const name = credentialRow(nameLabel, nameValue);
  name.classList.add("mfa-account-name");
  name.dataset.mfaName = "";
  name.setAttribute("aria-label", `${name.title} ${nameValue}`);
  const credentials = card.querySelector(".mfa-credentials");
  credentials.querySelector("h3").append(name);
  renderPlatformLogo(card.querySelector("[data-mfa-platform]"), account.platform);
  for (const input of card.querySelectorAll("[data-mfa-limit]")) {
    const field = input.dataset.mfaLimit;
    const key = `${account.id}/${field}`;
    if (pendingLimits.has(key)) input.setAttribute("aria-busy", "true");
    input.addEventListener("change", () => {
      if (pendingLimits.has(key)) {
        refreshLimits(card, account);
        return;
      }
      if (input.checked && field === "limitWeek") {
        refreshLimits(card, account);
        openWeekEditor(account.id);
        return;
      }
      void saveLimit(account.id, field, input.checked ? Date.now() + 5 * HOUR : 0);
    });
  }
  refreshLimits(card, account);
  if (account.password) credentials.append(credentialRow("Mật khẩu", account.password));
  const copyCode = card.querySelector("[data-mfa-copy-code]");
  copyCode?.addEventListener("click", () => copyValue(copyCode.dataset.code, "Mã xác thực", copyCode));
  const more = card.querySelector("[data-mfa-more]");
  more.disabled = deletingAccounts.has(account.id);
  more.addEventListener("click", () => toggleAccountMenu(more));
  return card;
}

function refreshAccountList(now = Date.now()) {
  const list = body.querySelector("[data-mfa-list]");
  if (!list) return;
  closeAccountMenu(true);
  if (weekAccountId !== null && !accounts[weekAccountId]) closeWeekEditor(true);
  const query = searchQuery.trim().toLocaleLowerCase("vi");
  const all = Object.values(accounts).map((value) => normalizeAccount(value)).filter(Boolean);
  nextUsableAt = Infinity;
  const sorted = all.filter((account) => {
    if (!`${account.platform} ${account.email} ${account.label}`.toLocaleLowerCase("vi").includes(query)) return false;
    if (!usableOnly) return true;
    const deadline = Math.max(activeLimitDeadline(account, "limit5h", now), activeLimitDeadline(account, "limitWeek", now));
    if (!deadline) return true;
    nextUsableAt = Math.min(nextUsableAt, deadline);
    return false;
  }).sort((a, b) => b.createdAt - a.createdAt || a.platform.localeCompare(b.platform, "vi") || a.email.localeCompare(b.email, "vi"));
  const focused = document.activeElement;
  const focusedCard = focused?.closest("[data-mfa-account]");
  const focusId = focusedCard?.dataset.mfaAccount;
  const focusLabel = focusId ? focused.getAttribute("aria-label") : null;
  const focusLimit = focused?.dataset.mfaLimit;
  list.replaceChildren();
  if (!sorted.length) {
    const empty = document.createElement("div");
    empty.className = "mfa-empty";
    empty.textContent = query ? "Không tìm thấy tài khoản"
      : usableOnly && all.length ? "Không có tài khoản còn lượt" : "Chưa có tài khoản";
    list.append(empty);
  } else {
    for (const account of sorted) list.append(createAccountCard(account));
  }
  if (focusId && (focusLabel || focusLimit)) {
    const card = [...list.children].find((element) => element.dataset.mfaAccount === focusId);
    const replacement = card && (focusLimit
      ? card.querySelector(`[data-mfa-limit="${focusLimit}"]`)
      : [...card.querySelectorAll("button")].find((button) => button.getAttribute("aria-label") === focusLabel));
    (replacement || body.querySelector("[data-mfa-search]")).focus({ preventScroll: true });
  }
  startTicker();
}

function renderList() {
  closeAccountMenu();
  closeWeekEditor();
  currentView = "list";
  clearInterval(tickTimer);
  body.innerHTML = `
    <div class="mfa-toolbar">
      <label class="mfa-search">${icon("search")}<input data-mfa-search type="search" placeholder="Tìm tài khoản…" aria-label="Tìm tài khoản" autocomplete="off"></label>
      <label class="mfa-usable-filter"><input data-mfa-usable-only type="checkbox"><span>Còn lượt</span></label>
      <button class="mfa-primary" data-mfa-add type="button" aria-label="Thêm tài khoản">${icon("plus")}<span>Thêm</span></button>
    </div>
    <p class="mfa-error" data-mfa-error role="alert"></p>
    <div class="mfa-account-list" data-mfa-list></div>
  `;
  const search = body.querySelector("[data-mfa-search]");
  search.value = searchQuery;
  search.addEventListener("input", () => { searchQuery = search.value; refreshAccountList(); });
  const filter = body.querySelector("[data-mfa-usable-only]");
  filter.checked = usableOnly;
  filter.addEventListener("change", () => { usableOnly = filter.checked; refreshAccountList(); });
  body.querySelector("[data-mfa-add]").addEventListener("click", () => renderSetup());
  refreshAccountList();
  body.scrollTop = 0;
}

function renderSetup(existing = null) {
  closeAccountMenu();
  closeWeekEditor();
  currentView = "setup";
  clearInterval(tickTimer);
  body.innerHTML = `
    <div class="mfa-form-top"><button class="mfa-back" data-mfa-back type="button">← Quay lại</button></div>
    <form class="mfa-form" data-mfa-form autocomplete="off">
      <div class="mfa-form-heading"><h3>${existing ? "Sửa tài khoản" : "Thêm tài khoản"}</h3></div>
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
      if (existing) await updateAccount(existing.id, account);
      else await addAccount(account);
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

let modalVersion = 0;
async function openAuthenticator() {
  closeAccountMenu();
  closeWeekEditor();
  const version = ++modalVersion;
  returnFocus = document.activeElement;
  modal.hidden = false;
  modal.inert = false;
  animateOverlay(modal, "enter", "dialog");
  currentView = "list";
  body.innerHTML = `<p class="mfa-help mfa-loading">Đang tải tài khoản…</p>`;
  modal.querySelector(".mfa-close").focus();
  try {
    await initializeSync();
    await fetchAccounts();
    if (version === modalVersion && !modal.hidden && currentView === "list") renderList();
  } catch (error) {
    if (version !== modalVersion || modal.hidden) return;
    renderList();
    showError(`${error instanceof Error ? error.message : "Không kết nối được Firebase."} Đang hiển thị dữ liệu lưu gần nhất.`);
  }
}

function closeAuthenticator() {
  if (modal.hidden || modal.dataset.overlayState === "closing") return;
  closeAccountMenu();
  closeWeekEditor();
  const version = ++modalVersion;
  clearInterval(tickTimer);
  animateOverlay(modal, "exit", "dialog").then(finished => {
    if (!finished || version !== modalVersion) return;
    modal.hidden = true;
    cancelOverlayMotion(modal);
    returnFocus?.focus?.({ preventScroll: true });
  });
}

modal.querySelector(".mfa-close").addEventListener("click", closeAuthenticator);
modal.addEventListener("click", (event) => {
  if (event.target !== modal) return;
  if (weekAccountId !== null) closeWeekEditor(true);
  else closeAuthenticator();
});
document.addEventListener("pointerdown", (event) => {
  if (accountMenuTrigger && !accountMenu.contains(event.target) && !accountMenuTrigger.contains(event.target)) closeAccountMenu();
});
function preventAccountMenuScroll(event) {
  event.preventDefault();
}
window.addEventListener("resize", () => closeAccountMenu(true));
window.addEventListener("keydown", (event) => {
  if (modal.hidden || modal.dataset.overlayState === "closing") return;
  if (event.key === "Escape") {
    event.preventDefault();
    if (weekAccountId !== null) closeWeekEditor(true);
    else if (accountMenuTrigger) closeAccountMenu(true);
    else closeAuthenticator();
    return;
  }
  if (accountMenuTrigger && accountMenu.contains(document.activeElement)) {
    if (event.key === "Tab") closeAccountMenu(true);
    else if (event.key === "PageDown" || event.key === "PageUp") {
      event.preventDefault();
      return;
    }
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = menuItems.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? menuItems.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + menuItems.length) % menuItems.length;
      menuItems[next].focus();
      return;
    }
  }
  if (event.key !== "Tab") return;
  const scope = weekAccountId !== null ? weekOverlay : modal;
  const focusable = [...scope.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')].filter((element) => element.getClientRects().length);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first) { event.preventDefault(); panel.focus(); return; }
  if (event.shiftKey && (document.activeElement === first || !scope.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (document.activeElement === last || !scope.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
});

const headerButton = document.createElement("button");
headerButton.type = "button";
headerButton.className = "mfa-header-button text-fg";
headerButton.setAttribute("aria-label", "Quản lý tài khoản");
headerButton.title = "Tài khoản";
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
