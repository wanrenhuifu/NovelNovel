import { test, expect } from "@playwright/test";
import { createProject, createChapter } from "./helpers";

/** 读取章节树 DOM 中的章节顺序 */
async function domOrder(page: import("@playwright/test").Page): Promise<string[]> {
  const rows = page.locator("div[data-chapter-id]");
  const count = await rows.count();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push((await rows.nth(i).getAttribute("data-chapter-id"))!);
  }
  return ids;
}

/** 用合成 DragEvent 模拟 HTML5 拖拽（dataTransfer 必须有数据才能触发 drop） */
async function dragRow(
  page: import("@playwright/test").Page,
  sourceIndex: number,
  targetIndex: number,
  position: "before" | "after",
) {
  const rows = page.locator("div[data-chapter-id]");
  const targetBox = await rows.nth(targetIndex).boundingBox();
  if (!targetBox) throw new Error("target row not visible");
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  const clientY = position === "before" ? targetBox.y + 2 : targetBox.y + targetBox.height - 2;
  await rows.nth(sourceIndex).dispatchEvent("dragstart", { dataTransfer });
  await rows.nth(targetIndex).dispatchEvent("dragover", {
    dataTransfer,
    clientX: targetBox.x + 10,
    clientY,
  });
  await rows.nth(targetIndex).dispatchEvent("drop", {
    dataTransfer,
    clientX: targetBox.x + 10,
    clientY,
  });
  await rows.nth(sourceIndex).dispatchEvent("dragend", { dataTransfer });
}

/**
 * 拖拽排序：把最后一章拖到最前，刷新后顺序保持（sortOrder 归一化落库）
 * 注：createProject 会自动创建"第一章"，所以共 4 行
 */
test("拖拽把末章移到最前，刷新后保持", async ({ page }) => {
  await page.goto("/");
  await createProject(page, "排序测试");
  await createChapter(page, "甲");
  await createChapter(page, "乙");
  await createChapter(page, "丙");

  const before = await domOrder(page);
  expect(before).toHaveLength(4); // 第一章(自动) + 甲乙丙

  // 把第 4 行（丙）拖到第 1 行（第一章）之前
  await dragRow(page, 3, 0, "before");
  await expect
    .poll(async () => domOrder(page))
    .toEqual([before[3], before[0], before[1], before[2]]);

  // 刷新后顺序不变（依赖 sortOrder 落库）
  await page.reload();
  await expect
    .poll(async () => domOrder(page))
    .toEqual([before[3], before[0], before[1], before[2]]);
});

/** 拖回原位（dragId === targetId 时 computeReorder 返回 null，顺序不变） */
test("拖到自身位置不产生变化", async ({ page }) => {
  await page.goto("/");
  await createProject(page, "排序测试二");
  await createChapter(page, "甲");

  const before = await domOrder(page);
  await dragRow(page, 0, 0, "after");
  await expect.poll(async () => domOrder(page)).toEqual(before);
});
