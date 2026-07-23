import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, expectTouchSafe } from "./support/layoutAssertions";
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

  await page.route("**/api/me/mcp**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/api/me/mcp") {
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
        return {
          ...server,
          enabled,
          fields: configured
            ? server.fields.map((field) => ({ ...field, configured: true, source: "personal" }))
            : server.fields,
          readiness: enabled ? ready ? "ready" : "needs_setup" : "disabled",
          tools: ready ? [{ description: `${server.name} test tool`, name: `${server.id}_tool` }] : []
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
  await expect(summary).toContainText("MCP tools are off");
  await summary.click();

  let settings = page.getByTestId("settings-dialog");
  await expect(settings.getByRole("heading", { name: "MCP & tools" })).toBeVisible();
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
  await expect(settings.getByText("Ready", { exact: true })).toHaveCount(2);
  expect(patchBodies).toContainEqual({ id: "mem0", value: { values: { api_key: "personal-mem0-token" } } });

  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(summary).toContainText("2/2 MCP ready · 2 tools");

  servers = servers.map((server) => server.id === "notion"
    ? {
        ...server,
        accountLabel: "Research workspace",
        enabled: true,
        oauthState: "ready",
        readiness: "ready",
        tools: [{ description: "Notion test tool", name: "notion_tool" }]
      }
    : server);
  await page.goto("/?settings=mcp&oauth=connected&server=notion");
  settings = page.getByTestId("settings-dialog");
  await expect(settings.getByText("External account connected and MCP enabled.")).toBeVisible();
  await expect(settings.getByText("Research workspace")).toBeVisible();
  await expect(page).not.toHaveURL(/oauth=|settings=mcp|server=notion/u);

  await page.setViewportSize({ height: 844, width: 390 });
  await expectNoHorizontalOverflow(page);
  await expectTouchSafe(settings.getByRole("button", { name: "Disable Mem0" }));
  await expectTouchSafe(settings.getByRole("button", { name: "Close settings" }));
});
