import { expect, type Page } from "@playwright/test";

/** 在设置弹窗里配置一个指向本地 mock 上游的 OpenAI 兼容服务商 */
export async function configureMockProvider(page: Page) {
  await page.getByTitle("AI 服务商与生成参数").click();
  await page.getByRole("button", { name: "添加" }).click();
  await page.getByPlaceholder("如：DeepSeek").fill("Mock");
  await page.getByPlaceholder("https://api.example.com").fill("http://127.0.0.1:8791");
  await page.getByPlaceholder("sk-...").fill("sk-test-123");
  await page.getByPlaceholder("模型 ID，如 deepseek-chat").fill("mock-model");
  await page.getByRole("button", { name: "保存" }).click();
  // 关闭设置弹窗：点遮罩边缘（弹窗无 Escape 关闭）
  await page.locator(".fixed.inset-0").click({ position: { x: 5, y: 5 } });
}

/** 通过顶栏“新建”弹窗创建作品 */
export async function createProject(page: Page, title: string) {
  await page.getByRole("button", { name: "新建" }).first().click();
  await page.getByPlaceholder("书名，如：长安落雪").fill(title);
  await page.getByRole("button", { name: "创建" }).click();
  await expect(page.locator("header select")).toHaveValue(/\d+/);
}

/** 新建章节（默认名"第N章"），再双击重命名为指定标题 */
export async function createChapter(page: Page, title: string) {
  const rows = page.locator("div[data-chapter-id]");
  const before = await rows.count();
  await page.locator("aside").first().getByRole("button", { name: "新建" }).click();
  // 新行是异步渲染的，等行数增加后再定位（否则会取到旧的最后一行）
  await expect.poll(async () => rows.count()).toBeGreaterThan(before);
  const newRow = rows.nth(before);
  // 标题 span 是行内唯一带 truncate 类的内容 span（拖拽把手也带 title，需排除）
  await newRow.locator("span.truncate").dblclick();
  const editInput = newRow.locator("input");
  await editInput.fill(title);
  await editInput.press("Enter");
  await expect(page.getByTitle(title)).toBeVisible();
}

/** 向 CodeMirror 编辑器输入正文（先清空） */
export async function typeInEditor(page: Page, text: string) {
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  await page.keyboard.type(text, { delay: 5 });
}

/** 等待编辑器内容与期望一致（保存防抖 600ms，落库后 store 同步） */
export async function expectEditorContent(page: Page, expected: string) {
  await expect
    .poll(async () => page.locator(".cm-content").textContent(), { timeout: 5000 })
    .toBe(expected);
}

/** 等待 IndexedDB 里任一章节内容等于期望值（防抖落库完成，刷新前必须等它） */
export async function waitPersisted(page: Page, expected: string) {
  await expect
    .poll(
      () =>
        page.evaluate((want) => {
          const normalize = (s: string) => s.replace(/\u2028/g, "\n");
          return new Promise<string>((resolve) => {
            const req = indexedDB.open("novelnovel");
            req.onerror = () => resolve("no");
            req.onsuccess = () => {
              const db = req.result;
              const tx = db.transaction("chapters", "readonly");
              const get = tx.objectStore("chapters").getAll();
              get.onsuccess = () => {
                resolve(
                  (get.result as { content: string }[]).some(
                    (r) => normalize(r.content) === want,
                  )
                    ? "yes"
                    : "no",
                );
              };
              get.onerror = () => resolve("no");
            };
          });
        }, expected),
      { timeout: 8000 },
    )
    .toBe("yes");
}

/** 读取某章节标题在章节树中的显示顺序 */
export async function chapterOrder(page: Page): Promise<string[]> {
  const items = page.locator("aside").first().locator("span[title]");
  const count = await items.count();
  const titles: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = await items.nth(i).getAttribute("title");
    if (t && !/^(拖拽排序|上移|下移|重命名|删除章节)/.test(t)) titles.push(t);
  }
  return titles;
}
