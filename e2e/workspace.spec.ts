import { test, expect } from "@playwright/test";
import {
  createProject,
  createChapter,
  typeInEditor,
  expectEditorContent,
  waitPersisted,
} from "./helpers";

/**
 * 基础工作流：建作品（自动带第一章）→ 重命名 → 编辑正文 → 落库后刷新不丢
 */
test("创建作品与章节，正文落库后刷新不丢", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("正在打开你的书房…")).toBeHidden({ timeout: 15_000 });

  // 1. 建作品（store 会自动创建"第一章"）
  await createProject(page, "长安雪");
  await expect(page.locator("header select")).toContainText("长安雪");

  // 2. 把第一章改名为"第一章 初雪"并输入正文
  await page.getByTitle("第一章").dblclick();
  const editInput = page.locator("div[data-chapter-id] input");
  await editInput.fill("第一章 初雪");
  await editInput.press("Enter");
  await expect(page.getByTitle("第一章 初雪")).toBeVisible();

  const content = "长安城落了第一场雪，青石板路上结了一层薄冰。";
  await typeInEditor(page, content);
  await expectEditorContent(page, content);
  // 等防抖保存落库（编辑器显示是即时的，IndexedDB 写要 600ms 后）
  await waitPersisted(page, content);

  // 3. 刷新：作品、章节、正文都要还在
  await page.reload();
  await expect(page.locator("header select")).toHaveValue(/\d+/);
  await expect(page.getByTitle("第一章 初雪")).toBeVisible();
  await expectEditorContent(page, content);
});

/** 章节操作：重命名 / 删除（两步确认） */
test("章节重命名与删除", async ({ page }) => {
  await page.goto("/");
  await createProject(page, "测试书");
  await createChapter(page, "第二章");

  // 重命名第一章：双击标题进入编辑
  await page.getByTitle("第一章").dblclick();
  const editInput = page.locator("div[data-chapter-id] input");
  await editInput.fill("新第一章");
  await editInput.press("Enter");
  await expect(page.getByTitle("新第一章")).toBeVisible();

  // 删除：两步确认
  await page.getByTitle("新第一章").hover();
  const row = page.locator("div[data-chapter-id]").filter({ hasText: "新第一章" });
  await row.locator("button[title='删除章节']").click();
  await row.locator("button[title='再次点击确认删除']").click();
  await expect(page.getByTitle("新第一章")).toBeHidden();
  await expect(page.getByTitle("第二章")).toBeVisible();
});
