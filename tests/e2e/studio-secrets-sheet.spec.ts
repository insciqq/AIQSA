import { expect, test, type Page } from "@playwright/test";
import type { WorkspaceSecretSummary } from "../../lib/contracts/workspaceSecrets";
import { authenticateWithLocalToken } from "./support/localAuth";
import { runAccountMenuAction } from "./shell/page";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";

const sizes = [{ width: 1440, height: 900 }, { width: 768, height: 1024 }, { width: 1024, height: 768 },
  { width: 390, height: 844 }, { width: 844, height: 390 }];
const saved: WorkspaceSecretSummary = {
  id: "21000000-0000-4000-8000-000000000001", versionId: "21000000-0000-4000-8000-000000000002",
  kind: "env", name: "Fixture environment", description: "", byteSize: 100,
  updatedAt: "2026-09-22T10:00:00.000Z", envNames: ["EXISTING", "PASTE_SENTINEL"], originalName: null, sshProtected: false
};
async function prepare(page: Page) {
  await authenticateWithLocalToken(page.request);
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible({ timeout: 30_000 });
}

for (const theme of ["light", "dark"] as const) {
  test(`secret sheet preserves local paste, keyboard and geometry on every device · ${theme}`, async ({ page }, info) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    await page.context().addCookies([{ name: "aiqsa.theme", value: theme, url: info.project.use.baseURL! }]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    let rows: WorkspaceSecretSummary[] = [];
    let writes: unknown[] = [];
    const leakedPaste: string[] = [];
    page.on("request", request => {
      if (request.postData()?.includes("PASTE_SENTINEL")) leakedPaste.push(request.url());
    });
    await page.route("**/api/me/workspace/secrets", async route => {
      if (route.request().method() !== "GET") {
        const mutation = route.request().postDataJSON();
        writes.push(mutation);
        rows = mutation.action === "delete" ? [] : [saved];
      }
      await route.fulfill({ json: { secrets: rows } });
    });
    await prepare(page);
    const panel = page.getByTestId("workspace-secrets-panel");
    const sheet = page.getByTestId("workspace-secret-sheet");
    const dialog = sheet.getByRole("dialog", { name: "Add secret", exact: true });
    const confirmation = sheet.getByRole("dialog", { name: "Unsaved Workspace secret", exact: true });
    for (const size of sizes) {
      await page.setViewportSize(size);
      await runAccountMenuAction(page, "Secrets");
      for (const action of ["Cancel", "Close", "Escape", ...(size.width >= 640 ? ["Dismiss"] : [])]) {
        await panel.getByRole("button", { name: "Add secret", exact: true }).click();
        await expect(sheet.getByLabel("Name", { exact: true })).toBeFocused();
        const unloadBlocked = await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
        expect(unloadBlocked).toBe(false);
        if (action === "Escape") await page.keyboard.press("Escape");
        else if (action === "Dismiss") await sheet.getByRole("button", { name: "Dismiss", exact: true }).click({ position: { x: 8, y: 100 } });
        else await sheet.getByRole("button", { name: action, exact: true }).click();
        await expect(sheet).toHaveCount(0);
        await expect(panel.getByRole("button", { name: "Add secret", exact: true })).toBeFocused();
      }
      await panel.getByRole("button", { name: "Add secret", exact: true }).click();
      await expectWithinViewport(page, dialog);
      expect(Math.round((await dialog.boundingBox())!.width)).toBe(Math.min(size.width, 600));
      await expect.poll(() => panel.evaluate(node => Boolean(node.closest("[inert]")))).toBe(true);
      await page.keyboard.press("Control+Shift+O");
      await expect(dialog).toBeVisible();
      await sheet.getByRole("radio", { name: "SSH key", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(sheet.getByRole("radio", { name: "Environment", exact: true })).toBeChecked();
      await sheet.getByLabel("Name", { exact: true }).fill(saved.name);
      await sheet.getByLabel("Variable name 1", { exact: true }).fill("EXISTING");
      await sheet.getByLabel("Variable value 1", { exact: true }).fill("old");
      await sheet.getByRole("button", { name: "Paste .env", exact: true }).click();
      const paste = sheet.getByRole("textbox", { name: "Paste the contents of a .env file", exact: true });
      await paste.fill('EXISTING=replaced\nPASTE_SENTINEL="first\\nsecond"\ninvalid name=no');
      await page.keyboard.press("Escape");
      await expect(confirmation.getByRole("button", { name: "Keep editing", exact: true })).toBeFocused();
      await confirmation.getByRole("button", { name: "Keep editing", exact: true }).click();
      await expect(paste).toHaveValue(/PASTE_SENTINEL/);
      await sheet.getByRole("button", { name: "Add variables", exact: true }).click();
      await expect(sheet.getByRole("status")).toHaveText("Added 1, replaced 1, skipped 1.");
      await expect(sheet.getByLabel("Variable value 2", { exact: true })).toHaveValue("first\nsecond");
      expect(writes).toEqual([]);
      expect(leakedPaste).toEqual([]);
      const nameBounds = (await sheet.getByLabel("Variable name 1", { exact: true }).boundingBox())!;
      const valueBounds = (await sheet.getByLabel("Variable value 1", { exact: true }).boundingBox())!;
      expect(Math.abs(nameBounds.y - valueBounds.y)).toBeLessThanOrEqual(1);
      expect(valueBounds.x).toBeGreaterThan(nameBounds.x + nameBounds.width);
      const save = sheet.getByRole("button", { name: "Save secret", exact: true });
      await expectWithinViewport(page, save);
      await save.focus();
      await page.keyboard.press("Tab");
      await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(save).toBeFocused();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`secrets-${theme}-${size.width}x${size.height}.png`) });
      await save.click();
      await expect(sheet).toHaveCount(0);
      await expect(panel.getByRole("heading", { name: saved.name, exact: true })).toBeFocused();
      expect(writes).toEqual([{ action: "create", name: saved.name, description: "", value: { kind: "env", entries: [
        { name: "EXISTING", value: "replaced" }, { name: "PASTE_SENTINEL", value: "first\nsecond" }
      ] } }]);
      expect(leakedPaste).toHaveLength(1);
      await panel.getByRole("button", { name: `Edit ${saved.name}`, exact: true }).click();
      for (const radio of await sheet.getByRole("radio").all()) await expect(radio).toBeDisabled();
      await expect(sheet.getByLabel("Variable value 1", { exact: true })).toHaveCount(0);
      await expect(sheet).not.toContainText("first\nsecond");
      await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
      await panel.getByRole("button", { name: `More actions for ${saved.name}`, exact: true }).click();
      await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
      await panel.getByRole("button", { name: "Delete permanently", exact: true }).click();
      await expect(panel.getByText("No saved Workspace secrets.")).toBeVisible();
      writes = []; leakedPaste.length = 0;
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    }
  });
}

const revealable: WorkspaceSecretSummary[] = [
  { ...saved, id: "21000000-0000-4000-8000-000000000011", versionId: "21000000-0000-4000-8000-000000000012",
    name: "Fixture environment", description: "Sign-in for the fixture service", envNames: ["FIXTURE_USER", "FIXTURE_TOKEN"] },
  { ...saved, id: "21000000-0000-4000-8000-000000000021", versionId: "21000000-0000-4000-8000-000000000022",
    kind: "text", name: "Fixture text", envNames: [] }
];
const revealedValues: Record<string, unknown> = {
  [revealable[0]!.id]: { kind: "env", entries: [{ name: "FIXTURE_USER", value: "synthetic-user@example.test" },
    { name: "FIXTURE_TOKEN", value: "synthetic-token-0123456789abcdefghijklmnopqrstuvwxyz-0123456789abcdefghijklmnopqrstuvwxyz" }] },
  [revealable[1]!.id]: { kind: "text", text: "synthetic first line\nsynthetic second line" }
};

for (const theme of ["light", "dark"] as const) {
  test(`owner shows, copies and hides saved values on desktop, tablet and phone · ${theme}`, async ({ page }, info) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    await page.context().addCookies([{ name: "aiqsa.theme", value: theme, url: info.project.use.baseURL! }]);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: info.project.use.baseURL! });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const reveals: unknown[] = [];
    await page.route("**/api/me/workspace/secrets", async route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { secrets: revealable } });
      const body = route.request().postDataJSON() as { action: string; id: string };
      reveals.push(body);
      if (body.action !== "reveal") return route.fulfill({ status: 400, json: { error: "workspace_secret_invalid" } });
      const secret = revealable.find(row => row.id === body.id);
      if (!secret) return route.fulfill({ status: 404, json: { error: "workspace_secret_not_found" } });
      await route.fulfill({ json: { id: secret.id, versionId: secret.versionId, value: revealedValues[secret.id] },
        headers: { "cache-control": "private, no-store" } });
    });
    await prepare(page);
    const panel = page.getByTestId("workspace-secrets-panel");
    for (const size of [sizes[0]!, { width: 820, height: 1180 }, sizes[3]!]) {
      await page.setViewportSize(size);
      await runAccountMenuAction(page, "Secrets");
      await expect(panel.getByRole("heading", { name: "Fixture text", exact: true })).toBeVisible();
      await page.screenshot({ path: info.outputPath(`secret-values-hidden-${theme}-${size.width}x${size.height}.png`) });

      await panel.getByRole("button", { name: "Show values of Fixture environment", exact: true }).click();
      const env = panel.getByRole("group", { name: "Values of Fixture environment", exact: true });
      await expect(env.getByRole("textbox", { name: "FIXTURE_USER", exact: true })).toHaveValue("synthetic-user@example.test");
      await expect(env.getByRole("textbox", { name: "FIXTURE_TOKEN", exact: true })).toHaveValue(/^synthetic-token-/);
      await panel.getByRole("button", { name: "Show values of Fixture text", exact: true }).click();
      const text = panel.getByRole("group", { name: "Values of Fixture text", exact: true });
      await expect(text.getByRole("textbox", { name: "Text", exact: true })).toHaveValue("synthetic first line\nsynthetic second line");
      await expect(panel.getByRole("button", { name: "Hide values of Fixture environment", exact: true })).toHaveAttribute("aria-expanded", "true");

      await env.getByRole("button", { name: "Copy FIXTURE_TOKEN", exact: true }).click();
      await expect(env.getByRole("button", { name: "Copy FIXTURE_TOKEN", exact: true })).toHaveText("Copied");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^synthetic-token-/);
      await text.getByRole("button", { name: "Copy Text", exact: true }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("synthetic first line\nsynthetic second line");

      for (const [field, copy] of [[env.getByRole("textbox", { name: "FIXTURE_TOKEN", exact: true }), env.getByRole("button", { name: "Copy FIXTURE_TOKEN", exact: true })],
        [text.getByRole("textbox", { name: "Text", exact: true }), text.getByRole("button", { name: "Copy Text", exact: true })]] as const) {
        await copy.scrollIntoViewIfNeeded();
        await expectWithinViewport(page, copy);
        const [fieldBox, copyBox] = [(await field.boundingBox())!, (await copy.boundingBox())!];
        expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(copyBox.x);
      }
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`secret-values-shown-${theme}-${size.width}x${size.height}.png`) });
      expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toContain("synthetic");

      await panel.getByRole("button", { name: "Hide values of Fixture environment", exact: true }).click();
      await panel.getByRole("button", { name: "Hide values of Fixture text", exact: true }).click();
      await expect(env).toHaveCount(0);
      await expect(text).toHaveCount(0);
      await expect(panel).not.toContainText("synthetic");
      await expect(panel.getByRole("button", { name: "Show values of Fixture environment", exact: true })).toHaveAttribute("aria-expanded", "false");
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    }
    expect(reveals).toEqual(Array.from({ length: 3 }, () => revealable.map(({ id }) => ({ action: "reveal", id }))).flat());
  });
}

test("an in-flight secret Save owns the sheet until failure, then every close preserves the draft", async ({ page }, info) => {
  test.setTimeout(60_000);
  await page.setViewportSize(sizes[0]);
  let requested = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/me/workspace/secrets", async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { secrets: [] } });
    requested = true; await pending;
    await route.fulfill({ status: 503, json: { error: "workspace_secret_unavailable" } });
  });
  try {
    await prepare(page); await runAccountMenuAction(page, "Secrets");
    await page.getByRole("button", { name: "Add secret", exact: true }).click();
    const sheet = page.getByTestId("workspace-secret-sheet");
    await sheet.getByRole("radio", { name: "Text", exact: true }).check();
    await sheet.getByLabel("Name", { exact: true }).fill("Unsaved text");
    const value = sheet.getByLabel("Secret text", { exact: true });
    await value.fill("Synthetic unchanged draft");
    await sheet.getByRole("button", { name: "Save secret", exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    for (const name of ["Cancel", "Close", "Dismiss"]) await expect(sheet.getByRole("button", { name, exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Shift+O");
    await expect(sheet.getByRole("dialog", { name: "Unsaved Workspace secret" })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("secret-save-busy.png") });
    release();
    await expect(sheet.getByRole("alert")).toBeVisible();
    for (const action of ["Cancel", "Close", "Escape", "Dismiss"]) {
      if (action === "Escape") await page.keyboard.press("Escape");
      else if (action === "Dismiss") await sheet.getByRole("button", { name: "Dismiss" }).click({ position: { x: 8, y: 100 } });
      else await sheet.getByRole("button", { name: action, exact: true }).click();
      await sheet.getByRole("button", { name: "Keep editing", exact: true }).click();
      await expect(value).toHaveValue("Synthetic unchanged draft");
    }
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await sheet.getByRole("button", { name: "Confirm discard changes", exact: true }).click();
    await expect(sheet).toHaveCount(0);
  } finally { release(); }
});

test.describe("touch controls", () => {
  test.use({ hasTouch: true });
  test("instruction editor and secret sheet keep actions reachable in both phone orientations", async ({ page }, info) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/me/instructions", route => route.fulfill({ json: { instructions: { activePresetId: null, selectionVersion: 0, presets: [] } } }));
    await page.route("**/api/me/workspace/secrets", route => route.fulfill({ json: { secrets: [] } }));
    await prepare(page);
    for (const size of [sizes[3], sizes[4]]) {
      await page.setViewportSize(size);
      await runAccountMenuAction(page, "Instructions");
      await page.getByRole("button", { name: "New preset", exact: true }).click();
      for (const mode of await page.getByRole("radiogroup", { name: "Editor mode" }).getByRole("radio").all()) await expectTouchSafe(mode);
      await page.getByRole("button", { name: "Cancel", exact: true }).scrollIntoViewIfNeeded();
      await expectTouchSafe(page.getByRole("button", { name: "Cancel", exact: true }));
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`instructions-touch-${size.width}x${size.height}.png`) });
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("tab", { name: "Secrets", exact: true }).click();
      await page.getByRole("button", { name: "Add secret", exact: true }).click();
      const sheet = page.getByTestId("workspace-secret-sheet");
      await sheet.getByRole("radio", { name: "Environment", exact: true }).check();
      await sheet.getByRole("button", { name: "Add variable", exact: true }).click();
      for (const control of await sheet.getByRole("button").all()) {
        if (await control.getAttribute("aria-label") !== "Dismiss") await expectTouchSafe(control);
      }
      for (const input of await sheet.getByRole("textbox").all()) await expectTouchSafe(input);
      await expectWithinViewport(page, sheet.getByRole("button", { name: "Save secret", exact: true }));
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`secrets-touch-${size.width}x${size.height}.png`) });
      await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
      await sheet.getByRole("button", { name: "Confirm discard changes", exact: true }).click();
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    }
  });
});
