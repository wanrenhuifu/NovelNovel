// AI 请求失败自动重试链路测试：退避计算、状态码判定、Retry-After、
// withRetry 集成（含中止）、streamOpenAI provider 接线（500 后成功）。
// 源码用无扩展相对导入（Vite 风格），Node 直跑 TS 不认，先经 esbuild 打包到临时文件再测真代码
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import esbuild from "esbuild";

const outFile = join(mkdtempSync(join(tmpdir(), "nn-retry-")), "bundle.mjs");
await esbuild.build({
  stdin: {
    contents: [
      'export { RetryableHttpError, isRetryableStatus, parseRetryAfter, backoffMs, withRetry, interruptibleDelay } from "./src/lib/ai/retry";',
      'export { streamOpenAI } from "./src/lib/ai/openai";',
    ].join("\n"),
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: outFile,
});
const {
  RetryableHttpError,
  isRetryableStatus,
  parseRetryAfter,
  backoffMs,
  withRetry,
  interruptibleDelay,
  streamOpenAI,
} = await import(pathToFileURL(outFile).href);

let failed = 0;
function check(label, ok, extra = "") {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` ${extra}` : ""}`);
}

// ---- 1. 状态码判定 ----
for (const s of [408, 429, 500, 502, 503, 504, 529]) {
  check(`isRetryableStatus(${s}) = true`, isRetryableStatus(s));
}
for (const s of [400, 401, 403, 404, 422]) {
  check(`isRetryableStatus(${s}) = false`, !isRetryableStatus(s));
}

// ---- 2. Retry-After 解析 ----
check("parseRetryAfter(null) = null", parseRetryAfter(null) === null);
check('parseRetryAfter("3") = 3', parseRetryAfter("3") === 3);
check('parseRetryAfter("0") = 0（立即可重试）', parseRetryAfter("0") === 0);
check("parseRetryAfter 上限 60 秒", parseRetryAfter("999") === 60);
check("parseRetryAfter 非法值 = null", parseRetryAfter("abc") === null);
const future = new Date(Date.now() + 5000).toUTCString();
const delta = parseRetryAfter(future);
check("parseRetryAfter(HTTP-date) ≈ 5", delta !== null && delta >= 4 && delta <= 6, `→ ${delta}`);
const past = new Date(Date.now() - 5000).toUTCString();
check("parseRetryAfter(过期 date) = null", parseRetryAfter(past) === null);

// ---- 3. 退避计算 ----
check("backoffMs 优先采用 Retry-After", backoffMs(0, 2) === 2000);
for (let attempt = 0; attempt < 4; attempt++) {
  const base = Math.min(1000 * 2 ** attempt, 8000);
  for (let i = 0; i < 20; i++) {
    const v = backoffMs(attempt);
    if (v < base * 0.75 || v > base * 1.25) {
      check(`backoffMs(${attempt}) 在抖动区间内`, false, `→ ${v}（期望 ${base * 0.75}~${base * 1.25}）`);
      break;
    }
    if (i === 19) check(`backoffMs(${attempt}) 在抖动区间内`, true);
  }
}
{
  let capped = true;
  for (let i = 0; i < 20; i++) {
    if (backoffMs(10) > 10000) capped = false; // 8000 * 1.25 上限
  }
  check("backoffMs 封顶 8s（+25% 抖动）", capped);
}

// ---- 4. withRetry：两次 500 后成功 ----
{
  let calls = 0;
  const retries = [];
  await withRetry(
    async () => {
      calls++;
      if (calls < 3) {
        throw new RetryableHttpError({ message: `boom ${calls}`, status: 500 });
      }
    },
    { backoff: () => 5, onRetry: (info) => retries.push(info) },
  );
  check("withRetry 重试至成功：共 3 次尝试", calls === 3);
  check("onRetry 回调 2 次且 attempt 递增", retries.length === 2 && retries[0].attempt === 1 && retries[1].attempt === 2);
  check("onRetry 携带错误信息", retries[0].message === "boom 1");
}

// ---- 5. withRetry：持续失败耗尽重试后抛出 ----
{
  let calls = 0;
  let err;
  try {
    await withRetry(
      async () => {
        calls++;
        throw new RetryableHttpError({ message: "always 500", status: 500 });
      },
      { maxRetries: 2, backoff: () => 5 },
    );
  } catch (e) {
    err = e;
  }
  check("耗尽重试后抛出 RetryableHttpError", err instanceof RetryableHttpError && err.status === 500);
  check("默认 maxRetries=2 → 共 3 次尝试", calls === 3);
}

// ---- 6. withRetry：401 不重试 ----
{
  let calls = 0;
  let err;
  try {
    await withRetry(
      async () => {
        calls++;
        throw new RetryableHttpError({ message: "unauthorized", status: 401, retryable: false });
      },
      { backoff: () => 5 },
    );
  } catch (e) {
    err = e;
  }
  check("retryable=false 立即抛出", calls === 1 && err instanceof RetryableHttpError);
}

// ---- 7. withRetry：AbortError 直接透传 ----
{
  let calls = 0;
  let err;
  const abortErr = new DOMException("The operation was aborted.", "AbortError");
  try {
    await withRetry(async () => {
      calls++;
      throw abortErr;
    }, { backoff: () => 5 });
  } catch (e) {
    err = e;
  }
  check("AbortError 透传且不重试", err === abortErr && calls === 1);
}

// ---- 8. withRetry：普通 Error 不重试 ----
{
  let calls = 0;
  try {
    await withRetry(async () => {
      calls++;
      throw new Error("业务错误");
    }, { backoff: () => 5 });
  } catch {
    // 预期抛出
  }
  check("普通 Error 不重试", calls === 1);
}

// ---- 9. withRetry：canRetry=false 禁止重试（已出字场景） ----
{
  let calls = 0;
  try {
    await withRetry(
      async () => {
        calls++;
        throw new TypeError("network down mid-stream");
      },
      { backoff: () => 5, canRetry: () => false },
    );
  } catch {
    // 预期抛出
  }
  check("canRetry()=false 时网络错误也不重试", calls === 1);
}

// ---- 10. withRetry：Retry-After 秒数传给退避函数 ----
{
  const seen = [];
  let calls = 0;
  try {
    await withRetry(
      async () => {
        calls++;
        throw new RetryableHttpError({ message: "rate limited", status: 429, retryAfterSec: 7 });
      },
      {
        maxRetries: 1,
        backoff: (_attempt, retryAfterSec) => {
          seen.push(retryAfterSec);
          return 5;
        },
      },
    );
  } catch {
    // 预期抛出
  }
  check("Retry-After 秒数透传给 backoff", seen.length === 1 && seen[0] === 7);
}

// ---- 11. 重试等待期间被中止 → AbortError ----
{
  const controller = new AbortController();
  let retryNotified = false;
  const start = Date.now();
  let err;
  const p = withRetry(
    async () => {
      throw new RetryableHttpError({ message: "500", status: 500 });
    },
    {
      signal: controller.signal,
      backoff: () => 60_000, // 长等待，靠中止打断
      onRetry: () => {
        retryNotified = true;
        setTimeout(() => controller.abort(), 20);
      },
    },
  ).catch((e) => (err = e));
  await p;
  const elapsed = Date.now() - start;
  check("等待期间中止 → AbortError", err instanceof DOMException && err.name === "AbortError");
  check("中止及时生效（未等满退避）", elapsed < 2000, `→ ${elapsed}ms`);
  check("中止前已发出 onRetry 通知", retryNotified);
}

// ---- 12. interruptibleDelay：ms<=0 且已中止 → 拒绝 ----
{
  const controller = new AbortController();
  controller.abort();
  let err;
  await interruptibleDelay(0, controller.signal).catch((e) => (err = e));
  check("已中止信号的零等待立即拒绝", err instanceof DOMException && err.name === "AbortError");
}

// ---- 13. streamOpenAI 接线：先 500 再成功 SSE ----
const upstream = http.createServer((req, res) => {
  upstream.hits++;
  if (upstream.hits === 1) {
    res.writeHead(500, { "content-type": "application/json", "retry-after": "2" });
    res.end(JSON.stringify({ error: { message: "overloaded" } }));
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "重试" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "成功" } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
upstream.hits = 0;
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const port = upstream.address().port;

{
  const tokens = [];
  const retries = [];
  await streamOpenAI(
    { type: "openai", baseUrl: `http://127.0.0.1:${port}`, apiKey: "test", modelId: "mock" },
    [{ role: "user", content: "你好" }],
    { temperature: 0.7, maxTokens: 100 },
    {
      onToken: (t) => tokens.push(t),
      onRetry: (info) => retries.push(info),
    },
  );
  check("streamOpenAI 500 后自动重试成功", upstream.hits === 2);
  check("streamOpenAI token 完整", tokens.join("") === "重试成功", `→ ${JSON.stringify(tokens)}`);
  check("streamOpenAI onRetry 携带 Retry-After", retries.length === 1 && retries[0].waitMs === 2000);
}

// ---- 14. streamOpenAI：401 不重试直接报错 ----
const upstream401 = http.createServer((_req, res) => {
  upstream401.hits++;
  res.writeHead(401, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "invalid key" } }));
});
upstream401.hits = 0;
await new Promise((r) => upstream401.listen(0, "127.0.0.1", r));
{
  let err;
  try {
    await streamOpenAI(
      { type: "openai", baseUrl: `http://127.0.0.1:${upstream401.address().port}`, apiKey: "bad", modelId: "mock" },
      [{ role: "user", content: "你好" }],
      { temperature: 0.7, maxTokens: 100 },
      { onToken: () => {} },
    );
  } catch (e) {
    err = e;
  }
  check("streamOpenAI 401 不重试", upstream401.hits === 1);
  check("streamOpenAI 401 错误信息含状态码", err instanceof Error && err.message.includes("(401)"), `→ ${err?.message}`);
}

// ---- 15. streamOpenAI：出字后流中断不重试，且错误信息可读 ----
const upstreamCut = http.createServer((_req, res) => {
  upstreamCut.hits++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  // 等 token 刷出并被客户端读到后再掐断连接，模拟“出字后网络中断”
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "半句" } }] })}\n\n`, () => {
    setTimeout(() => res.socket.destroy(), 50);
  });
});
upstreamCut.hits = 0;
await new Promise((r) => upstreamCut.listen(0, "127.0.0.1", r));
{
  const tokens = [];
  let err;
  try {
    await streamOpenAI(
      { type: "openai", baseUrl: `http://127.0.0.1:${upstreamCut.address().port}`, apiKey: "t", modelId: "mock" },
      [{ role: "user", content: "你好" }],
      { temperature: 0.7, maxTokens: 100 },
      { onToken: (t) => tokens.push(t) },
    );
  } catch (e) {
    err = e;
  }
  check("出字后中断：已收到部分 token", tokens.join("") === "半句");
  check("出字后中断：不重试（仅 1 次请求）", upstreamCut.hits === 1, `→ ${upstreamCut.hits}`);
  check(
    "出字后中断：错误信息可读",
    err instanceof Error && err.message.includes("输出过程中网络连接中断"),
    `→ ${err?.message}`,
  );
}

upstream.close();
upstream401.close();
upstreamCut.close();
// Windows libuv 在关闭句柄后立即 exit 可能触发断言，稍等一个事件循环周期
await new Promise((r) => setTimeout(r, 100));

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
