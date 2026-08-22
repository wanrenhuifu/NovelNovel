/**
 * API Key 加密：用 AES-GCM 加密后存入 IndexedDB，密钥由用户设置的主密码派生（PBKDF2）。
 * 目的：防 IndexedDB 被浏览器 DevTools 直接看到明文 API Key。
 * 加密后格式：`enc:v1:<b64salt>:<b64iv>:<b64ct>`；前缀用于识别是否已加密。
 */

const PREFIX = "enc:v1:";
// 派生迭代数：WebCrypto 推荐至少 600k；取 250k 在移动端不卡且足够抗暴力
const PBKDF2_ITER = 250_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** 判断字符串是否为已加密的 apiKey */
export function looksEncrypted(s: string): boolean {
  return s.startsWith(PREFIX);
}

/** 生成随机字节并转 base64 */
function randomBase64(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf));
}

function base64ToU8(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/** 从主密码派生 AES-GCM 密钥；salt 为 base64 字符串 */
async function deriveKey(password: string, saltB64: string): Promise<CryptoKey> {
  const salt = base64ToU8(saltB64);
  const enc = new TextEncoder().encode(password);
  const baseKey = await crypto.subtle.importKey("raw", enc, "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** 用主密码加密 apiKey，返回 enc:v1:salt:iv:ct 的拼接字符串 */
export async function encryptApiKey(
  plaintext: string,
  password: string,
): Promise<string> {
  const saltB64 = randomBase64(SALT_BYTES);
  const ivB64 = randomBase64(IV_BYTES);
  const key = await deriveKey(password, saltB64);
  const iv = base64ToU8(ivB64);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ct)));
  return `${PREFIX}${saltB64}:${ivB64}:${ctB64}`;
}

/** 用主密码解密 enc:v1:salt:iv:ct 格式的字符串；密码错抛 DOMException */
export async function decryptApiKey(
  ciphertext: string,
  password: string,
): Promise<string> {
  if (!looksEncrypted(ciphertext)) {
    throw new Error("该 apiKey 未加密");
  }
  const parts = ciphertext.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("加密格式损坏");
  const [saltB64, ivB64, ctB64] = parts;
  const key = await deriveKey(password, saltB64);
  const iv = base64ToU8(ivB64);
  const ct = base64ToU8(ctB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/** 主密码 hash（用于校验用户输入是否正确）：固定 salt 的 PBKDF2 输出 */
export async function hashPassword(password: string, saltB64: string): Promise<string> {
  const salt = base64ToU8(saltB64);
  const enc = new TextEncoder().encode(password);
  const baseKey = await crypto.subtle.importKey("raw", enc, "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITER, hash: "SHA-256" },
    baseKey,
    256,
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

/** 生成密码校验用 salt */
export function newPasswordSalt(): string {
  return randomBase64(SALT_BYTES);
}

/** 检查当前是否有 apiKey 处于加密状态（用于启动时判断是否需要解锁） */
export function hasEncryptedApiKeys(apiKeys: string[]): boolean {
  return apiKeys.some(looksEncrypted);
}
