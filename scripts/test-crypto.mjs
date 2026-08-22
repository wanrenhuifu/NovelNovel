/**
 * API Key 加密：encrypt/decrypt 往返 + 错密码报错 + hash 校验一致性
 *
 * 跑法：node scripts/test-crypto.mjs
 */

// 用 esbuild 实时 bundle TS，测试 encrypt/decrypt 往返
import { build } from "esbuild";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Node 20+ 内置 webcrypto；给 bundle 内的 `crypto.subtle` 全局使用

async function loadCrypto() {
  const result = await build({
    entryPoints: ["src/lib/crypto.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const dir = mkdtempSync(join(tmpdir(), "crypto-test-"));
  const file = join(dir, "crypto.mjs");
  writeFileSync(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
}

const assert = (cond, msg) => {
  if (!cond) {
    console.error("✗", msg);
    process.exit(1);
  }
  console.log("✓", msg);
};

const mod = await loadCrypto();
const {
  encryptApiKey,
  decryptApiKey,
  looksEncrypted,
  hashPassword,
  newPasswordSalt,
} = mod;

const PLAIN = "sk-abcdefg1234567890";
const PASSWORD = "我的主密码";

// 1. 明文不被识别为加密
assert(!looksEncrypted(PLAIN), "明文不被识别为加密");

// 2. 加密后能被识别
const ct = await encryptApiKey(PLAIN, PASSWORD);
assert(looksEncrypted(ct), "加密结果以 enc:v1: 开头");
assert(ct !== PLAIN, "加密结果不等于明文");

// 3. 同密码能解密
const pt = await decryptApiKey(ct, PASSWORD);
assert(pt === PLAIN, "正确密码能解密出原文");

// 4. 错密码抛错
let threw = false;
try {
  await decryptApiKey(ct, "wrong-password");
} catch {
  threw = true;
}
assert(threw, "错误密码解密抛错");

// 5. 每次加密 IV/salt 都不同，所以同明文两次加密结果不同
const ct2 = await encryptApiKey(PLAIN, PASSWORD);
assert(ct2 !== ct, "同一明文两次加密得到不同密文（IV/salt 随机）");
// 但都能正确解密
assert((await decryptApiKey(ct2, PASSWORD)) === PLAIN, "第二次加密结果也能解密");

// 6. hashPassword：同密码 + 同 salt 得出同 hash
const salt = newPasswordSalt();
const h1 = await hashPassword(PASSWORD, salt);
const h2 = await hashPassword(PASSWORD, salt);
assert(h1 === h2, "同密码 + 同 salt 的 hash 一致");

// 7. 不同 salt 得出不同 hash
const salt2 = newPasswordSalt();
const h3 = await hashPassword(PASSWORD, salt2);
assert(h3 !== h1, "不同 salt 得出不同 hash");

// 8. 不同密码得出不同 hash
const h4 = await hashPassword("other-password", salt);
assert(h4 !== h1, "不同密码得出不同 hash");

// 9. 特殊字符明文（emoji、中文、空串）
const specials = ["", "🔑", "中文 key-あ", "a".repeat(10000)];
for (const s of specials) {
  const c = await encryptApiKey(s, PASSWORD);
  const d = await decryptApiKey(c, PASSWORD);
  assert(d === s, `特殊明文往返正确：len=${s.length}`);
}

console.log("\n全部通过");
