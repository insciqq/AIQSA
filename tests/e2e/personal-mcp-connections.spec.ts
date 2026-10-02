import { expect, test, type Locator, type Page as PlaywrightPage, type TestInfo } from "@playwright/test";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

/**
 * Settings → Connections on the fixture page. The `connections-*` states
 * answer from the in-browser fixture API (`personalMcpFixtureApi.ts`), whose
 * URL hosts select the error scenarios; screenshots are for visual review.
 */
const viewports = [
  { height: 900, name: "desktop", width: 1440 },
  { height: 1024, name: "tablet", width: 768 },
  { height: 844, name: "phone", width: 390 },
  { height: 390, name: "phone-landscape", width: 844 }
] as const;

function fixture(state: string): string {
  return `/ui-v2-fixture?fixture=settings&state=${state}`;
}

function panel(page: PlaywrightPage): Locator {
  return page.getByRole("region", { name: "Personal connections" });
}

async function capture(page: PlaywrightPage, testInfo: TestInfo, name: string, viewport: string, target?: Locator) {
  await target?.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath(`personal-mcp-${name}-${viewport}.png`) });
}

async function submit(page: PlaywrightPage, url: string, auth: "none" | "oauth" | "static" = "none") {
  const section = panel(page);
  await section.locator("#personal-mcp-url").fill(url);
  await section.locator("#personal-mcp-auth").selectOption(auth);
  if (auth === "static") await section.locator("#personal-mcp-token").fill("synthetic-token");
  await section.getByRole("button", { name: "Add MCP" }).click();
}

for (const viewport of viewports) {
  test.describe(`personal MCP connections at ${viewport.name} size`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
    });

    test("adds a connection after the HTTP warning and switches a tool off", async ({ page }, testInfo) => {
      await page.goto(fixture("connections-empty"));
      const section = panel(page);
      await expect(section.getByText("No personal connections yet.", { exact: true })).toBeVisible();
      await capture(page, testInfo, "empty", viewport.name);

      const url = section.locator("#personal-mcp-url");
      await url.focus();
      await expect(url).toBeFocused();
      await url.fill("http://127.0.0.1:9000/mcp");
      const add = section.getByRole("button", { name: "Add MCP" });
      await expect(add).toBeDisabled();
      await capture(page, testInfo, "http-warning", viewport.name, add);
      await section.getByRole("checkbox", { name: "I understand this connection is unencrypted." }).check();
      await expect(add).toBeEnabled();
      await expectWithinViewport(page, add);
      await add.click();

      const heading = section.getByRole("heading", { name: "127.0.0.1" });
      await expect(heading).toBeFocused();
      const tool = section.getByRole("checkbox", { name: /docs_tool_01/ });
      await expect(tool).toBeChecked();
      await tool.click();
      await expect(tool).not.toBeChecked();
      await expect(section.getByText("1 of 2 tools on")).toBeVisible();
    });

    test("explains create errors next to their fields", async ({ page }, testInfo) => {
      await page.goto(fixture("connections-empty"));
      const section = panel(page);
      const scenarios = [
        { copy: /25 personal connections/, name: "limit", url: "https://limit.example/mcp" },
        { copy: /Try again in 2 minutes/, name: "rate-limit", url: "https://rate.example/mcp" },
        { copy: /belongs to AIQSA's own services/, name: "internal-address", url: "https://internal.example/mcp" },
        { copy: /turned off connections to the local network/, name: "local-network", url: "https://lan.example/mcp" }
      ];
      for (const scenario of scenarios) {
        await submit(page, scenario.url);
        const message = section.getByText(scenario.copy).first();
        await expect(message).toBeVisible();
        await capture(page, testInfo, `error-${scenario.name}`, viewport.name, message);
      }
      await submit(page, "https://token.example/mcp", "static");
      await expect(section.locator("#personal-mcp-token")).toHaveAttribute("aria-invalid", "true");
      await capture(page, testInfo, "error-token", viewport.name, section.locator("#personal-mcp-token"));
    });

    test("confirms a cross-site sign-in site and keeps the form on Cancel", async ({ page }, testInfo) => {
      await page.goto(fixture("connections-empty"));
      const section = panel(page);
      await section.locator("#personal-mcp-name").fill("Work wiki");
      await submit(page, "https://confirm.example/mcp", "oauth");
      const confirm = section.getByRole("group", { name: "Confirm the sign-in site" });
      await expect(confirm.getByText("https://login.confirm-auth.example")).toBeVisible();
      await expect(confirm.getByRole("heading", { name: "Confirm the sign-in site" })).toBeFocused();
      await capture(page, testInfo, "cross-site-confirmation", viewport.name, confirm);
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await expect(section.locator("#personal-mcp-name")).toHaveValue("Work wiki");
      await expect(section.locator("#personal-mcp-url")).toHaveValue("https://confirm.example/mcp");
    });

    test("shows a load failure with Retry instead of an empty list", async ({ page }, testInfo) => {
      await page.goto(fixture("connections-error"));
      const section = panel(page);
      await expect(section.getByRole("alert")).toHaveText("Your connections could not be loaded.");
      await expect(section.getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(section.getByText("No personal connections yet.")).toHaveCount(0);
      await capture(page, testInfo, "load-error", viewport.name);
    });

    test("replaces a rejected token in place", async ({ page }, testInfo) => {
      await page.goto(fixture("connections-rows"));
      const section = panel(page);
      const github = section.locator("article", { has: page.getByRole("heading", { name: "GitHub" }) });
      await expect(github.getByText("The server rejected the stored token. Replace the token to continue.")).toBeVisible();
      await github.getByRole("button", { name: "Replace token for GitHub" }).click();
      const form = github.getByRole("form", { name: "Replace token for GitHub" });
      const token = form.getByLabel(/New token or API key/);
      await expect(token).toBeFocused();
      await expect(form.getByLabel(/^Header name/)).toHaveValue("Authorization");
      await capture(page, testInfo, "replace-token", viewport.name, form);

      await token.fill("reject-this-token");
      await form.getByRole("button", { name: "Save token" }).click();
      await expect(token).toHaveAttribute("aria-invalid", "true");
      await capture(page, testInfo, "replace-token-error", viewport.name, form);

      await token.fill("ghp_synthetic_new");
      await form.getByRole("button", { name: "Save token" }).click();
      await expect(github.getByText("Token replaced. New messages use it.")).toBeVisible();
      await expect(github.getByRole("button", { name: "Replace token for GitHub" })).toBeFocused();
    });

    test("separates failed, reconnect and starting connections and filters a long tool list", async ({ page }, testInfo) => {
      await page.goto(fixture("connections-rows"));
      const section = panel(page);
      await expect(section.getByRole("heading", { name: "Docs search" })).toBeVisible();
      await capture(page, testInfo, "rows", viewport.name);

      const notion = section.locator("article", { has: page.getByRole("heading", { name: "Notion" }) });
      await expect(notion.getByRole("button", { name: "Reconnect Notion" })).toBeVisible();
      await capture(page, testInfo, "reconnect", viewport.name, notion);

      const homeLab = section.locator("article", { has: page.getByRole("heading", { name: "Home lab" }) });
      await expect(homeLab.getByText(/local network/)).toBeVisible();
      const localTools = section.locator("article", { has: page.getByRole("heading", { name: "Local tools" }) });
      await expect(localTools.getByText(/localhost means the AIQSA server itself/)).toBeVisible();
      await capture(page, testInfo, "runtime-failure", viewport.name, localTools);

      const tracker = section.locator("article", { has: page.getByRole("heading", { name: "Tracker" }) });
      await expect(tracker.getByText("Starting runtime")).toBeVisible();
      await expect(tracker.getByText("Starting runtime")).toHaveCount(0, { timeout: 15_000 });

      const docs = section.locator("article", { has: page.getByRole("heading", { name: "Docs search" }) });
      const filter = docs.getByRole("searchbox", { name: "Filter tools of Docs search" });
      await filter.fill("tool_1");
      await expect(docs.getByRole("checkbox")).toHaveCount(10);
      await capture(page, testInfo, "tool-filter", viewport.name, filter);

      const changed = section.locator("article", { has: page.getByRole("heading", { name: "Changed sign-in" }) });
      await changed.getByRole("button", { exact: true, name: "Connect Changed sign-in" }).click();
      await expect(changed.getByRole("button", { name: "Disconnect and add again" })).toBeVisible();
      await capture(page, testInfo, "reconnect-refused", viewport.name, changed);
    });
  });
}

for (const viewport of viewports) {
  test.describe(`composer personal MCP disclosure at ${viewport.name} size`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ height: viewport.height, width: viewport.width });
    });

    test("lists personal connections and links one needing attention to Connections", async ({ page }, testInfo) => {
      await page.goto("/ui-v2-fixture?fixture=composer&state=mcp-personal");
      const link = page.getByRole("menuitem", { name: "Open Connections in Settings for Notion" });
      await expect(link).toBeVisible();
      await expect(page.getByTestId("composer-v2-mcp-servers")).toContainText("Docs search");
      await expect(page.getByRole("menuitem", { name: "Manage enabled MCP servers" })).toHaveText(/Manage/);
      await capture(page, testInfo, "composer-disclosure", viewport.name, link);
    });

    test("keeps the draft and explains a Load all refusal over the tool limit", async ({ page }, testInfo) => {
      await page.goto("/ui-v2-fixture?fixture=composer&state=load-all-refused");
      const refusal = page.getByRole("alert").filter({ hasText: "Load all can offer at most" });
      await expect(refusal).toContainText("Use Auto, or switch tools off in Settings → Connections.");
      await expect(page.getByRole("textbox", { name: "Message" })).not.toHaveValue("");
      await capture(page, testInfo, "composer-load-all-refused", viewport.name, refusal);
    });
  });
}
