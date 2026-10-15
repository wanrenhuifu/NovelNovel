/**
 * 纯逻辑单测的共用打包器：把 `src/` 里的 TS 打成临时 ESM 再 import。
 *
 * 为什么测试要绕这一道：`src/domain/**` 与 `src/client/**` 用的是无扩展名的相对导入
 * （`./types`、`./store`），那是打包器的写法，**Node 直跑不认**。所以先用 esbuild
 * 打成一份 ESM，再 `import` 真代码——测的是真品，不是复制品。
 *
 * `write: false` + 手工落盘，两个理由：
 * - esbuild 的**子进程**在受限环境下写不了工作区外的临时目录
 *   （报 `Access is denied`，而同一个路径 node:fs 写得进去）；
 * - 顺手把落盘这份收成一处，调用方不必各自记着 `bundle.outputFiles[0].text`。
 *
 * 返回**临时目录**而不是文件路径：`test-client-logic.mjs` 需要往同一个目录里再放别的文件
 * （React 要从那里解析），调用方自己 `join(dir, ...)` 更直白。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "./esbuild-compat.mjs";

/**
 * 打包给定源码并 import 回来。
 * @param prefix 临时目录前缀（`nn-<prefix>-`），便于失败时认出是哪个测试留下的
 * @param contents 虚拟入口的源码，通常是一串 `export { … } from "./src/…";`
 * @param options 追加给 esbuild 的选项（例如 `jsx: "automatic"`、`external`)
 * @returns 打包产物的模块命名空间，以及它在磁盘上的位置
 */
export async function bundleSource(prefix, contents, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), `nn-${prefix}-`));
  const outFile = join(dir, "bundle.mjs");
  const built = await esbuild.build({
    stdin: { contents, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    ...options,
  });
  writeFileSync(outFile, built.outputFiles[0].text);
  return { module: await import(pathToFileURL(outFile).href), dir, outFile };
}
