import { expect, test } from "@playwright/test";
import { signInWithLocalToken } from "./support/localAuth";

for (const filtered of [false, true]) {
  test(`permanent deletion removes the active chat from ${filtered ? "search results" : "navigation"} without reload`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await signInWithLocalToken(page);
    const owned: string[] = [];
    try {
      for (const title of ["Queue survivor", "Queue deletion target"]) {
        const response = await page.request.post("/api/chats", { data: { title, memoryMode: "EXCLUDED" } });
        expect(response.status()).toBe(201);
        owned.push((await response.json()).chat.id);
      }
      const [survivor, target] = owned;
      await page.evaluate((id) => localStorage.setItem("aiqsa.activeChatId", id), target!);
      await page.reload();
      const row = page.locator(`[data-navigation-chat-id="${target}"]`);
      await expect(row.getByRole("treeitem")).toHaveAttribute("aria-current", "page");
      const filter = page.getByRole("searchbox", { name: "Filter chats" });
      if (filtered) {
        await filter.fill("Queue");
        await expect(page.getByRole("group", { name: "Results" })).toBeVisible();
        await expect(row).toBeVisible();
      }
      await row.getByRole("button", { name: "Actions: Queue deletion target" }).click();
      await page.getByRole("menuitem", { name: "Delete…", exact: true }).click();
      const response = page.waitForResponse((item) => item.request().method() === "POST" &&
        new URL(item.url()).pathname === `/api/chats/${target}/delete-permanently`);
      await page.getByRole("dialog", { name: "Delete this chat permanently?" })
        .getByRole("button", { name: "Delete permanently", exact: true }).click();
      expect((await response).status()).toBe(202);
      const status = page.getByRole("dialog", { name: "Permanent deletion", exact: true });
      await status.getByRole("button", { name: "Close", exact: true }).last().click();
      await expect(row).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => localStorage.getItem("aiqsa.activeChatId"))).toBe(survivor);
      await expect(filter).toHaveValue(filtered ? "Queue" : "");
      if (filtered) {
        await filter.fill("");
        await expect(page.getByRole("group", { name: "Results" })).toHaveCount(0);
        await expect(row).toHaveCount(0);
      }
      expect((await page.request.get(`/api/chats/${target}`)).status()).toBe(404);
      await page.screenshot({ path: testInfo.outputPath("deleted-chat-reconciled.png") });
    } finally {
      for (const id of owned) await page.request.delete(`/api/chats/${id}`);
    }
  });
}
