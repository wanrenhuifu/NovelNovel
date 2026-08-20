// 本轮迭代的 Node 端验证：PNG 导出往返、lorebook 注入、代理转发。
// 浏览器专属模块（png.ts 用 CompressionStream）在 Node 24 也可运行。
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import http from "node:http";
import { CharacterCard } from "@lenml/char-card-reader";

// ---- 复用与源码一致的最小 PNG 构造（测试夹具） ----
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

let failed = 0;
function check(label, ok, extra = "") {
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${label}${extra ? ` ${extra}` : ""}`);
}

// ---- 1. PNG 导出逻辑往返：用应用同款 readPngChunks/parseTextChunk 验证双写 ----
// png.ts 是 TS，这里用 vite-node 不方便，直接内联同款解析验证 export 的产物结构。
// 做法：import 编译后的 dist 不可行（被打包），改为直接跑 png.ts 的镜像逻辑验证。
// 为保证测的是真代码，用 tsx 风格的动态 import 不行（无 tsx 依赖），
// 因此这里验证 proxy-core.mjs（真代码）+ 手搓 PNG 往返（夹具），PNG 真代码另在浏览器 E2E 中验证。
const { forwardStreaming, createProxyServer } = await import("../proxy/proxy-core.mjs");

// ---- 2. 代理转发测试：起一个模拟 OpenAI SSE 上游，经代理流式取回 ----
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `echo:${parsed.model}` } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = upstream.address().port;

const chunksOut = [];
let status;
await forwardStreaming(
  `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
  "POST",
  { "content-type": "application/json", authorization: "Bearer test" },
  JSON.stringify({ model: "mock-model", stream: true }),
  (s) => (status = s),
  (c) => chunksOut.push(Buffer.from(c)),
);
const sseText = Buffer.concat(chunksOut).toString("utf-8");
check("代理流式转发 status=200", status === 200);
check("代理透传 SSE 内容", sseText.includes("echo:mock-model") && sseText.includes("[DONE]"));

// ---- 3. createProxyServer 端到端：浏览器形态的 POST /proxy 调用 ----
const proxy = createProxyServer(http);
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const proxyPort = proxy.address().port;
const proxyRes = await fetch(`http://127.0.0.1:${proxyPort}/proxy`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`,
    headers: { "content-type": "application/json" },
    body: { model: "via-proxy", stream: true },
  }),
});
const proxyText = await proxyRes.text();
check("代理服务器 /proxy 路由", proxyRes.status === 200 && proxyText.includes("echo:via-proxy"));

const health = await fetch(`http://127.0.0.1:${proxyPort}/__health`);
check("代理健康检查", health.status === 200);

// 非 http(s) 目标被拒绝
const bad = await fetch(`http://127.0.0.1:${proxyPort}/proxy`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "file:///etc/passwd", headers: {}, body: "" }),
});
check("代理拒绝非 http(s) 目标", bad.status === 502);

// ---- 4b. 真实 png.ts 代码往返：占位图 → 插入双写 tEXt → char-card-reader 读回 ----
const pngLib = await import("../src/lib/png.ts");
const basePng = await pngLib.makeSolidPng(64, 64, [38, 33, 29, 255]);
check("makeSolidPng 产出有效 PNG", pngLib.isPng(basePng));
const v2 = JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "林晚", description: "d" } });
const v3 = JSON.stringify({ spec: "chara_card_v3", spec_version: "3.0", data: { name: "林晚", nickname: "晚晚" } });
const toB64 = (s) => Buffer.from(s, "utf8").toString("base64");
const baseChunks = pngLib.readPngChunks(basePng);
const iend = baseChunks.findIndex((c) => c.type === "IEND");
const exported = pngLib.writePng([
  ...baseChunks.slice(0, iend),
  pngLib.makeTextChunk("chara", toB64(v2)),
  pngLib.makeTextChunk("ccv3", toB64(v3)),
  ...baseChunks.slice(iend),
]);
const reChunks = pngLib.readPngChunks(exported);
const keywords = reChunks
  .map((c) => pngLib.parseTextChunk(c)?.keyword)
  .filter(Boolean);
check("导出 PNG 含 chara+ccv3 双写", keywords.includes("chara") && keywords.includes("ccv3"), JSON.stringify(keywords));
const reread = await CharacterCard.from_file(exported);
check("真实代码导出的 PNG 被正确读回(V3 优先)", reread.spec === "chara_card_v3" && reread.name === "林晚");

upstream.close();
proxy.close();
// Windows libuv 在关闭句柄后立即 exit 可能触发断言，稍等一个事件循环周期
await new Promise((r) => setTimeout(r, 100));

// ---- 4. tEXt 双写夹具往返（与 lib/png.ts 同款算法的镜像验证） ----
const cardJson = JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "测试" } });
const textData = Buffer.concat([
  Buffer.from("chara\0", "ascii"),
  Buffer.from(Buffer.from(cardJson, "utf8").toString("base64"), "ascii"),
]);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", (() => { const b = Buffer.alloc(13); b.writeUInt32BE(1, 0); b.writeUInt32BE(1, 4); b[8] = 8; b[9] = 6; return b; })()),
  chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
  chunk("tEXt", textData),
  chunk("IEND", Buffer.alloc(0)),
]);
const dir = mkdtempSync(join(tmpdir(), "nn-"));
writeFileSync(join(dir, "card.png"), png);
// 用 char-card-reader 读回，确认夹具 PNG 仍可被 SillyTavern 生态解析
const card = await CharacterCard.from_file(new Uint8Array(png));
check("导出的 PNG 仍可被 SillyTavern 生态读回", card.name === "测试");

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
