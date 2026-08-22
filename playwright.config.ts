import { defineConfig, devices } from "@playwright/test";

/**
 * E2E 配置：
 * - webServer 同时拉起 vite preview（生产构建产物）与 mock AI 上游（带 CORS，端口 8791）
 * - 每个测试用独立 browser context，IndexedDB 天然隔离，无需清库
 * - 跑之前先 npm run build（preview 依赖 dist/）
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://localhost:4173",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npm run preview -- --port 4173 --strictPort",
      url: "http://localhost:4173",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "node e2e/mock-upstream.mjs 8791",
      url: "http://127.0.0.1:8791/v1/models",
      reuseExistingServer: true,
      timeout: 10_000,
    },
  ],
});
