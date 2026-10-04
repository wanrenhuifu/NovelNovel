/**
 * 清单层校验：本包的客户端半边是否符合**宿主实际读取的规则**。
 *
 * 存在的理由是一次真实事故：在 `package.json` 里声明了 `dsh.client`，但产物 `lib/client.js`
 * 还没构建。宿主 `ClientModuleRegistry` 构造时会为每个 loader 行调用
 * `initialBundleSnapshot`，`ENOENT` → `MissingClientBundleError` → 聚合为
 * `ClientPackageCompositionError` **同步抛出**：注册表不注册 → `/plugins` 路由不存在 →
 * **整个前端**（含首方插件）都加载不出来。也就是说这不是「插件自己的问题」，
 * 而是「启动即崩」。
 *
 * 这里按宿主 `resolveMeta` / `reconcilePackage` 的顺序逐条复刻判定，不装 harness 也能跑：
 *   1. `dsh.client` 存在时必须是对象；
 *   2. `dsh.client.platform` 必须是字符串，且必须是 `"web"`（否则宿主**静默**当成非客户端包，
 *      没有构建、没有报错、页面里也没有——最难查的一种）；
 *   3. `dsh.client.inject` / `external` 若存在，必须是纯字符串数组；
 *   4. `exports["./client"]` 必须是字符串或 `{ default: string }`（其它形态宿主会抛）；
 *   5. 解析出的绝对路径**必须存在**——事故的直接判据；
 *   6. `dsh.client.external` 不得包含自己的包名（宿主抛 `a row must not declare its own package`）。
 *
 * 测不到的部分：真实组合（要靠重启后的 `/plugins/<包名>/client.js` 探测）与浏览器里的观感。
 */
import { existsSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PLATFORM_MODULES } from "./client-platform-modules.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail: ok ? undefined : detail });

/** 宿主 clientExportOf()：接受字符串，或带字符串 default 的对象 */
function clientExportOf(exportsField) {
  if (typeof exportsField !== "object" || exportsField === null) return { kind: "absent" };
  const client = exportsField["./client"];
  if (client === undefined) return { kind: "absent" };
  if (typeof client === "string") return { kind: "path", path: client };
  if (typeof client === "object" && client !== null && typeof client.default === "string") {
    return { kind: "path", path: client.default };
  }
  return { kind: "malformed" };
}

const decl = pkg.dsh?.client;
const exported = clientExportOf(pkg.exports);

if (decl === undefined) {
  // 没有客户端半边也是一种合法形态（纯宿主插件），只是不允许「声明了却没有产物」
  check("未声明 dsh.client（纯宿主插件）", exported.kind === "absent", '声明缺失但 exports 里有 "./client"');
  check("exports 里没有 ./client", exported.kind === "absent");
} else {
  check("dsh.client 是对象", typeof decl === "object" && decl !== null);
  check("dsh.client.platform 是字符串", typeof decl.platform === "string", String(typeof decl.platform));
  check(
    'dsh.client.platform === "web"',
    decl.platform === "web",
    `实际是 ${JSON.stringify(decl.platform)}——非 web 会被宿主**静默**忽略（无构建、无报错、页面里也没有）`,
  );

  for (const field of ["inject", "external"]) {
    const value = decl[field];
    const ok =
      value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
    check(`dsh.client.${field} 是字符串数组（若存在）`, ok, JSON.stringify(value));
  }

  const selfReference = Array.isArray(decl.external)
    ? decl.external.filter((name) => name === pkg.name || name === `${pkg.name}/client`)
    : [];
  check(
    "dsh.client.external 不包含自己",
    selfReference.length === 0,
    `含 ${selfReference.join(", ")}——宿主抛 "a row must not declare its own package"`,
  );

  const known = new Set(PLATFORM_MODULES);
  const unknownExternal = Array.isArray(decl.external)
    ? decl.external.filter((name) => !known.has(name))
    : [];
  check(
    "dsh.client.external 里的键都在平台表内",
    unknownExternal.length === 0,
    `${unknownExternal.join(", ")}——平台表之外的键必须是另一个插件 row，否则浏览器里 require 会抛`,
  );

  check(
    '声明了 dsh.client，exports["./client"] 必须存在且形态合法',
    exported.kind === "path",
    exported.kind === "malformed"
      ? '宿主抛 must be a string or an object with a string default'
      : '缺 exports["./client"]，宿主抛 declares dsh.client but exports no "./client" bundle',
  );

  if (exported.kind === "path") {
    const clientPath = join(root, exported.path);
    const exists = existsSync(clientPath);
    check(
      `客户端产物存在（${exported.path}）`,
      exists,
      "宿主会抛 client-modules: client bundle not found → 前端整体加载失败。先跑 npm run build",
    );
    if (exists) {
      const size = statSync(clientPath).size;
      check("客户端产物非空", size > 0, `${String(size)} 字节`);
      const text = readFileSync(clientPath, "utf8");
      check(
        "产物是 __ModuleLoader__.load 包装",
        text.startsWith("window.__ModuleLoader__.load({"),
        "宿主把它当经典 script 加载（无 type=module），形态不对会在浏览器里静默失败",
      );
      check("产物 id 是包名", text.includes(`id: ${JSON.stringify(pkg.name)}`));
    }
  }
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}${c.detail === undefined ? "" : `  (${c.detail})`}`);
console.log(
  `\n${failed.length === 0 ? "全部通过" : `${String(failed.length)} 项失败`}：${String(checks.length)} 项检查` +
    `（dsh.client: ${decl === undefined ? "未声明" : `platform=${String(decl.platform)}`}）`,
);
process.exit(failed.length === 0 ? 0 : 1);
