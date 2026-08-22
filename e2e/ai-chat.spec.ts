import { test, expect } from "@playwright/test";
import {
  createProject,
  createChapter,
  typeInEditor,
  expectEditorContent,
  configureMockProvider,
} from "./helpers";

/**
 * 核心链路：配置服务商 → 写正文 → 续写 → mock 上游流式返回
 * 断言续写哨兵在发请求前被重建为最新正文（[continue:rebuilt] 标记来自 mock 回显）
 */
test("续写链路：发送哨兵被重建为最新正文", async ({ page }) => {
  await page.goto("/");
  await configureMockProvider(page);

  await createProject(page, "AI 测试");
  await createChapter(page, "第一章");
  await typeInEditor(page, "夜幕降临，长安城的灯火次第亮起。");
  await expectEditorContent(page, "夜幕降临，长安城的灯火次第亮起。");

  await page.getByRole("button", { name: "续写本章" }).click();
  // 流式回复以 mock 标记开头，证明 user 消息里携带的是重建后的最新正文
  const reply = page.locator(".whitespace-pre-wrap", { hasText: "[continue:rebuilt]" });
  await expect(reply.first()).toBeVisible({ timeout: 15_000 });
  await expect(reply.first()).toContainText("雪落在长安城头");
});

/** 上下文可视化：眼睛按钮弹窗展示系统提示词等分段 */
test("上下文预览展示注入的分段", async ({ page }) => {
  await page.goto("/");
  await configureMockProvider(page);
  await createProject(page, "上下文测试");
  await createChapter(page, "第一章");
  await typeInEditor(page, "夜幕降临，长安城的灯火次第亮起。");
  await expectEditorContent(page, "夜幕降临，长安城的灯火次第亮起。");

  await page.getByTitle("查看本次请求注入 AI 的完整上下文").click();
  const modal = page.locator(".fixed.inset-0").last();
  await expect(modal.getByText("系统提示词")).toBeVisible();
  await expect(modal.getByText("当前章尾部正文")).toBeVisible();
  await expect(modal.getByText("夜幕降临，长安城的灯火次第亮起。")).toBeVisible();
});
