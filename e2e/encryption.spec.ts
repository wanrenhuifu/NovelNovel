import { test, expect, type Page } from "@playwright/test";
import { configureMockProvider } from "./helpers";

/** 直接从 IndexedDB 读 settings 行（绕过 UI，验证落库形态） */
async function readSettingsFromDb(page: Page): Promise<any | null> {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open("novelnovel");
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("settings", "readonly");
          const get = tx.objectStore("settings").get(1);
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => resolve(null);
        };
      }),
  );
}

/**
 * 加密锁全链路：
 * 明文落库 → 开启锁后密文落库 → 刷新出现解锁窗 → 错密码拒绝 → 正确密码解锁 → 解除锁回到明文
 */
test("API Key 加密：开启 / 解锁 / 解除", async ({ page }) => {
  await page.goto("/");
  await configureMockProvider(page);

  // 1. 初始为明文
  let row = await readSettingsFromDb(page);
  expect(row.providers[0].apiKey).toBe("sk-test-123");

  // 2. 开启加密锁
  await page.getByTitle("AI 服务商与生成参数").click();
  await page.getByPlaceholder("新主密码（至少 4 位）").fill("pass-1234");
  await page.getByRole("button", { name: "开启加密锁" }).click();
  await expect(page.getByText(/加密锁已开启/)).toBeVisible();
  await page.locator(".fixed.inset-0").click({ position: { x: 5, y: 5 } });

  // 3. IndexedDB 里已是密文
  row = await readSettingsFromDb(page);
  expect(row.masterHash).toBeTruthy();
  expect(row.providers[0].apiKey.startsWith("enc:v1:")).toBe(true);
  expect(row.providers[0].apiKey).not.toContain("sk-test-123");

  // 4. 刷新 → 解锁窗出现；错密码被拒
  await page.reload();
  await expect(page.getByText("已启用加密锁")).toBeVisible();
  await page.getByPlaceholder("主密码").fill("wrong-pass");
  await page.getByRole("button", { name: "解锁" }).click();
  await expect(page.getByText("主密码错误")).toBeVisible();

  // 5. 正确密码解锁成功
  await page.getByPlaceholder("主密码").fill("pass-1234");
  await page.getByRole("button", { name: "解锁" }).click();
  await expect(page.getByText("已启用加密锁")).toBeHidden();

  // 6. 解除锁：输入当前主密码 → 回明文
  await page.getByTitle("AI 服务商与生成参数").click();
  await page.getByPlaceholder("当前主密码").fill("pass-1234");
  await page.getByRole("button", { name: "解除加密锁" }).click();
  await expect(page.getByText(/加密锁已解除/)).toBeVisible();
  await page.locator(".fixed.inset-0").click({ position: { x: 5, y: 5 } });

  row = await readSettingsFromDb(page);
  expect(row.masterHash).toBeNull();
  expect(row.providers[0].apiKey).toBe("sk-test-123");
});
