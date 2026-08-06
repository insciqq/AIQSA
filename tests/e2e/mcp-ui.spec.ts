import { expect, test } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken as signIn } from "./support/localAuth";

type FakeMcpServer = {
  accountLabel: string | null;
  description: string;
  enabled: boolean;
  errorCode: string | null;
  fields: Array<Record<string, unknown>>;
  id: string;
  knownToolCount: number;
  name: string;
  oauthAvailable: boolean;
  oauthState: "disconnected" | "ready" | null;
  readiness: string;
  tools: Array<{ description: string | null; name: string }>;
};

test("keeps multi-MCP enablement, personal secrets, OAuth return, and composer summary coherent", async ({ page }) => {
  await installMatrixCatalogFixture(page);
  let servers: FakeMcpServer[] = [
    {
      accountLabel: null,
      description: "Personal team memory",
      enabled: false,
      errorCode: null,
      fields: [{
        configured: false,
        label: "Mem0 API key",
        minLength: 8,
        sensitive: true,
        slotKey: "api_key",
        source: "missing",
        valueType: "secret"
      }],
      id: "mem0",
      knownToolCount: 1,
      name: "Mem0",
      oauthAvailable: false,
      oauthState: null,
      readiness: "disabled",
      tools: []
    },
    {
      accountLabel: null,
      description: "Team task management",
      enabled: false,
      errorCode: null,
      fields: [],
      id: "todoist",
      knownToolCount: 1,
      name: "Todoist",
      oauthAvailable: false,
      oauthState: null,
      readiness: "disabled",
      tools: []
    },
    {
      accountLabel: null,
      description: "Hosted workspace tools",
      enabled: false,
      errorCode: null,
      fields: [],
      id: "notion",
      knownToolCount: 1,
      name: "Notion",
      oauthAvailable: true,
      oauthState: "disconnected",
      readiness: "disabled",
      tools: []
    }
  ];
  const patchBodies: Array<{ id: string; value: Record<string, unknown> }> = [];
  let todoistActivationPolls = 0;

  await page.route("**/api/me/mcp**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/me/mcp") {
      if (servers.some((server) => server.id === "todoist" && server.readiness === "queued")) {
        todoistActivationPolls += 1;
        if (todoistActivationPolls >= 2) {
          servers = servers.map((server) => server.id === "todoist"
            ? {
                ...server,
                readiness: "ready",
                tools: [{ description: `${server.name} test tool`, name: `${server.id}_tool` }]
              }
            : server);
        }
      }
      await route.fulfill({ contentType: "application/json", json: { servers } });
      return;
    }
    if (request.method() === "PATCH") {
      const id = decodeURIComponent(path.split("/").at(-1) ?? "");
      const value = request.postDataJSON() as Record<string, unknown>;
      patchBodies.push({ id, value });
      servers = servers.map((server) => {
        if (server.id !== id) return server;
        const enabled = typeof value.enabled === "boolean" ? value.enabled : server.enabled;
        const configured = id === "mem0" && Boolean((value.values as Record<string, unknown> | undefined)?.api_key);
        const ready = enabled && (id !== "mem0" || configured || server.fields[0]?.source === "personal");
        const activating = id === "todoist" && enabled && !server.enabled;
        return {
          ...server,
          enabled,
          fields: configured
            ? server.fields.map((field) => ({ ...field, configured: true, source: "personal" }))
            : server.fields,
          readiness: enabled ? activating ? "queued" : ready ? "ready" : "needs_setup" : "disabled",
          tools: ready && !activating
            ? [{ description: `${server.name} test tool`, name: `${server.id}_tool` }]
            : []
        };
      });
      await route.fulfill({
        contentType: "application/json",
        json: { server: servers.find((server) => server.id === id) }
      });
      return;
    }
    await route.fulfill({ contentType: "application/json", json: { error: "unexpected_mcp_e2e_request" }, status: 400 });
  });

  await signIn(page);
  const summary = page.getByTestId("composer-mcp-summary");
  await expect(summary).toContainText("Tools");
  await expect(summary.locator('[data-resource-availability="disabled"]')).toHaveText("Disabled");
  await expect(summary).toHaveAttribute("title", "Tools. Disabled");
  await page.setViewportSize({ height: 844, width: 390 });
  await expectTouchSafe(summary);
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ height: 900, width: 1440 });
  await summary.click();

  let settings = page.getByTestId("settings-dialog");
  await expect(settings.getByRole("heading", { name: "MCP & tools" })).toBeVisible();
  await expect(settings.locator('[data-resource-availability="disabled"]')).toHaveCount(3);
  await settings.getByRole("button", { name: "Complete setup for Mem0" }).click();
  await expect(settings.getByText("Add and save the required personal values before enabling this server.")).toBeVisible();

  const secret = settings.getByLabel("Mem0 API key");
  await expect(secret).toHaveAttribute("type", "password");
  await secret.fill("personal-mem0-token");
  await settings.getByRole("button", { name: "Save personal values" }).click();
  await expect(settings.getByText("Personal value configured")).toBeVisible();
  await expect(secret).toHaveValue("");

  await settings.getByRole("button", { name: "Enable Mem0" }).click();
  await settings.getByRole("button", { name: "Enable Todoist" }).click();
  await expect(settings.getByText("Activating", { exact: true })).toBeVisible();
  await expect(summary).toHaveAttribute("title", /1 activating/u);
  await expect(summary).not.toHaveAttribute("title", /needs setup/u);

  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(summary.getByText("Activating", { exact: true })).toBeVisible();
  await summary.click();
  settings = page.getByTestId("settings-dialog");
  await expect(settings.getByText("Ready", { exact: true })).toHaveCount(2);
  await expect(settings.locator('[data-resource-availability="enabled"]')).toHaveCount(2);
  await expect(settings.locator('[data-resource-availability="disabled"]')).toHaveCount(1);
  expect(patchBodies).toContainEqual({ id: "mem0", value: { values: { api_key: "personal-mem0-token" } } });

  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(summary.locator('[data-resource-availability="enabled"]')).toHaveText("Enabled");
  await expect(summary).toHaveAttribute("title", "Tools. 2/2 ready · 2 tools");

  servers = servers.map((server) => server.id === "notion"
    ? {
        ...server,
        accountLabel: "Team workspace",
        enabled: true,
        oauthState: "ready",
        readiness: "ready",
        tools: [{ description: "Notion test tool", name: "notion_tool" }]
      }
    : server);
  await page.goto("/?settings=mcp&oauth=connected&server=notion");
  settings = page.getByTestId("settings-dialog");
  await expect(settings.getByText("External account connected and MCP enabled.")).toBeVisible();
  await expect(settings.getByText("Team workspace")).toBeVisible();
  await expect(page).not.toHaveURL(/oauth=|settings=mcp|server=notion/u);

  await page.setViewportSize({ height: 844, width: 390 });
  await expectNoHorizontalOverflow(page);
  await expectTouchSafe(settings.getByRole("button", { name: "Disable Mem0" }));
  await expectTouchSafe(settings.getByRole("button", { name: "Close settings" }));

  await page.setViewportSize({ height: 390, width: 844 });
  await expectWithinViewport(page, settings);
  await expectNoHorizontalOverflow(page);
  await expect(settings.getByRole("button", { name: "Refresh status" })).toBeInViewport();
});
