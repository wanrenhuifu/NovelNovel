// 本地 AI 请求代理：npm run proxy
// 浏览器直连服务商被 CORS 拦截时，把 provider 的 API 地址填成 http://localhost:8788，
// 代理会在服务端完成转发（不受 CORS 限制），SSE 流式原样透传。
import http from "node:http";
import { createProxyServer } from "../proxy/proxy-core.mjs";

const PORT = Number(process.env.PORT ?? 8788);
const server = createProxyServer(http);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`[novelnovel proxy] listening on http://localhost:${PORT}`);
  console.log("在设置的“API 地址”中填写 http://localhost:8788 即可经此代理请求。");
});
