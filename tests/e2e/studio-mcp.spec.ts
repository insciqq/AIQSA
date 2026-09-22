import { expect, test, type Page } from "@playwright/test";
import type { UserMcpServer } from "../../lib/contracts/mcp";
import { authenticateWithLocalToken } from "./support/localAuth";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";

const sizes = [{ width: 1440, height: 900 }, { width: 768, height: 1024 },
  { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }];
const personalField = { configured: false, label: "Personal API key", sensitive: true,
  slotKey: "api_key", source: "missing", valueType: "secret" } as const;

function catalog(): UserMcpServer[] {
  const server = (id: string, name: string, extra: Partial<UserMcpServer> = {}): UserMcpServer => ({
    id, name, accountLabel: null, description: `${name} tools for your personal workspace`, enabled: false,
    fields: [], knownToolCount: 3, oauthAvailable: false, oauthState: null,
    operationalStatus: "inactive", readiness: "disabled", tools: [], ...extra
  });
  return [
    server("github", "GitHub", { enabled: true, readiness: "idle" }),
    server("linear", "Linear", { enabled: true, readiness: "ready", operationalStatus: "active",
      tools: [{ name: "find_issues", description: "Find matching issues" }] }),
    server("research", "Research", { fields: [personalField], readiness: "needs_setup",
      oauthAvailable: true, oauthState: "disconnected" }),
    server("notion", "Notion", { oauthAvailable: true, oauthState: "disconnected", readiness: "needs_authorization" }),
    server("docs", "Docs", { enabled: true, oauthAvailable: true, oauthState: "reauthorization_required",
      readiness: "reauthorization_required", accountLabel: "Synthetic workspace" }),
    server("metrics", "Metrics", { enabled: true, fields: [personalField], readiness: "needs_setup" }),
    server("search", "Search", { enabled: true, readiness: "unavailable", runtimeErrorCode: "mcp_health_check_failed" }),
    server("calendar", "Calendar with a deliberately long integration name", {
      description: "Calendar descriptions remain searchable and are shown in full in the server panel. ".repeat(4)
    })
  ];
}

async function prepare(page: Page, servers: () => UserMcpServer[]) {
  await authenticateWithLocalToken(page.request);
  await installMatrixCatalogFixture(page);
  const requests: string[] = [];
  let hubReads = 0;
  await page.route("**/api/me/mcp**", async route => {
    const request = route.request();
    requests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    if (request.method() === "GET" && new URL(request.url()).pathname === "/api/me/mcp") {
      await route.fulfill({ json: { servers: servers() } });
    } else await route.fulfill({ status: 400, json: { error: "unexpected_test_mutation" } });
  });
  await page.route("**/.well-known/oauth-protected-resource/mcp/hub", async route => {
    hubReads++;
    await route.fulfill({ json: { resource: "https://example.test/mcp/hub" } });
  });
  await page.goto("/?library=mcp");
  await expect(page.getByRole("heading", { name: "MCP servers", exact: true })).toBeVisible();
  await expect(page.getByRole("article")).toHaveCount(8);
  // Account initialization replays effects in the development server. Once
  // the catalog is ready, UI actions must reuse that shared observation.
  return { requests, initialReads: requests.length, hubReads: () => hubReads };
}

test.use({ hasTouch: true });

for (const theme of ["light", "dark"] as const) {
  test(`MCP compact catalog and sheet fit every device · ${theme}`, async ({ page, context }, info) => {
    test.setTimeout(180_000);
    await context.addCookies([{ name: "aiqsa.theme", value: theme, url: "http://127.0.0.1:3000" }]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const servers = catalog();
    const observed = await prepare(page, () => servers);
    const library = page.getByTestId("library-v2");
    const sheet = page.getByRole("dialog", { name: "Calendar with a deliberately long integration name", exact: true });
    for (const size of sizes) {
      await page.setViewportSize(size);
      await expectWithinViewport(page, library.getByRole("tab", { name: "MCP servers", exact: true }));
      await expect(library.getByRole("article")).toHaveCount(8);
      if (size.width === 1440) {
        const rows = await library.getByRole("article").evaluateAll(nodes => nodes.map(node => {
          const box = node.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom };
        }));
        expect(rows.every(row => row.height >= 56)).toBe(true);
        expect(rows.at(-1)!.bottom).toBeLessThanOrEqual(900);
        await info.attach(`mcp-row-geometry-${theme}.json`, { body: JSON.stringify(rows), contentType: "application/json" });
      }
      for (const name of ["Docs", "Metrics"]) {
        await expect(library.getByRole("article", { name, exact: true }).getByRole("switch")).toHaveAttribute("aria-checked", "true");
      }
      await expect(library.getByRole("button", { name: "Complete setup for Research" })).toBeVisible();
      await expect(library.getByRole("link", { name: "Connect Research to enable" })).toHaveCount(0);
      for (const control of [library.getByRole("button", { name: "Open GitHub" }),
        library.getByRole("switch", { name: "Enable GitHub" }), library.getByRole("button", { name: "Complete setup for Research" }),
        library.getByRole("button", { name: "Needs setup 5" }), library.getByRole("searchbox")]) await expectTouchSafe(control);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`mcp-list-${theme}-${size.width}x${size.height}.png`) });
      await library.getByRole("button", { name: "Open Calendar with a deliberately long integration name" }).click();
      await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeFocused();
      await expect(sheet.getByText(servers[7].description, { exact: true })).toBeVisible();
      await expectWithinViewport(page, sheet);
      await expectWithinViewport(page, sheet.getByRole("button", { name: "Cancel", exact: true }));
      expect(await library.evaluate(node => !!node.closest("[inert]"))).toBe(true);
      await page.keyboard.press("Shift+Tab");
      await expect(sheet.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
      await page.keyboard.press("Control+Shift+O");
      await expect(sheet).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`mcp-sheet-${theme}-${size.width}x${size.height}.png`) });
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
      await expect(library.getByRole("button", { name: "Open Calendar with a deliberately long integration name" })).toBeFocused();
    }
    await library.getByRole("button", { name: "Enabled 5" }).click();
    await expect(library.getByRole("article")).toHaveCount(5);
    await library.getByRole("button", { name: "Needs setup 5" }).click();
    await expect(library.getByRole("article")).toHaveCount(5);
    await library.getByRole("button", { name: "All 8" }).click();
    await library.getByRole("searchbox").fill("shown in FULL");
    await expect(library.getByRole("article")).toHaveCount(1);
    expect(observed.requests).toEqual(Array(observed.initialReads).fill("GET /api/me/mcp"));
    expect(observed.hubReads()).toBe(0);
    await library.getByText("Connect an external agent to MCP Hub", { exact: true }).click();
    await expect(library.getByLabel("MCP Hub URL")).toHaveValue("https://example.test/mcp/hub");
    expect(observed.hubReads()).toBe(1);
  });
}

for (const width of [1440, 390]) {
  test(`MCP sheet keeps drafts and busy operations intact at ${width}px`, async ({ page }, info) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const servers = catalog();
    const observed = await prepare(page, () => servers);
    const library = page.getByTestId("library-v2");
    const sheet = page.getByRole("dialog", { name: "Research", exact: true });
    await library.getByRole("button", { name: "Complete setup for Research" }).click();
    const input = sheet.getByLabel("Personal API key", { exact: true });
    await expect(input).toBeFocused();
    await input.fill("synthetic-personal-token");
    await expect(sheet.getByRole("link", { name: "Connect", exact: true })).not.toHaveAttribute("href");
    expect(await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented;
    })).toBe(true);
    await page.keyboard.press("Control+Shift+O");
    await expect(input).toHaveValue("synthetic-personal-token");
    const readsBeforeRefresh = observed.requests.length;
    await sheet.getByRole("button", { name: "Refresh status" }).click();
    await expect.poll(() => observed.requests.length).toBe(readsBeforeRefresh + 1);
    await expect(input).toHaveValue("synthetic-personal-token");
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Unsaved MCP changes" });
    await expect(confirm.getByRole("button", { name: "Keep editing" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(input).toHaveValue("synthetic-personal-token");
    let release!: () => void;
    let requested = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/me/mcp/research", async route => {
      requested = true;
      expect(route.request().postDataJSON()).toEqual({ values: { api_key: "synthetic-personal-token" } });
      await pending;
      await route.fulfill({ status: 503, json: { error: "synthetic_failure" } });
    });
    await sheet.getByRole("button", { name: "Save personal values" }).click();
    await expect.poll(() => requested).toBe(true);
    await expect(sheet.getByRole("button", { name: "Close", exact: true })).toBeDisabled();
    await expect(sheet.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Shift+O");
    await expect(confirm).toHaveCount(0);
    await expect(sheet).toBeVisible();
    await expectWithinViewport(page, sheet.getByRole("button", { name: "Save personal values" }));
    await page.screenshot({ path: info.outputPath(`mcp-busy-${width}.png`) });
    release();
    await expect(sheet.getByRole("alert")).toHaveText("The MCP server could not be updated. Try again.");
    await expect(input).toHaveValue("synthetic-personal-token");
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`mcp-discard-${width}.png`) });
    await confirm.getByRole("button", { name: "Confirm discard changes" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(library.getByRole("button", { name: "Open Research" })).toBeFocused();
    await library.getByRole("button", { name: "Open Research" }).click();
    await expect(input).toHaveValue("");
  });
}
