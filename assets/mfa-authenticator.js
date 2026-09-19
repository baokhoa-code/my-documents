const VAULT_DB = "my-documents-local-vault";
const VAULT_STORE = "keys";
const VAULT_KEY_ID = "totp-aes-v1";
const VAULT_VALUE_ID = "my-documents-local-totp-v1";

let vaultRecord = null;
let tickTimer = null;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function openVaultDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(VAULT_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getLocalEncryptionKey() {
  const db = await openVaultDb();
  const existing = await new Promise((resolve, reject) => {
    const request = db.transaction(VAULT_STORE).objectStore(VAULT_STORE).get(VAULT_KEY_ID);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (existing) return existing;

  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(VAULT_STORE, "readwrite");
    transaction.objectStore(VAULT_STORE).put(key, VAULT_KEY_ID);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  return key;
}

async function encryptAccount(account) {
  const key = await getLocalEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(account)),
  );
  return { v: 1, iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(ciphertext)) };
}

async function decryptAccount(record) {
  const key = await getLocalEncryptionKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(record.iv) },
    key,
    base64ToBytes(record.data),
  );
  return JSON.parse(decoder.decode(plaintext));
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
    return { secret: normalizeBase32(input), label: "ChatGPT", issuer: "OpenAI", digits: 6, period: 30 };
  }
  const url = new URL(input);
  if (url.protocol !== "otpauth:" || url.hostname !== "totp") {
    throw new Error("QR này không phải mã TOTP.");
  }
  const secret = normalizeBase32(url.searchParams.get("secret") || "");
  const label = decodeURIComponent(url.pathname.replace(/^\//, "")) || "Tài khoản MFA";
  return {
    secret,
    label,
    issuer: url.searchParams.get("issuer") || label.split(":")[0] || "MFA",
    digits: Number(url.searchParams.get("digits") || 6),
    period: Number(url.searchParams.get("period") || 30),
  };
}

async function generateTotp(account, now = Date.now()) {
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

const style = document.createElement("style");
style.textContent = `
  .mfa-modal[hidden] { display: none !important; }
  .mfa-modal { position: fixed; inset: 0; z-index: 120; display: grid; place-items: center; padding: 16px; background: rgba(0,0,0,.72); }
  .mfa-card { width: min(420px, 100%); max-height: min(720px, calc(100dvh - 32px)); overflow: auto; border: 1px solid var(--color-line); border-radius: 18px; background: var(--color-bar); color: var(--color-fg); box-shadow: 0 24px 80px rgba(0,0,0,.55); }
  .mfa-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px; border-bottom: 1px solid var(--color-line); }
  .mfa-body { display: grid; gap: 14px; padding: 18px; }
  .mfa-close, .mfa-header-button { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 12px; }
  .mfa-close:hover, .mfa-header-button:hover { background: var(--color-bg); }
  .mfa-field { width: 100%; min-height: 44px; border: 1px solid var(--color-line); border-radius: 12px; padding: 10px 12px; background: var(--color-bg); color: var(--color-fg); outline: none; }
  .mfa-file { display: grid; gap: 6px; border: 1px dashed var(--color-muted); border-radius: 12px; padding: 14px; color: var(--color-muted); }
  .mfa-file input { width: 100%; }
  .mfa-primary, .mfa-danger { min-height: 44px; border-radius: 12px; padding: 10px 14px; font-weight: 600; }
  .mfa-primary { background: var(--color-send); color: var(--color-send-fg); }
  .mfa-danger { background: var(--color-file); color: var(--color-danger); }
  .mfa-code { font: 700 clamp(38px, 12vw, 58px)/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-align: center; color: var(--color-accent); cursor: pointer; }
  .mfa-meta, .mfa-help, .mfa-error { font-size: 13px; line-height: 1.5; }
  .mfa-meta, .mfa-help { color: var(--color-muted); }
  .mfa-error { color: var(--color-danger); }
  .mfa-progress { height: 5px; overflow: hidden; border-radius: 999px; background: var(--color-bg); }
  .mfa-progress > span { display: block; height: 100%; background: var(--color-accent); transition: width 1s linear; }
`;
document.head.append(style);

const modal = document.createElement("div");
modal.className = "mfa-modal";
modal.hidden = true;
modal.innerHTML = `
  <section class="mfa-card" role="dialog" aria-modal="true" aria-labelledby="mfa-title">
    <header class="mfa-head">
      <div><h2 id="mfa-title" style="font-weight:700">Mã xác thực</h2><p class="mfa-meta">Chỉ lưu trên trình duyệt này</p></div>
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

function renderSetup() {
  clearInterval(tickTimer);
  body.innerHTML = `
    <p class="mfa-help">Tải ảnh QR lên ngay tại đây hoặc mở “Bạn gặp vấn đề khi quét?” rồi dán khóa thiết lập thủ công.</p>
    <label class="mfa-file">Ảnh QR MFA<input data-mfa-file type="file" accept="image/*"></label>
    <div style="text-align:center;color:var(--color-muted);font-size:12px">HOẶC</div>
    <label class="mfa-help">Khóa thiết lập thủ công<input data-mfa-secret class="mfa-field" type="password" autocomplete="off" spellcheck="false" placeholder="Ví dụ: JBSWY3DPEHPK3PXP"></label>
    <label class="mfa-help">Tên hiển thị<input data-mfa-label class="mfa-field" value="ChatGPT" maxlength="80"></label>
    <p class="mfa-error" data-mfa-error></p>
    <button class="mfa-primary" data-mfa-save type="button">Lưu và tạo mã</button>
  `;
  let scanned = null;
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
      showError("Đã đọc QR. Bấm “Lưu và tạo mã”.");
    } catch (error) {
      showError(error instanceof Error ? error.message : "Không đọc được QR.");
    }
  });
  body.querySelector("[data-mfa-save]").addEventListener("click", async () => {
    try {
      const manual = body.querySelector("[data-mfa-secret]").value;
      const account = scanned || parseOtpAuth(manual);
      account.label = body.querySelector("[data-mfa-label]").value.trim() || account.label;
      if (![6, 8].includes(account.digits) || account.period < 15) throw new Error("Thông số TOTP không được hỗ trợ.");
      await generateTotp(account);
      vaultRecord = await encryptAccount(account);
      localStorage.setItem(VAULT_VALUE_ID, JSON.stringify(vaultRecord));
      renderCode(account);
    } catch (error) {
      showError(error instanceof Error ? error.message : "Không lưu được khóa MFA.");
    }
  });
}

function renderCode(account) {
  body.innerHTML = `
    <div style="text-align:center"><strong data-mfa-label></strong><p class="mfa-meta" data-mfa-issuer></p></div>
    <button class="mfa-code" type="button" data-mfa-code aria-label="Sao chép mã xác thực">------</button>
    <div class="mfa-progress"><span data-mfa-progress></span></div>
    <p class="mfa-meta" style="text-align:center" data-mfa-countdown></p>
    <p class="mfa-help" style="text-align:center">Bấm vào mã để sao chép</p>
    <button class="mfa-danger" data-mfa-remove type="button">Xóa khóa khỏi trình duyệt</button>
  `;
  body.querySelector("[data-mfa-label]").textContent = account.label;
  body.querySelector("[data-mfa-issuer]").textContent = account.issuer;
  const codeButton = body.querySelector("[data-mfa-code]");
  async function tick() {
    const remaining = account.period - (Math.floor(Date.now() / 1000) % account.period);
    codeButton.textContent = await generateTotp(account);
    body.querySelector("[data-mfa-progress]").style.width = `${(remaining / account.period) * 100}%`;
    body.querySelector("[data-mfa-countdown]").textContent = `Mã mới sau ${remaining} giây`;
  }
  codeButton.addEventListener("click", async () => {
    await navigator.clipboard.writeText(codeButton.textContent);
    body.querySelector("[data-mfa-countdown]").textContent = "Đã sao chép mã";
  });
  body.querySelector("[data-mfa-remove]").addEventListener("click", () => {
    if (!window.confirm("Xóa khóa MFA khỏi trình duyệt này? Bạn sẽ cần QR hoặc khóa thiết lập để thêm lại.")) return;
    localStorage.removeItem(VAULT_VALUE_ID);
    vaultRecord = null;
    renderSetup();
  });
  tick();
  clearInterval(tickTimer);
  tickTimer = window.setInterval(tick, 1000);
}

async function openAuthenticator() {
  modal.hidden = false;
  try {
    vaultRecord ||= JSON.parse(localStorage.getItem(VAULT_VALUE_ID) || "null");
    if (!vaultRecord) return renderSetup();
    renderCode(await decryptAccount(vaultRecord));
  } catch {
    localStorage.removeItem(VAULT_VALUE_ID);
    vaultRecord = null;
    renderSetup();
    showError("Không mở được dữ liệu cũ. Hãy thêm lại khóa MFA.");
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
