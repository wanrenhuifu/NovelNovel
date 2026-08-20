// AI 请求本地代理核心：浏览器与 node 脚本共用。
// 当服务商（尤其 Anthropic 官方或部分中转站）不允许浏览器跨域直连时，
// 前端把请求发往本机代理，由代理在服务端转发（服务端不受 CORS 限制），
// SSE 流式响应原样透传。

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, authorization, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access",
};

/**
 * 转发一次请求并流式回传。
 * onHeaders(status, contentType) 后逐块 onChunk(Uint8Array)。
 */
export async function forwardStreaming(
  targetUrl,
  method,
  headers,
  bodyText,
  onHeaders,
  onChunk,
) {
  const upstream = await fetch(targetUrl, { method, headers, body: bodyText });
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  onHeaders(upstream.status, contentType);
  if (!upstream.body) {
    onChunk(new Uint8Array());
    return upstream.status;
  }
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk(value);
  }
  return upstream.status;
}

/**
 * 创建最小 HTTP 代理服务器（node 环境）。
 *   GET  /__health   健康检查
 *   POST /proxy      { url, headers, body } —— 仅允许 http(s) 目标
 */
export function createProxyServer(nodeHttp) {
  return nodeHttp.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/__health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.method !== "POST" || (req.url ?? "") !== "/proxy") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      const { url, headers, body } = payload;
      const target = new URL(url);
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        throw new Error("only http(s) targets allowed");
      }
      await forwardStreaming(
        target.href,
        "POST",
        headers ?? {},
        typeof body === "string" ? body : JSON.stringify(body),
        (status, contentType) => {
          res.writeHead(status, { "content-type": contentType });
        },
        (chunk) => res.write(chunk),
      );
      res.end();
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: String(e?.message ?? e) }));
    }
  });
}
