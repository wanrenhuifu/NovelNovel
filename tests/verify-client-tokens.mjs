/**
 * 校验 styles.ts 用到的每个 CSS 变量是否真实存在。
 *
 * 权威依据（比任何声明都硬）：**首方客户端产物的 CSS 里实际用到的变量名**。
 * 一个变量如果首方自己在用，它一定存在；如果全仓库（含首方）都找不到，
 * 那多半是我编的——而 token 名写错不会抛错，只会静默掉色，深色主题下极难发现。
 *
 * 需要 DSH 的 Electron Node。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail: ok ? undefined : detail });

// ── 1. 我用了哪些 ──────────────────────────────────────────────
const styles = readFileSync(join(repo, "src", "client", "styles.ts"), "utf8");
const used = new Set();
for (const m of styles.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) used.add(m[1]);
check("从 styles.ts 解析到 CSS 变量", used.size > 0, `${String(used.size)} 个`);

// ── 2. 首方产物里出现过哪些（拿"实际使用"当权威）────────────────
const install = process.env.DSH_INSTALL ?? "D:/DSH";
const nm = join(install, "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai");
const seen = new Set();
let scanned = 0;

function scan(dir, depth = 0) {
  if (depth > 3) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      scan(p, depth + 1);
    } else if (/\.(js|css|mjs)$/.test(e.name)) {
      try {
        if (statSync(p).size > 8 * 1024 * 1024) continue;
        const text = readFileSync(p, "utf8");
        for (const m of text.matchAll(/(--(?:dsw|dsh|ds)-[A-Za-z0-9-]+)/g)) seen.add(m[1]);
        scanned++;
      } catch {
        /* 读不了的跳过 */
      }
    }
  }
}

if (process.env.NN_TOKEN_SCAN !== "0") {
  let pkgs = [];
  try {
    pkgs = readdirSync(nm, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(nm, e.name));
  } catch (error) {
    check("能扫描首方产物", false, String(error.message).split("\n")[0]);
  }
  for (const pkg of pkgs) scan(pkg);
}
console.log(`扫描 ${String(scanned)} 个文件，首方用到 ${String(seen.size)} 个不同的 CSS 变量`);
check("首方变量名可解析", seen.size > 50, `只找到 ${String(seen.size)} 个`);

// ── 3. 逐个核对 ────────────────────────────────────────────────
const missing = [...used].filter((n) => !seen.has(n));
for (const n of missing) {
  // 已知允许：主题探针公开过、但首方 JS 里不出现的少数
  const probeDocumented = new Set(["--dsw-alias-bg-layer-3"]);
  check(`变量存在：${n}`, probeDocumented.has(n), "首方产物里找不到它——可能是编的名字（不会抛错，只会掉色）");
}
if (missing.length === 0) check("用到的变量全部存在于首方产物", true);

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail === undefined ? "" : `  (${c.detail})`}`);
console.log(`\n我用了 ${String(used.size)} 个：${[...used].join(", ")}`);
console.log(`${failed.length === 0 ? "全部通过" : `${String(failed.length)} 项失败`}：${String(checks.length)} 项检查`);
process.exit(failed.length === 0 ? 0 : 1);
