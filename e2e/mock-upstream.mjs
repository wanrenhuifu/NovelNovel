// E2E 用 mock OpenAI 兼容上游：带完整 CORS 头，供浏览器直连（不走本地代理）。
// 端口 8791：node e2e/mock-upstream.mjs
import http from "node:http";

const port = Number(process.argv[2] ?? 8791);
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

http
  .createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { ...CORS, "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "mock-model" }] }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const messages = (() => {
        try {
          return JSON.parse(body).messages;
        } catch {
          return [];
        }
      })();
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const markers = [
        system.includes("相关设定词条") ? "[lore:on]" : "[lore:off]",
        system.includes("主要角色设定") ? "[char:on]" : "[char:off]",
        // 检测“续写本章”哨兵是否被重建为最新正文
        (lastUser?.content ?? "").includes("夜幕降临") ? "[continue:rebuilt]" : "[continue:raw]",
      ];
      res.writeHead(200, { ...CORS, "content-type": "text/event-stream" });
      const lines = [...markers, "雪", "落", "在", "长安城", "头。"];
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
      }, 40);
    });
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`E2E mock upstream on http://127.0.0.1:${port} (CORS enabled)`);
  });
