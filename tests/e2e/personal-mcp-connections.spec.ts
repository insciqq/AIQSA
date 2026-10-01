import { expect, test, type Page as PlaywrightPage, type Route } from "@playwright/test";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

const viewports = [
  { height: 900, name: "desktop", width: 1440 },
  { height: 1024, name: "tablet", width: 768 },
  { height: 844, name: "phone", width: 390 }
] as const;

function customServer(overrides: Record<string, unknown> = {}) {
  return {
    accountLabel: null,
    connectorKey: null,
    description: "Synthetic MCP for the connection settings check.",
    enabled: true,
    fields: [],
    id: "synthetic-mcp",
    knownToolCount: 2,
    name: "Synthetic MCP",
    oauthAvailable: false,
    oauthState: null,
    operationalStatus: "inactive",
    readiness: "ready",
    selectedToolNames: ["search"],
    sourceType: "personal",
    tools: [
      { description: "Search synthetic records.", name: "search" },
      { description: "Delete synthetic records.", name: "delete" }
    ],
    ...overrides
  };
}

async function mockPersonalApis(page: PlaywrightPage) {
  let servers: Record<string, unknown>[] = [];
  await page.route("**/api/me/mcp-connections", async (route: Route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", json: { servers } });
      return;
    }
    servers = [customServer()];
    await route.fulfill({ contentType: "application/json", json: { server: servers[0] }, status: 201 });
  });
  await page.route("**/api/me/mcp-connections/*", async (route: Route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { tool?: { enabled: boolean; name: string } };
      if (body.tool) {
        const tool = body.tool;
        servers = servers.map((server) => server.id === "synthetic-mcp"
          ? { ...server, selectedToolNames: tool.enabled
            ? ["search", "delete"].filter((name) => name === tool.name || (server.selectedToolNames as string[]).includes(name))
            : (server.selectedToolNames as string[]).filter((name) => name !== tool.name) }
          : server);
      }
      await route.fulfill({ contentType: "application/json", json: { server: servers[0] } });
      return;
    }
    await route.fulfill({ contentType: "application/json", json: { server: servers[0] } });
  });
  await page.route("**/api/me/connectors", async (route: Route) => {
    await route.fulfill({ contentType: "application/json", json: { connectors: [
      {
        authOrigins: ["https://accounts.google.com"],
        description: "Search and read Gmail messages.",
        endpoint: "https://gmailmcp.googleapis.com/mcp/v1",
        id: "gmail",
        label: "Gmail",
        scopes: ["openid"],
        status: "preview"
      },
      {
        authOrigins: ["https://mcp.notion.com"],
        description: "Search and work with Notion pages.",
        endpoint: "https://mcp.notion.com/mcp",
        id: "notion",
        label: "Notion",
        scopes: [],
        status: "available"
      }
    ] } });
  });
  await page.route("**/api/me/connectors/*", async (route: Route) => {
    if (route.request().url().includes("/api/me/connectors/oauth/connect")) {
      await route.fulfill({ contentType: "application/json", json: { location: "/ui-v2-fixture?fixture=settings&state=connections" } });
      return;
    }
    if (route.request().method() === "POST") {
      const server = customServer({ connectorKey: "gmail", id: "gmail-1", name: "Gmail", oauthAvailable: true, oauthState: "disconnected" });
      await route.fulfill({ contentType: "application/json", json: { oauthAction: "/api/me/mcp/gmail-1/oauth/connect", server }, status: 201 });
      return;
    }
    await route.fulfill({ contentType: "application/json", json: { status: "disconnected" } });
  });
  await page.route("**/api/me/mcp/*/oauth/connect", async (route: Route) => {
    await route.fulfill({ contentType: "application/json", json: { location: "/ui-v2-fixture?fixture=settings&state=connections" } });
  });
}

for (const viewport of viewports) {
  test(`personal MCP connections remain usable at ${viewport.name} size`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mockPersonalApis(page);
    await page.goto("/ui-v2-fixture?fixture=settings&state=connections");

    const panel = page.getByRole("region", { name: "Personal MCP connections" });
    await expect(panel.getByRole("heading", { name: "Personal connections" })).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Gmail" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const url = page.locator("#personal-mcp-url");
    await url.focus();
    await expect(url).toBeFocused();
    await url.fill("http://127.0.0.1:9000/mcp");
    await expect(panel.getByText("I understand this connection is unencrypted.", { exact: true })).toBeVisible();
    const add = panel.getByRole("button", { name: "Add MCP" });
    await expect(add).toBeDisabled();
    await panel.getByRole("checkbox", { name: "I understand this connection is unencrypted." }).check();
    await expect(add).toBeEnabled();
    await add.click();
    await expect(panel.getByRole("heading", { name: "Synthetic MCP" })).toBeVisible();

    const search = panel.getByRole("checkbox", { name: /search synthetic records/i });
    await expect(search).toBeChecked();
    await search.click();
    await expect(search).not.toBeChecked();
    await expect(panel.getByRole("checkbox", { name: /delete synthetic records/i })).toBeVisible();
    await expectWithinViewport(page, add);

    await page.screenshot({ path: testInfo.outputPath(`personal-mcp-${viewport.name}.png`), fullPage: true });
  });
}

test("a connector card starts OAuth directly", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockPersonalApis(page);
  await page.goto("/ui-v2-fixture?fixture=settings&state=connections");
  const panel = page.getByRole("region", { name: "Personal MCP connections" });
  await panel.locator("article").filter({ hasText: "Gmail" }).getByRole("button", { name: "Connect" }).click();
  await expect(page).toHaveURL(/ui-v2-fixture\?fixture=settings&state=connections/u);
  await expect(panel.getByLabel("Connectors").getByRole("heading", { name: "Gmail" })).toBeVisible();
});
