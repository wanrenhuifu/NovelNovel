import { test, expect } from "@playwright/test";
import {
  createProject,
  createChapter,
  typeInEditor,
  expectEditorContent,
  waitPersisted,
} from "./helpers";

/** 搜索弹窗（页面可能同时开着设置等其它 fixed 层，取最后渲染的） */
function searchModal(page: import("@playwright/test").Page) {
  return page.locator(".fixed.inset-0").last();
}

/**
 * 全文搜索：命中唯一词 → 点击结果 → 切章节并定位（编辑器重建后 revealPos）
 */
test("搜索跨章节命中并跳转", async ({ page }) => {
  await page.goto("/");
  await createProject(page, "搜索测试");

  // 自动第一章里埋一个唯一词
  await typeInEditor(page, "青石板上的雪渐渐融化。");
  await expectEditorContent(page, "青石板上的雪渐渐融化。");
  await waitPersisted(page, "青石板上的雪渐渐融化。");

  // 第二章放另一个唯一词
  await createChapter(page, "第二章");
  await typeInEditor(page, "狸奴在屋檐下打了个哈欠。");
  await expectEditorContent(page, "狸奴在屋檐下打了个哈欠。");
  await waitPersisted(page, "狸奴在屋檐下打了个哈欠。");

  // 打开搜索，搜第一章的唯一词（命中高亮被 mark 拆成多段，用结果按钮定位）
  await page.locator("header").getByRole("button", { name: "搜索" }).click();
  await page.getByPlaceholder("在全部章节的标题与正文中搜索…").fill("青石板");
  const hit = searchModal(page).getByRole("button", { name: /青石板/ });
  await expect(hit).toBeVisible();
  await hit.click();

  // 跳转后编辑器显示第一章内容（revealPos 会让编辑器获得焦点）
  await expectEditorContent(page, "青石板上的雪渐渐融化。");
  await expect(page.getByTitle("第一章")).toBeVisible();
});

/** 标题命中：搜索章节标题也能出结果并跳转 */
test("搜索命中章节标题", async ({ page }) => {
  await page.goto("/");
  await createProject(page, "搜索测试二");
  await createChapter(page, "楔子 雪夜");

  await page.locator("header").getByRole("button", { name: "搜索" }).click();
  await page.getByPlaceholder("在全部章节的标题与正文中搜索…").fill("雪夜");
  const hit = searchModal(page).getByRole("button", { name: /标题命中/ });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.getByTitle("楔子 雪夜")).toBeVisible();
});
