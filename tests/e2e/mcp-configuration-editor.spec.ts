import { expect, test } from "@playwright/test";
import { signInWithLocalToken } from "./support/localAuth";

test("MCP setup edits inline and expanded with one draft, selection and no implicit save", async ({ page }) => {
  let mutations = 0;
  await page.route("**/api/admin/mcp**", async (route) => {
    if (route.request().method() !== "GET") mutations += 1;
    await route.fulfill({ json: { servers: [] } });
  });
  await signInWithLocalToken(page);
  await page.goto("/admin?section=mcp");
  await page.getByRole("button", { name: "New server" }).click();
  const sheet = page.getByRole("dialog", { name: "New server" });
  const editor = page.getByRole("textbox", { name: "Configuration JSON, URL, or install command" });
  await expect(editor).toBeFocused();
  await editor.fill("npx -y @example/mcp@latest");
  await expect(sheet.getByRole("button", { name: "Format", exact: true })).toBeDisabled();
  const value = JSON.stringify({ mcpServers: { example: { url: "https://mcp.example.test/api", note: "long value ".repeat(100) } } });
  await editor.fill(value);
  await sheet.getByRole("button", { name: "Format", exact: true }).click();
  await editor.press("ControlOrMeta+z");
  await expect(editor).toHaveValue(value);
  await editor.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(2, 8));
  await sheet.getByRole("button", { name: "Expand configuration editor" }).click();
  const dialog = page.getByRole("dialog", { name: "MCP configuration" });
  await expect(editor).toBeFocused();
  expect(await editor.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([2, 8]);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 420 }]) {
      await page.setViewportSize(viewport);
      await expect(dialog.getByRole("button", { name: "Return to form", exact: true })).toBeInViewport();
      expect((await editor.boundingBox())!.height).toBeGreaterThan(100);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`mcp-editor-${theme}-${viewport.width}.png`) });
    }
  }
  await editor.fill('{\n"broken":\n}');
  await dialog.getByRole("button", { name: "Format", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Line 3, column 1");
  await editor.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(editor).toHaveValue('{\n"broken":\n}');
  await expect(editor).toBeFocused();
  await expect(sheet.getByRole("alert")).toContainText("Line 3, column 1");
  await editor.fill("https://mcp.example.test/api");
  await sheet.getByRole("button", { name: "Parse", exact: true }).click();
  await expect(sheet.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
  expect(mutations).toBe(0);
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Discard the new server" })).toBeVisible();
  expect(mutations).toBe(0);
});
