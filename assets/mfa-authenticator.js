const FIREBASE_CONFIG_URL = "./hub/firebase-config.json";
const FIREBASE_PATH = "hub/mfaAccounts";
const CACHE_KEY = "my-documents-mfa-accounts-v2";
const LEGACY_VALUE_KEY = "my-documents-local-totp-v1";
const LEGACY_DB = "my-documents-local-vault";
const LEGACY_STORE = "keys";
const LEGACY_KEY_ID = "totp-aes-v1";

let accounts = readCache();
let databaseUrl = "";
let stream = null;
let pollTimer = null;
let tickTimer = null;
let initialized = false;
let currentView = "list";

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
  localStorage.setItem(CACHE_KEY, JSON.stringify(accounts));
}

function normalizeBase32(value) {
  return value.toUpperCase().replace(/[^A-Z2-7]/g, "");
}

function decodeBase32(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = normalizeBase32(value);
  if (!clean) throw new Error("Khóa bí mật đang trống.");
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
  return {
    secret: normalizeBase32(url.searchParams.get("secret") || ""),
    label,
    issuer: url.searchParams.get("issuer") || label.split(":")[0] || "MFA",
    algorithm: (url.searchParams.get("algorithm") || "SHA1").toUpperCase(),
    digits: Number(url.searchParams.get("digits") || 6),
    period: Number(url.searchParams.get("period") || 30),
  };
}

async function generateTotp(account, now = Date.now()) {
  if (account.algorithm !== "SHA1") throw new Error("Hiện chỉ hỗ trợ TOTP SHA-1.");
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
    { name: "HMAC", hash: "SHA-1" },
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
  if (!value || typeof value !== "object" || !value.secret) return null;
  return {
    ...value,
    id,
    secret: normalizeBase32(String(value.secret)),
    label: String(value.label || value.issuer || "Tài khoản MFA"),
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
  if (!modal.hidden && currentView === "list") renderList();
}

async function saveAccount(account) {
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
    if (!parts.length) {
      if (isPatch) {
        for (const [id, value] of Object.entries(payload.data || {})) {
          if (value == null) delete accounts[id];
          else accounts[id] = value;
        }
      } else {
        accounts = normalizeAccounts(payload.data);
      }
    } else {
      const [id, field] = parts;
      if (!field) {
        if (payload.data == null) delete accounts[id];
        else accounts[id] = isPatch ? { ...(accounts[id] || {}), ...payload.data } : payload.data;
      } else if (accounts[id]) {
        if (payload.data == null) delete accounts[id][field];
        else accounts[id][field] = payload.data;
      }
    }
    accounts = normalizeAccounts(accounts);
    writeCache();
    if (!modal.hidden && currentView === "list") renderList();
  } catch {
    // EventSource tự kết nối lại; lần mở tiếp theo luôn tải snapshot mới.
  }
}

function startRealtimeSync() {
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
    const key = await new Promise((resolve, reject) => {
      const request = db.transaction(LEGACY_STORE).objectStore(LEGACY_STORE).get(LEGACY_KEY_ID);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
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

async function initializeSync() {
  if (initialized) return;
  await loadFirebaseConfig();
  await fetchAccounts();
  await migrateLegacyAccount();
  startRealtimeSync();
  initialized = true;
}

const style = document.createElement("style");
style.textContent = `
  .mfa-modal[hidden] { display: none !important; }
  .mfa-modal { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center; padding: 16px; background: rgba(0,0,0,.72); }
  .mfa-card { width: min(480px, 100%); max-height: min(760px, calc(100dvh - 32px)); overflow: auto; border: 1px solid var(--color-line); border-radius: 18px; background: var(--color-bar); color: var(--color-fg); box-shadow: 0 24px 80px rgba(0,0,0,.55); }
  .mfa-head, .mfa-row, .mfa-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .mfa-head { padding: 16px 18px; border-bottom: 1px solid var(--color-line); }
  .mfa-body { display: grid; gap: 14px; padding: 18px; }
  .mfa-close, .mfa-header-button, .mfa-icon-button { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; }
  .mfa-close:hover, .mfa-header-button:hover, .mfa-icon-button:hover { background: var(--color-bg); }
  .mfa-field { width: 100%; min-height: 44px; border: 1px solid var(--color-line); border-radius: 12px; padding: 10px 12px; background: var(--color-bg); color: var(--color-fg); outline: none; }
  .mfa-file { display: grid; gap: 6px; border: 1px dashed var(--color-muted); border-radius: 12px; padding: 14px; color: var(--color-muted); }
  .mfa-file input { width: 100%; }
  .mfa-primary, .mfa-secondary, .mfa-danger { min-height: 44px; border-radius: 12px; padding: 10px 14px; font-weight: 600; }
  .mfa-primary { background: var(--color-send); color: var(--color-send-fg); }
  .mfa-secondary, .mfa-danger { background: var(--color-file); }
  .mfa-danger { color: var(--color-danger); }
  .mfa-account { display: grid; gap: 12px; border: 1px solid var(--color-line); border-radius: 16px; padding: 14px; background: var(--color-surface); }
  .mfa-code { font: 700 clamp(30px, 9vw, 44px)/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .1em; color: var(--color-accent); cursor: pointer; }
  .mfa-meta, .mfa-help, .mfa-error { font-size: 13px; line-height: 1.5; }
  .mfa-meta, .mfa-help { color: var(--color-muted); }
  .mfa-error { color: var(--color-danger); }
  .mfa-progress { height: 4px; overflow: hidden; border-radius: 999px; background: var(--color-bg); }
  .mfa-progress > span { display: block; height: 100%; background: var(--color-accent); transition: width 1s linear; }
`;
document.head.append(style);

const modal = document.createElement("div");
modal.className = "mfa-modal";
modal.hidden = true;
modal.innerHTML = `
  <section class="mfa-card" role="dialog" aria-modal="true" aria-labelledby="mfa-title">
    <header class="mfa-head">
      <div><h2 id="mfa-title" style="font-weight:700">Mã xác thực</h2><p class="mfa-meta">Đồng bộ nhiều thiết bị qua Firebase</p></div>
      <button class="mfa-close" type="button" aria-label="Đóng">✕</button>
    </header>
    <div class="mfa-body" data-mfa-body></div>
  </section>
`;
document.body.append(modal);
const body = modal.querySelector("[data-mfa-body]");

function showError(message) {
  const error = body.querySelector("[data-mfa-error]");
  if (error) error.textContent = message;
}

function startTicker() {
  clearInterval(tickTimer);
  async function tick() {
    for (const card of body.querySelectorAll("[data-mfa-account]")) {
      const account = accounts[card.dataset.mfaAccount];
      if (!account) continue;
      try {
        const remaining = account.period - (Math.floor(Date.now() / 1000) % account.period);
        card.querySelector("[data-mfa-code]").textContent = await generateTotp(account);
        card.querySelector("[data-mfa-progress]").style.width = `${(remaining / account.period) * 100}%`;
        card.querySelector("[data-mfa-countdown]").textContent = `${remaining} giây`;
      } catch {
        card.querySelector("[data-mfa-code]").textContent = "Lỗi mã";
      }
    }
  }
  tick();
  tickTimer = window.setInterval(tick, 1000);
}

function createAccountCard(account) {
  const card = document.createElement("article");
  card.className = "mfa-account";
  card.dataset.mfaAccount = account.id;
  card.innerHTML = `
    <div class="mfa-card-head"><div><strong data-mfa-label></strong><p class="mfa-meta" data-mfa-issuer></p></div><button class="mfa-icon-button mfa-danger" type="button" aria-label="Xóa mã">✕</button></div>
    <div class="mfa-row"><button class="mfa-code" type="button" data-mfa-code aria-label="Sao chép mã xác thực">------</button><span class="mfa-meta" data-mfa-countdown></span></div>
    <div class="mfa-progress"><span data-mfa-progress></span></div>
  `;
  card.querySelector("[data-mfa-label]").textContent = account.label;
  card.querySelector("[data-mfa-issuer]").textContent = account.issuer;
  const codeButton = card.querySelector("[data-mfa-code]");
  codeButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(codeButton.textContent);
    card.querySelector("[data-mfa-countdown]").textContent = "Đã sao chép";
  });
  card.querySelector("[aria-label='Xóa mã']").addEventListener("click", async () => {
    if (!window.confirm(`Xóa mã “${account.label}” trên tất cả thiết bị?`)) return;
    try {
      await removeAccount(account.id);
      renderList();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Không xóa được mã.");
    }
  });
  return card;
}

function renderList() {
  currentView = "list";
  clearInterval(tickTimer);
  body.innerHTML = `
    <div class="mfa-row"><p class="mfa-help">Các mã dưới đây tự cập nhật và xuất hiện trên mọi thiết bị dùng web này.</p><button class="mfa-primary" data-mfa-add type="button">+ Thêm</button></div>
    <div data-mfa-list style="display:grid;gap:12px"></div>
    <p class="mfa-error" data-mfa-error></p>
  `;
  const list = body.querySelector("[data-mfa-list]");
  const sorted = Object.values(accounts).sort((a, b) => a.label.localeCompare(b.label, "vi"));
  if (!sorted.length) {
    const empty = document.createElement("p");
    empty.className = "mfa-help";
    empty.style.textAlign = "center";
    empty.textContent = "Chưa có mã nào. Bấm “+ Thêm” để bắt đầu.";
    list.append(empty);
  } else {
    for (const account of sorted) list.append(createAccountCard(account));
  }
  body.querySelector("[data-mfa-add]").addEventListener("click", renderSetup);
  startTicker();
}

function renderSetup() {
  currentView = "setup";
  clearInterval(tickTimer);
  body.innerHTML = `
    <button class="mfa-secondary" data-mfa-back type="button">← Danh sách mã</button>
    <p class="mfa-help">Tải ảnh QR lên hoặc mở “Bạn gặp vấn đề khi quét?” rồi dán khóa thiết lập thủ công.</p>
    <label class="mfa-file">Ảnh QR MFA<input data-mfa-file type="file" accept="image/*"></label>
    <div style="text-align:center;color:var(--color-muted);font-size:12px">HOẶC</div>
    <label class="mfa-help">Khóa thiết lập thủ công<input data-mfa-secret class="mfa-field" type="password" autocomplete="off" spellcheck="false" placeholder="Ví dụ: JBSWY3DPEHPK3PXP"></label>
    <label class="mfa-help">Tên hiển thị<input data-mfa-label class="mfa-field" value="ChatGPT" maxlength="80"></label>
    <p class="mfa-error" data-mfa-error></p>
    <button class="mfa-primary" data-mfa-save type="button">Lưu và đồng bộ</button>
  `;
  let scanned = null;
  body.querySelector("[data-mfa-back]").addEventListener("click", renderList);
  body.querySelector("[data-mfa-file]").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (!("BarcodeDetector" in window)) throw new Error("Trình duyệt này chưa hỗ trợ đọc QR. Hãy dùng khóa thiết lập thủ công.");
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const bitmap = await createImageBitmap(file);
      const codes = await detector.detect(bitmap);
      bitmap.close();
      if (!codes[0]?.rawValue) throw new Error("Không tìm thấy QR trong ảnh.");
      scanned = parseOtpAuth(codes[0].rawValue);
      body.querySelector("[data-mfa-label]").value = scanned.label || scanned.issuer;
      showError("Đã đọc QR. Bấm “Lưu và đồng bộ”.");
    } catch (error) {
      showError(error instanceof Error ? error.message : "Không đọc được QR.");
    }
  });
  body.querySelector("[data-mfa-save]").addEventListener("click", async () => {
    const button = body.querySelector("[data-mfa-save]");
    try {
      const manual = body.querySelector("[data-mfa-secret]").value;
      const account = scanned || parseOtpAuth(manual);
      account.label = body.querySelector("[data-mfa-label]").value.trim() || account.label;
      if (![6, 8].includes(account.digits) || account.period < 15) throw new Error("Thông số TOTP không được hỗ trợ.");
      await generateTotp(account);
      button.disabled = true;
      button.textContent = "Đang đồng bộ…";
      await saveAccount(account);
      renderList();
    } catch (error) {
      button.disabled = false;
      button.textContent = "Lưu và đồng bộ";
      showError(error instanceof Error ? error.message : "Không lưu được mã MFA.");
    }
  });
}

async function openAuthenticator() {
  modal.hidden = false;
  body.innerHTML = `<p class="mfa-help" style="text-align:center">Đang tải danh sách mã…</p>`;
  try {
    await initializeSync();
    await fetchAccounts();
    renderList();
  } catch (error) {
    renderList();
    showError(`${error instanceof Error ? error.message : "Không kết nối được Firebase."} Đang hiển thị dữ liệu lưu gần nhất.`);
  }
}

function closeAuthenticator() {
  modal.hidden = true;
  clearInterval(tickTimer);
}

modal.querySelector(".mfa-close").addEventListener("click", closeAuthenticator);
modal.addEventListener("click", (event) => event.target === modal && closeAuthenticator());
window.addEventListener("keydown", (event) => event.key === "Escape" && !modal.hidden && closeAuthenticator());

const headerButton = document.createElement("button");
headerButton.type = "button";
headerButton.className = "mfa-header-button text-fg";
headerButton.setAttribute("aria-label", "Mã xác thực MFA");
headerButton.title = "Mã xác thực MFA";
headerButton.innerHTML = `<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="5.5"></circle><path d="m21 2-9.6 9.6M15 7l2 2m1-5 2 2"></path></svg>`;
headerButton.addEventListener("click", openAuthenticator);

function mountHeaderButton() {
  const actions = document.querySelector(".app-header-actions");
  if (!actions || headerButton.isConnected) return;
  const search = actions.querySelector('[aria-label="Tìm"]');
  actions.insertBefore(headerButton, search || null);
}

new MutationObserver(mountHeaderButton).observe(document.getElementById("root"), {
  childList: true,
  subtree: true,
});
mountHeaderButton();
