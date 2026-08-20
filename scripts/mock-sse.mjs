// 模拟 OpenAI 兼容 SSE 上游（故意不返回 CORS 头，用于验证浏览器直连失败→代理回退）。
// 默认端口 8790：node scripts/mock-sse.mjs [port]
import http from "node:http";

const port = Number(process.argv[2] ?? 8790);
http
  .createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      let system = "";
      try {
        system = JSON.parse(body).messages?.find((m) => m.role === "system")?.content ?? "";
      } catch {}
      const markers = [
        system.includes("相关设定词条") ? "[lore:on]" : "[lore:off]",
        system.includes("主要角色设定") ? "[char:on]" : "[char:off]",
        // 写作预设 E2E 标记：预设的 systemPrompt/storyString 注入后出现
        system.includes("预设生效标记") ? "[preset:on]" : "[preset:off]",
      ];
      const lines = [...markers, "雪", "落", "在", "长安城", "头，", "无声无息。"];
      let i = 0;
      const timer = setInterval(() => {
        if (i < lines.length) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: lines[i++] } }] })}\n\n`,
          );
        } else {
          res.write("data: [DONE]\n\n");
          clearInterval(timer);
          res.end();
        }
      }, 60);
    });
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`mock SSE upstream on http://127.0.0.1:${port} (no CORS headers)`);
  });
