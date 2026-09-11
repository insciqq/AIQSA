import { expect, test } from "@playwright/test";
import type { UserMcpServer } from "../../lib/contracts/mcp";
import { installMatrixCatalogFixture } from "./shell/catalogFixture";
import { expectNoHorizontalOverflow, expectTouchSafe, expectWithinViewport } from "./support/layoutAssertions";
import { signInWithLocalToken as signIn } from "./support/localAuth";

test.use({ hasTouch: true });

for (const profile of [
  { theme: "light", width: 390, height: 844 },
  { theme: "dark", width: 1440, height: 900 }
] as const) {
  test(`MCP Hub onboarding and independent app revocation · ${profile.theme}`, async ({ context, page }, testInfo) => {
    await context.addCookies([{ name: "aiqsa.theme", value: profile.theme, url: "http://127.0.0.1:3000" }]);
    await page.setViewportSize(profile);
    await installMatrixCatalogFixture(page);
    const canonical = `https://${"installation-".repeat(8)}example.test/mcp/hub`;
    await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
    await page.route("**/.well-known/oauth-protected-resource/mcp/hub", (route) => route.fulfill({ json: { resource: canonical } }));
    const common = {
      clientName: "Synthetic agent", clientOrigin: "https://agent.example.test",
      connectedAt: "2026-09-12T00:00:00.000Z", lastUsedAt: null, revokedAt: null, state: "ACTIVE"
    };
    const memory = { ...common, connectionId: "memory-grant", resourcePath: "/mcp", capability: "memory:facts" };
    const hub = { ...common, connectionId: "hub-grant", resourcePath: "/mcp/hub", capability: "mcp:hub" };
    let revoked = false;
    await page.route("**/api/me/connected-apps", (route) => route.fulfill({ json: { apps: [memory, hub] } }));
    await page.route("**/api/me/connected-apps/hub-grant", async (route) => {
      expect(route.request().method()).toBe("DELETE");
      revoked = true;
      await route.fulfill({ json: { app: { ...hub, revokedAt: "2026-09-12T00:01:00.000Z", state: "REVOKED" } } });
    });
    await signIn(page);
    await page.goto("/?settings=mcp");
    const settings = page.getByTestId("settings-v2");
    await settings.getByText("Connect an external agent to MCP Hub", { exact: true }).click();
    await expect(settings.getByLabel("MCP Hub URL")).toHaveValue(canonical);
    await expectWithinViewport(page, settings.getByLabel("MCP Hub URL"));
    await expectTouchSafe(settings.getByRole("button", { name: "Copy URL" }));
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`hub-connect-${profile.theme}.png`) });
    await settings.getByRole("button", { name: "Connected apps", exact: true }).click();
    const revoke = settings.getByRole("button", { name: "Revoke Synthetic agent MCP Hub access" });
    await expectTouchSafe(revoke);
    await revoke.click();
    await expect(settings.getByRole("status").filter({ hasText: "MCP Hub access revoked." }))
      .toHaveText("MCP Hub access revoked. Your MCP connections were kept.");
    expect(revoked).toBe(true);
    await expect(settings.getByRole("button", { name: "Revoke Synthetic agent Personal Memory access" })).toBeEnabled();
    await expect(settings.getByRole("heading", { name: "Synthetic agent" }).last()).toBeFocused();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`hub-revoked-${profile.theme}.png`) });
  });
}

test("explains MCP health failures and timeouts and refreshes their status explicitly", async ({ page }) => {
  await installMatrixCatalogFixture(page);
  const failures = [
    { id: "health-failed", name: "Health fixture", code: "mcp_health_check_failed",
      message: "The MCP health check failed. Check the server and try again." },
    { id: "health-timeout", name: "Timeout fixture", code: "mcp_timeout",
      message: "The MCP server timed out. Check the server and try again." }
  ] as const;
  const failedServers: UserMcpServer[] = failures.map(({ id, name, code }) => ({
    accountLabel: null, description: "Synthetic MCP status fixture", enabled: true, fields: [],
    id, knownToolCount: 1, name, oauthAvailable: false, oauthState: null,
    operationalStatus: "inactive", readiness: "unavailable", runtimeErrorCode: code, tools: []
  }));
  let healthy = false;
  let catalogReads = 0;
  const requestMethods: string[] = [];
  await page.route("**/api/me/mcp**", async (route) => {
    const request = route.request();
    requestMethods.push(request.method());
    if (request.method() !== "GET" || new URL(request.url()).pathname !== "/api/me/mcp") {
      await route.fulfill({ json: { error: "unexpected_mcp_e2e_request" }, status: 400 });
      return;
    }
    catalogReads += 1;
    const servers: UserMcpServer[] = healthy ? failedServers.map((server) => ({
      ...server, operationalStatus: "active", readiness: "ready", runtimeErrorCode: null,
      tools: [{ description: "Synthetic tool inventory", name: `${server.id}_tool` }]
    })) : failedServers;
    await route.fulfill({ json: { servers } });
  });
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?settings=mcp");
  const settings = page.getByTestId("settings-v2");
  for (const failure of failures) {
    const row = settings.getByRole("article", { name: failure.name, exact: true });
    await expect(row.getByRole("status")).toContainText(failure.message);
    await expect(row.getByText("Inactive", { exact: true })).toBeVisible();
    await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  }
  const refresh = settings.getByRole("button", { name: "Refresh status", exact: true });
  await expect(refresh).toBeEnabled();
  await expectTouchSafe(refresh);
  await expectNoHorizontalOverflow(page);
  const readsBeforeRefresh = catalogReads;
  healthy = true;
  await refresh.click();
  await expect.poll(() => catalogReads).toBeGreaterThan(readsBeforeRefresh);
  for (const failure of failures) {
    const row = settings.getByRole("article", { name: failure.name, exact: true });
    await expect(row.getByText("Active", { exact: true })).toBeVisible();
    await expect(row.getByText(failure.message, { exact: true })).toHaveCount(0);
  }
  expect(requestMethods.every((method) => method === "GET")).toBe(true);
});

for (const [kind, notice] of [
  ["connected", "External account connected and MCP enabled."],
  ["cancelled", "Authorization was cancelled."],
  ["failed", "Authorization or automatic MCP enablement failed. Try connecting again."]
] as const) {
  test(`preserves the ${kind} MCP return notice after opening Settings`, async ({ page }, testInfo) => {
    await page.route("**/api/me/mcp", (route) => route.fulfill({ json: { servers: [] } }));
    await signIn(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/?settings=mcp&oauth=${kind}&server=fixture-server`);
    const settings = page.getByTestId("settings-v2");
    await expect(settings.getByText(notice, { exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(/oauth=|settings=mcp|server=fixture-server/u);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`mcp-return-${kind}.png`) });
    await settings.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(settings.getByText(notice, { exact: true })).toHaveCount(0);
  });
}

type FakeMcpServer = {
  accountLabel: string | null;
  description: string;
  enabled: boolean;
  operationalStatus: "active" | "checking" | "inactive";
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
      operationalStatus: "inactive",
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
      operationalStatus: "inactive",
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
      operationalStatus: "inactive",
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
                operationalStatus: "active",
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
          operationalStatus: enabled ? activating ? "checking" : ready ? "active" : "inactive" : "inactive",
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
  const capabilitiesTrigger = page.getByRole("button", { name: "Add" });
  const toolsTrigger = page.getByRole("button", { name: "Change MCP mode" });
  await expect(toolsTrigger).toContainText("!");
  await expect(toolsTrigger).toHaveAttribute("title", "2 MCP servers need attention. Open MCP settings.");
  await expect(toolsTrigger).toHaveAccessibleDescription("2 MCP servers need attention. Open MCP settings.");
  await page.setViewportSize({ height: 844, width: 390 });
  await expectTouchSafe(capabilitiesTrigger);
  await expectTouchSafe(toolsTrigger);
  await expectNoHorizontalOverflow(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await toolsTrigger.click();
  const problems = page.getByRole("menu", { name: "MCP tools" });
  await expect(problems.getByRole("status")).toContainText("Mem0 · Needs setup");
  await expect(problems.getByRole("status")).toContainText("Notion · Needs authorization");
  await expectWithinViewport(page, problems);
  await expectTouchSafe(problems.getByRole("menuitem", { name: "Manage enabled MCP servers" }));
  await page.keyboard.press("Escape");
  await expect(toolsTrigger).toBeFocused();
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ height: 900, width: 1440 });
  // MCP modes live in the Tools chip's own picker, not in the "+" menu.
  await capabilitiesTrigger.click();
  await expect(page.getByRole("menu", { name: "Add" })).toBeVisible();
  await expect(page.getByRole("menu", { name: "Add" }).getByRole("menuitemradio", { name: /^Auto/u }))
    .toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu", { name: "Add" })).toHaveCount(0);
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
  await expect(settings.getByText("Inactive", { exact: true })).toHaveCount(3);
  await settings.getByRole("button", { name: "Complete setup for Mem0" }).click();
  await expect(settings.getByText("Add and save the required personal values before enabling this server.")).toBeVisible();

  const secret = settings.getByLabel("Mem0 API key");
  await expect(secret).toHaveAttribute("type", "password");
  await secret.fill("personal-mem0-token");
  await settings.getByRole("button", { name: "Save personal values" }).click();
  await expect(settings.getByText("Personal value configured")).toBeVisible();
  await expect(secret).toHaveValue("");

  // Rows toggle with a switch (UX audit 2026-09-02 A13); the switch appears
  // for Mem0 only after its personal value is saved.
  await settings.getByRole("switch", { name: "Enable Mem0" }).click();
  await settings.getByRole("switch", { name: "Enable Todoist" }).click();
  await expect(settings.getByText("Checking", { exact: true })).toBeVisible();

  await settings.getByRole("button", { name: "Close settings" }).click();
  await toolsTrigger.click();
  tools = page.getByRole("menu", { name: "MCP tools" });
  await tools.getByRole("menuitem", { name: /Manage enabled MCP servers/u }).click();
  settings = page.getByTestId("settings-v2");
  await expect(settings.getByText("Active", { exact: true })).toHaveCount(2);
  await expect(settings.getByRole("switch", { checked: true })).toHaveCount(2);
  await expect(settings.getByText("Inactive", { exact: true })).toHaveCount(1);
  await expect(settings.getByRole("switch", { name: "Enable Mem0" })).toHaveAttribute("aria-checked", "true");
  await expect(settings.getByText("2 of 3 servers enabled · 2 tools")).toBeVisible();
  await expect(settings.getByText("How tools use data").locator("xpath=..")).not.toHaveAttribute("open", "");
  expect(patchBodies).toContainEqual({ id: "mem0", value: { values: { api_key: "personal-mem0-token" } } });

  await settings.getByRole("button", { name: "Close settings" }).click();
  await toolsTrigger.click();
  tools = page.getByRole("menu", { name: "MCP tools" });
  const autoMode = tools.getByRole("menuitemradio", { name: /^Auto/u });
  const loadAllMode = tools.getByRole("menuitemradio", { name: /^Load all/u });
  const offMode = tools.getByRole("menuitemradio", { name: /^Off/u });
  await expect(autoMode).toHaveAttribute("aria-checked", "true");
  // A mode choice closes the anchored menu; the chip reflects it and the
  // reopened menu shows the new checked row.
  await loadAllMode.click();
  await expect(tools).toHaveCount(0);
  await expect(toolsTrigger).toContainText("MCP: Load all");
  await toolsTrigger.click();
  await expect(loadAllMode).toHaveAttribute("aria-checked", "true");
  await expect(tools.getByRole("menuitemcheckbox", { name: /^Mem0/u })).toHaveCount(0);
  await expect(tools.getByRole("menuitemcheckbox", { name: /^Todoist/u })).toHaveCount(0);
  await expect(tools.getByRole("menuitemcheckbox", { name: /^Notion/u })).toHaveCount(0);
  await offMode.click();
  await expect(tools).toHaveCount(0);
  await toolsTrigger.click();
  await expect(offMode).toHaveAttribute("aria-checked", "true");
  await autoMode.click();
  await expect(tools).toHaveCount(0);
  await toolsTrigger.click();
  await expect(autoMode).toHaveAttribute("aria-checked", "true");
  await expect(tools.getByRole("menuitemcheckbox", { name: /^Mem0/u })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(tools).toHaveCount(0);

  expect(skillListRequests).toBe(0);
  await capabilitiesTrigger.click();
  const capabilities = page.getByRole("menu", { name: "Add" });
  await capabilities.getByRole("menuitem", { name: /^Skills…/u }).click();
  let skillLibrary = page.getByRole("dialog", { name: "Skills" });
  await expect(skillLibrary.getByRole("button", { name: "Open Incident brief" })).toBeVisible();
  expect(skillListRequests).toBe(1);
  await skillLibrary.getByRole("button", { name: "Use Incident brief" }).click();
  await skillLibrary.getByRole("button", { name: "Close Skills" }).click();
  await expect(page.getByRole("button", { name: "Change MCP mode" })).toContainText("MCP: Auto");

  const skillsIndicator = page.getByRole("button", { name: "Manage selected Skills" });
  await expect(skillsIndicator).toContainText("Skills: 1");
  await page.setViewportSize({ height: 844, width: 390 });
  await skillsIndicator.click();
  skillLibrary = page.getByRole("dialog", { name: "Skills" });
  await expectWithinViewport(page, skillLibrary);
  await expectNoHorizontalOverflow(page);
  await expect(skillLibrary.getByText(/1 selected · up to/u)).toBeVisible();
  await expect(skillLibrary.getByRole("button", { name: "Remove Incident brief" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(skillLibrary.getByRole("button", { name: "Close Skills" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(skillLibrary).toBeHidden();
  await expect(skillsIndicator).toBeFocused();

  servers = servers.map((server) => server.id === "notion"
    ? {
        ...server,
        accountLabel: "Team workspace",
        enabled: true,
        oauthState: "ready",
        operationalStatus: "active",
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
  await expectTouchSafe(settings.getByRole("switch", { name: "Enable Mem0" }));
  await expectTouchSafe(settings.getByRole("button", { name: "Close settings" }));

  await page.setViewportSize({ height: 390, width: 844 });
  await expectWithinViewport(page, settings);
  await expectNoHorizontalOverflow(page);
  const refreshStatus = settings.getByRole("button", { name: "Refresh status" });
  await refreshStatus.scrollIntoViewIfNeeded();
  await expect(refreshStatus).toBeInViewport();
  await settings.getByRole("button", { name: "Close settings" }).click();
  await expect(toolsTrigger).not.toContainText("!");
});
