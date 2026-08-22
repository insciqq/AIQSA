import { expect, test } from "@playwright/test";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken as signIn } from "./support/localAuth";

test.use({ hasTouch: true });

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

test("keeps multi-MCP enablement, personal secrets, OAuth return, and composer capabilities coherent", async ({ page }) => {
  await installMatrixCatalogFixture(page);
  let skillListRequests = 0;
  await page.route("**/api/me/skills**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") {
      await route.fulfill({ contentType: "application/json", json: { error: "unexpected_skill_e2e_request" }, status: 400 });
      return;
    }
    const summary = {
      archived: false,
      description: "Turn rough notes into a concise incident brief",
      id: "incident-brief",
      instructionCharacterCount: 64,
      name: "Incident brief",
      owned: true,
      ownerDisplayName: "Local admin",
      scope: { kind: "owner" },
      updatedAt: "2026-08-16T00:00:00.000Z",
      version: 1
    };
    if (path === "/api/me/skills/incident-brief") {
      await route.fulfill({
        contentType: "application/json",
        json: {
          skill: {
            ...summary,
            assistantUsageCount: 0,
            audiences: [],
            canDelete: true,
            canEdit: true,
            canPublish: true,
            canUnshare: false,
            instructions: "Summarize impact, timeline, current status, and next actions.",
            owner: { displayName: "Local admin" },
            workspaceUsageCount: 0
          }
        }
      });
      return;
    }
    skillListRequests += 1;
    await route.fulfill({
      contentType: "application/json",
      json: {
        nextCursor: null,
        publishableWorkspaces: [],
        skills: [summary],
        viewer: { canPublishInstallation: true }
      }
    });
  });
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
  const capabilitiesTrigger = page.getByRole("button", { name: "Capabilities" });
  const toolsTrigger = page.getByRole("button", { name: "Change MCP tool mode" });
  await page.setViewportSize({ height: 844, width: 390 });
  await expectTouchSafe(capabilitiesTrigger);
  await expectTouchSafe(toolsTrigger);
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ height: 900, width: 1440 });
  // MCP modes live in the Tools chip's own picker, not in the "+" menu.
  await capabilitiesTrigger.click();
  await expect(page.getByRole("menu", { name: "Capabilities" })).toBeVisible();
  await expect(page.getByRole("menu", { name: "Capabilities" }).getByRole("menuitemradio", { name: /^Auto/u }))
    .toHaveCount(0);
  await page.getByRole("menu", { name: "Capabilities" }).getByRole("button", { name: "Close" }).click();
  await toolsTrigger.click();
  let tools = page.getByRole("menu", { name: "MCP tools" });
  await expect(tools.getByRole("menuitemradio", { name: /^Auto/u }))
    .toHaveAttribute("aria-checked", "true");
  await expect(tools.getByRole("menuitemradio", { name: /^Load all/u })).toBeEnabled();
  await expect(tools.getByRole("menuitemradio", { name: /^Off/u }))
    .toHaveAttribute("aria-checked", "false");
  await expect(tools.getByRole("menuitemcheckbox", { name: /^Mem0/u })).toHaveCount(0);
  await tools.getByRole("menuitem", { name: /Manage enabled MCP servers/u }).click();

  let settings = page.getByTestId("settings-v2");
  await expect(settings.getByRole("heading", { level: 2, name: "MCP & tools" })).toBeVisible();
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

  await settings.getByRole("button", { name: "Close settings" }).click();
  await toolsTrigger.click();
  tools = page.getByRole("menu", { name: "MCP tools" });
  await tools.getByRole("menuitem", { name: /Manage enabled MCP servers/u }).click();
  settings = page.getByTestId("settings-v2");
  await expect(settings.getByText("Ready", { exact: true })).toHaveCount(2);
  await expect(settings.locator('[data-resource-availability="enabled"]')).toHaveCount(2);
  await expect(settings.locator('[data-resource-availability="disabled"]')).toHaveCount(1);
  expect(patchBodies).toContainEqual({ id: "mem0", value: { values: { api_key: "personal-mem0-token" } } });

  await settings.getByRole("button", { name: "Close settings" }).click();
  await toolsTrigger.click();
  tools = page.getByRole("menu", { name: "MCP tools" });
  const autoMode = tools.getByRole("menuitemradio", { name: /^Auto/u });
  const loadAllMode = tools.getByRole("menuitemradio", { name: /^Load all/u });
  const offMode = tools.getByRole("menuitemradio", { name: /^Off/u });
  await expect(autoMode).toHaveAttribute("aria-checked", "true");
  await loadAllMode.click();
  await expect(loadAllMode).toHaveAttribute("aria-checked", "true");
  await expect(tools.getByRole("menuitemcheckbox", { name: /^Mem0/u })).toHaveCount(0);
  await expect(tools.getByRole("menuitemcheckbox", { name: /^Todoist/u })).toHaveCount(0);
  await expect(tools.getByRole("menuitemcheckbox", { name: /^Notion/u })).toHaveCount(0);
  await offMode.click();
  await expect(offMode).toHaveAttribute("aria-checked", "true");
  await autoMode.click();
  await expect(autoMode).toHaveAttribute("aria-checked", "true");
  await expect(tools.getByRole("menuitemcheckbox", { name: /^Mem0/u })).toHaveCount(0);
  await tools.getByRole("button", { name: "Close" }).click();

  expect(skillListRequests).toBe(0);
  await capabilitiesTrigger.click();
  const capabilities = page.getByRole("menu", { name: "Capabilities" });
  await capabilities.getByRole("menuitem", { name: "Manage Skills…" }).click();
  let skillLibrary = page.getByRole("dialog", { name: "Skills" });
  await expect(skillLibrary.getByRole("button", { name: "Open Incident brief" })).toBeVisible();
  expect(skillListRequests).toBe(1);
  await skillLibrary.getByRole("button", { name: "Use Incident brief" }).click();
  await skillLibrary.getByRole("button", { name: "Close Skills" }).click();
  await expect(page.getByRole("button", { name: "Change MCP tool mode" })).toContainText("Tools: Auto");

  const skillsIndicator = page.getByRole("button", { name: "Manage selected Skills" });
  await expect(skillsIndicator).toContainText("Skills: 1");
  await page.setViewportSize({ height: 844, width: 390 });
  await skillsIndicator.click();
  skillLibrary = page.getByRole("dialog", { name: "Skills" });
  await expectWithinViewport(page, skillLibrary);
  await expectNoHorizontalOverflow(page);
  await expect(skillLibrary.getByText(/Skills are text-only/u)).toBeVisible();
  await expect(skillLibrary.getByRole("button", { name: "Remove Incident brief" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(skillLibrary.getByRole("button", { name: "New Skill" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(skillLibrary).toBeHidden();
  await expect(skillsIndicator).toBeFocused();

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
  settings = page.getByTestId("settings-v2");
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
  const refreshStatus = settings.getByRole("button", { name: "Refresh status" });
  await refreshStatus.scrollIntoViewIfNeeded();
  await expect(refreshStatus).toBeInViewport();
});
