/**
 * 客户端 bundle 的 external 白名单：外壳的**静态模块表**（PLATFORM_MODULES）。
 *
 * 单一来源：构建（build.client.mjs）与测试（scripts/test-client-*.mjs）都从这里取，
 * 避免两处各写一份而漂移——漏一个或多一个都会在**浏览器 console** 报
 * `missed the module table`，服务端完全看不到。
 *
 * 实测来源：`dsh-web-frontend/dist/assets/index-*.js` 里的 `rM()` 返回值。
 * 升级 DSH 后若客户端半边加载失败，第一个要复核的就是这份清单。
 */
export const PLATFORM_MODULES = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit",
];
