import { expect, test, type Locator, type Page } from "@playwright/test";
import type { AdminDashboard } from "../../lib/contracts/admin";
import type {
  AdminMcpCreateRequest,
  AdminMcpServer,
  AdminMcpUpdateRequest,
  McpDraftTestSummary,
  McpRevisionSummary
} from "../../lib/contracts/mcp";
import {
  expectNoHorizontalOverflow,
  expectTouchSafe
} from "./support/layoutAssertions";
import { signInWithLocalToken } from "./support/localAuth";

test.use({ hasTouch: true });

const fixedTime = "2026-07-26T08:00:00.000Z";
const bannedWords = /\bdraft\b|revision|pending|probe|evidence|adapter|fingerprint|\bversion\b|\bCAS\b|tuple/iu;

async function expectReadableDetail(page: Page, detail: Locator) {
  const box = await detail.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.width).toBeGreaterThanOrEqual(640);
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
}

function adminDashboard(): AdminDashboard {
  return {
    accessRules: [],
    catalog: { models: [], providers: [], searchStrategies: [] },
    groups: [
      { accessGrants: [], archivedAt: null, id: "group-operators", name: "operators", systemRole: null, userCount: 1 },
      { accessGrants: [], archivedAt: null, id: "group-full", name: "Full access", systemRole: "full_access", userCount: 1 }
    ],
    invites: [],
    navigation: {
      advancedConfigured: true,
      attention: {
        activeUsersWithoutModelAccess: 0,
        openInvites: 0,
        pendingUsers: 0
      },
      teamConfigured: false
    },
    usage: {
      byGroup: [],
      byUser: [],
      totals: {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        inputTokens: 0,
        lastUsedAt: null,
        outputTokens: 0,
        reasoningTokens: 0,
        runCount: 0,
        totalTokens: 0
      }
    },
    users: [{
      directGrants: [],
      displayName: "Alice Operator",
      effectiveEntitlements: { models: [], providers: [], searchStrategies: [] },
      email: "alice@example.test",
      groups: [{ groupId: "group-operators", name: "operators", role: "member" }],
      hasVerifiedIdentity: true,
      id: "user-alice",
      lastSessionAt: null,
      role: "user",
      status: "active"
    }]
  };
}

function testedDraft(identityHash: string): McpDraftTestSummary {
  return {
    draftHash: `draft-${identityHash}`,
    evidence: { fixture: "playwright" },
    identityHash,
    resolvedArtifact: {
      kind: "npm",
      packageName: "@example/mcp",
      version: "1.0.0"
    },
    testedAt: fixedTime,
    toolInventory: [
      { description: "Search fixture records", name: "fixture_search" },
      { description: "Write a fixture record", name: "fixture_write" }
    ]
  };
}

function revision(
  id: string,
  revisionNumber: number,
  identityHash: string,
  artifactStatus: McpRevisionSummary["artifactStatus"]
): McpRevisionSummary {
  const evidence = testedDraft(identityHash);
  return {
    artifactStatus,
    createdAt: fixedTime,
    draftHash: evidence.draftHash,
    id,
    identityHash,
    resolvedArtifact: artifactStatus === "not_applicable" ? null : evidence.resolvedArtifact,
    revisionNumber,
    validationEvidence: {
      evidence: evidence.evidence,
      testedAt: evidence.testedAt,
      toolInventory: evidence.toolInventory
    }
  };
}

function existingServer(): AdminMcpServer {
  const active = revision("existing-revision", 1, "existing-identity", "not_applicable");
  return {
    activePersonalSlots: [],
    activeRevision: active,
    activation: null,
    archivedAt: null,
    description: "Existing server used to prove the list and page flows.",
    draft: {
      auth: { mode: "none" },
      runtime: { callTimeoutMs: 60_000, startupTimeoutMs: 60_000 },
      slots: [],
      source: { kind: "remote", url: "https://existing.example.test/mcp" },
      transport: "streamable_http"
    },
    draftTest: {
      ...testedDraft("existing-identity"),
      resolvedArtifact: null
    },
    draftTested: true,
    enabled: true,
    grants: [],
    id: "existing-server",
    name: "Existing Search Server",
    namespace: "existing_search_server",
    revisions: [active],
    sharedValues: {},
    updatedAt: fixedTime,
    validationOAuth: null
  };
}

function serverFromCreate(body: AdminMcpCreateRequest): AdminMcpServer {
  return {
    activePersonalSlots: [],
    activeRevision: null,
    activation: body.activate ? {
      completedAt: null,
      errorCode: null,
      id: "browser-activation",
      issues: [],
      requestedAt: fixedTime,
      stage: "queued",
      startedAt: null,
      updatedAt: fixedTime
    } : null,
    archivedAt: null,
    description: body.description ?? "",
    draft: body.draft,
    draftTest: null,
    draftTested: false,
    enabled: false,
    grants: [],
    id: "browser-mcp",
    name: body.name,
    namespace: "browser_mcp",
    revisions: [],
    sharedValues: Object.fromEntries(
      body.draft.slots
        .filter((slot) => slot.policy.kind === "shared")
        .map((slot) => [slot.slotKey, {
          configured: Boolean(body.sharedValues && Object.hasOwn(body.sharedValues, slot.slotKey)),
          updatedAt: body.sharedValues && Object.hasOwn(body.sharedValues, slot.slotKey) ? fixedTime : null
        }])
    ),
    updatedAt: fixedTime,
    validationOAuth: null
  };
}

async function openMcpServers(page: Page) {
  await page.goto("/admin?section=mcp");
  const section = page.getByTestId("admin-section-mcp");
  await expect(section).toBeVisible();
  await expect(page.getByTestId("admin-topbar-title")).toHaveText("MCP servers");
  return section;
}

test("administrator adds a server from a pasted configuration, watches the setup on its page and manages it without tabs", async ({ page }) => {
  test.setTimeout(90_000);
  let servers: AdminMcpServer[] = [existingServer()];
  let failNextCheck = false;
  const requests: Array<{
    body: Record<string, unknown> | null;
    method: string;
    path: string;
  }> = [];

  await page.route("**/api/admin", async (route) => {
    await route.fulfill({ contentType: "application/json", json: adminDashboard() });
  });

  await page.route("**/api/admin/mcp**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postData()
      ? request.postDataJSON() as Record<string, unknown>
      : null;
    requests.push({ body, method, path });

    if (method === "GET" && path === "/api/admin/mcp") {
      const pending = servers.find((server) => server.activation?.stage === "queued");
      if (pending) {
        const active = revision("active-revision", 2, "activated-identity", "available");
        const missing = revision("missing-revision", 1, "missing-identity", "missing");
        servers = servers.map((server) => server.id === pending.id ? {
          ...server,
          activeRevision: active,
          activation: {
            ...pending.activation!,
            completedAt: fixedTime,
            stage: "ready",
            startedAt: fixedTime,
            updatedAt: fixedTime
          },
          draftTest: testedDraft("activated-identity"),
          draftTested: true,
          enabled: true,
          revisions: [active, missing]
        } : server);
      }
      await route.fulfill({ contentType: "application/json", json: { servers } });
      return;
    }

    if (method === "POST" && path === "/api/admin/mcp") {
      const created = serverFromCreate(body as AdminMcpCreateRequest);
      servers = [...servers, created];
      await route.fulfill({ contentType: "application/json", json: { server: created }, status: body?.activate ? 202 : 201 });
      return;
    }

    const serverId = decodeURIComponent(path.split("/")[4] ?? "");
    const current = servers.find((server) => server.id === serverId);
    if (!current) {
      await route.fulfill({ contentType: "application/json", json: { error: "mcp_not_found" }, status: 404 });
      return;
    }

    const replace = (next: AdminMcpServer) => {
      servers = servers.map((server) => server.id === next.id ? next : server);
      return next;
    };

    if (method === "POST" && path.endsWith("/check-update")) {
      const checked = replace({
        ...current,
        draftTest: testedDraft("checked-identity"),
        draftTested: true
      });
      await route.fulfill({ contentType: "application/json", json: { server: checked } });
      return;
    }

    if (method === "POST" && path.endsWith("/test")) {
      if (failNextCheck) {
        failNextCheck = false;
        await route.fulfill({ status: 400, json: { error: "mcp_draft_test_failed", issues: [{ code: "mcp_remote_validation_failed", path: "source" }] } });
        return;
      }
      const update = body as AdminMcpUpdateRequest;
      const candidateDraft = update.draft ?? current.draft;
      const active = { ...revision("saved-revision", 3, "tested-identity", "available"), disabledToolNames: candidateDraft.disabledToolNames };
      const tested = replace({
        ...current,
        draft: candidateDraft,
        ...(update.name ? { name: update.name } : {}),
        ...(update.description !== undefined ? { description: update.description } : {}),
        draftTest: testedDraft("tested-identity"),
        draftTested: true,
        ...(body?.publish ? { activeRevision: active, revisions: [active, ...current.revisions.filter((candidate) => candidate.id !== active.id)] } : {})
      });
      await route.fulfill({ contentType: "application/json", json: { server: tested } });
      return;
    }

    if (method === "POST" && path.endsWith("/rebuild")) {
      const rebuiltTest = testedDraft("rebuilt-identity");
      const rebuiltRevision = revision("rebuilt-revision", 3, "rebuilt-identity", "available");
      const rebuilt = replace({
        ...current,
        activeRevision: rebuiltRevision,
        draftTest: rebuiltTest,
        draftTested: true,
        enabled: true,
        revisions: [rebuiltRevision, ...current.revisions]
      });
      await route.fulfill({ contentType: "application/json", json: { server: rebuilt } });
      return;
    }

    if (method === "PUT" && path.endsWith("/grants")) {
      const grant = {
        canUse: Boolean(body?.canUse),
        groupId: (body?.groupId as string | undefined) ?? null,
        groupName: null,
        id: `grant-${requests.length}`,
        personalSlotKeys: (body?.personalSlotKeys as string[] | undefined) ?? [],
        userId: (body?.userId as string | undefined) ?? null,
        userName: null
      };
      const granted = replace({ ...current, grants: [...current.grants, grant] });
      await route.fulfill({ contentType: "application/json", json: { server: granted } });
      return;
    }

    if (method === "PATCH" && path === `/api/admin/mcp/${encodeURIComponent(serverId)}`) {
      const update = body as AdminMcpUpdateRequest;
      const disabledToolNames = new Set(current.activeRevision?.disabledToolNames ?? []);
      if (update.tool) {
        if (update.tool.enabled) disabledToolNames.delete(update.tool.name);
        else disabledToolNames.add(update.tool.name);
      }
      const active = update.tool && current.activeRevision ? {
        ...current.activeRevision, id: `tool-revision-${requests.length}`,
        disabledToolNames: [...disabledToolNames], revisionNumber: current.activeRevision.revisionNumber + 1
      } : null;
      const updated = replace({
        ...current,
        ...(active ? {
          activeRevision: active, revisions: [active, ...current.revisions],
          draft: { ...current.draft, disabledToolNames: [...disabledToolNames] }
        } : {}),
        ...(typeof update.enabled === "boolean" ? { enabled: update.enabled } : {}),
        ...(update.draft ? { draft: update.draft, draftTested: false } : {}),
        ...(update.name ? { name: update.name } : {}),
        ...(update.description !== undefined ? { description: update.description } : {}),
        updatedAt: fixedTime
      });
      await route.fulfill({ contentType: "application/json", json: { server: updated } });
      return;
    }

    if (method === "DELETE" && path === `/api/admin/mcp/${encodeURIComponent(serverId)}`) {
      const tombstone = {
        ...current,
        archivedAt: fixedTime,
        enabled: false
      };
      servers = servers.filter((server) => server.id !== serverId);
      await route.fulfill({ contentType: "application/json", json: { server: tombstone } });
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      json: { error: "unexpected_admin_mcp_e2e_request" },
      status: 400
    });
  });

  await signInWithLocalToken(page);
  const section = await openMcpServers(page);

  // List: one status word per row, a search box, no horizontal overflow at every width.
  const list = section.getByTestId("mcp-server-list");
  const existingRow = section.getByTestId("mcp-server-row-existing-server");
  await expect(existingRow.getByTestId("mcp-server-status")).toHaveText("Working");
  await expect(existingRow).toContainText("2 tools on");
  await expect(section).not.toContainText(bannedWords);
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ height: 900, width: 768 });
  await expectNoHorizontalOverflow(page);
  const search = section.getByRole("searchbox", { name: "Search servers" });
  await search.fill("nothing here");
  await expect(list).toContainText("No servers match this search.");
  await search.fill("");

  // Row → page through the URL resource, crumbs back to the list.
  await existingRow.getByRole("link", { name: /^Open Existing Search Server/u }).click();
  await expect(page).toHaveURL(/section=mcp&resource=existing-server/u);
  await expect(page.getByTestId("admin-topbar-title")).toContainText("Existing Search Server");
  await expect(section.getByTestId("mcp-server-page-status")).toContainText("Working · 2 tools on · checked");
  await expect(section.getByRole("tab")).toHaveCount(0);
  await page.getByTestId("admin-topbar-title").getByRole("link", { name: "MCP servers" }).click();
  await expect(page).not.toHaveURL(/resource=/u);
  await expect(list).toBeVisible();

  // New server: the settings sheet in create mode, paste → Parse → Test & Save.
  await page.getByTestId("mcp-new-server").click();
  const sheet = page.getByRole("dialog", { name: "New server" });
  await expect(sheet).toBeVisible();
  const importEditor = sheet.getByLabel("Configuration JSON, URL, or install command");
  const parse = sheet.getByRole("button", { name: "Parse" });
  await expect(parse).toBeDisabled();

  await page.setViewportSize({ height: 844, width: 390 });
  await expectNoHorizontalOverflow(page);
  await importEditor.fill("npx -y @example/mcp@latest");
  await expectTouchSafe(parse);

  await page.setViewportSize({ height: 900, width: 1440 });
  await importEditor.fill(`{
  "mcpServers": {
    "browser-mcp": {
      "args": ["-y", "@example/mcp@1.0.0",],
      "command": "npx",
      "env": { "API_KEY": "browser-write-only-secret", },
    },
  },
}`);
  await parse.click();
  await expect(sheet.getByLabel("Name")).toHaveValue("browser-mcp");
  await expect(sheet.getByLabel("Name")).toBeFocused();
  await expect(sheet.getByLabel("Source")).toHaveValue("npm");
  const importedSecret = sheet.getByLabel("New shared value for API_KEY");
  await expect(importedSecret).toHaveAttribute("type", "password");
  await expect(importedSecret).toHaveValue("browser-write-only-secret");
  await expect(sheet).not.toContainText(bannedWords);
  await expectNoHorizontalOverflow(page);

  await sheet.getByRole("button", { name: "Test & Save" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/resource=browser-mcp/u);
  await expect(page.getByTestId("admin-feedback")).toContainText("Setup continues in the background");

  // Activation progress is a banner on the page; polling finishes it.
  const page_ = section.getByTestId("mcp-server-page");
  const progress = section.getByTestId("admin-mcp-activation-progress");
  await expect(progress).toContainText("Starting");
  await expect(progress).toContainText("Step 1 of 6");
  await expect(section.getByTestId("mcp-server-page-status")).toContainText("Applying");
  await expect(section.getByTestId("mcp-test-save")).toBeDisabled();
  await expect(progress).toHaveCount(0, { timeout: 10_000 });
  await expect(section.getByTestId("mcp-server-page-status")).toContainText("Working · 2 tools on");

  for (const viewport of [
    { height: 768, width: 1024 },
    { height: 900, width: 1440 }
  ]) {
    await page.setViewportSize(viewport);
    await expectNoHorizontalOverflow(page);
    await expectReadableDetail(page, page_);
  }
  for (const viewport of [
    { height: 1024, width: 768 },
    { height: 844, width: 390 }
  ]) {
    await page.setViewportSize(viewport);
    await expect(page_).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
  await page.setViewportSize({ height: 900, width: 1440 });

  // A tool switch publishes immediately and survives a reload.
  const writeTool = section.getByRole("switch", { name: "Use fixture_write" });
  await expect(writeTool).toBeChecked();
  await writeTool.click();
  await expect(writeTool).not.toBeChecked();
  await expect(page.getByTestId("admin-feedback")).toContainText("Tool disabled.");
  await expect(section.getByTestId("mcp-server-page-status")).toContainText("Working · 1 of 2 tools on");
  await page.reload();
  await expect(writeTool).not.toBeChecked();

  // Connection edits still require a successful check and retain failed input.
  await page.getByTestId("mcp-open-settings").click();
  const checkedSettings = page.getByRole("dialog", { name: "Settings" });
  const description = checkedSettings.getByRole("textbox", { name: /^Description Shown to people/ });
  await description.fill("Updated fixture description");
  failNextCheck = true;
  await checkedSettings.getByRole("button", { name: "Test & Save" }).click();
  await expect(checkedSettings).toContainText("Your changes were not applied");
  await expect(description).toHaveValue("Updated fixture description");

  await checkedSettings.getByRole("button", { name: "Test & Save" }).click();
  await expect(checkedSettings).toHaveCount(0);
  await expect(page.getByTestId("admin-feedback")).toContainText("Settings checked and applied.");
  await expect(section.getByTestId("mcp-server-page-status")).toContainText("Working · 1 of 2 tools on");
  await expect(section.getByRole("switch", { name: "Use fixture_write" })).not.toBeChecked();

  // Access: groups and people with switches; Full access is always included.
  const groupsList = section.getByRole("list", { name: "Groups with access to browser-mcp" });
  await expect(groupsList.getByTestId("system-mcp-grant-group-full")).toHaveText("Included");
  await groupsList.getByRole("switch", { name: "browser-mcp for operators" }).click();
  await expect(groupsList.getByRole("switch", { name: "browser-mcp for operators" })).toBeChecked();
  const peopleList = section.getByRole("list", { name: "Users with access to browser-mcp" });
  await expect(peopleList).toContainText("Included via operators");
  await peopleList.getByRole("switch", { name: "browser-mcp for Alice Operator" }).click();
  await expect(peopleList.getByRole("switch", { name: "browser-mcp for Alice Operator" })).toBeChecked();

  // Settings sheet: the full form, Escape closes it, edits ask before discarding.
  await page.getByTestId("mcp-open-settings").click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.getByRole("button", { name: "Close" })).toBeFocused();
  await expect(settings.getByLabel("Name")).toHaveValue("browser-mcp");
  await expect(settings).not.toContainText(bannedWords);
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(page.getByTestId("mcp-open-settings")).toBeFocused();
  await page.getByTestId("mcp-open-settings").click();
  await settings.getByLabel("Name").fill("browser-mcp renamed");
  await page.keyboard.press("Escape");
  const discard = page.getByTestId("mcp-settings-discard");
  await expect(discard).toContainText("Discard unsaved changes?");
  await discard.getByRole("button", { name: "Discard changes" }).click();
  await expect(settings).toHaveCount(0);
  await expect(page.getByTestId("admin-topbar-title")).toContainText("browser-mcp");

  // ⋯ menu: Check for update, Earlier configurations (rebuild a missing build), Disable/Enable, Delete.
  const menu = page.getByRole("button", { name: "More actions for browser-mcp" });
  await menu.click();
  await page.getByRole("menuitem", { name: "Check for update" }).click();
  await expect(page.getByTestId("admin-feedback")).toContainText("Update check finished");
  await expect(section.getByTestId("mcp-server-page-status")).toContainText("Update ready");

  await menu.click();
  await page.getByRole("menuitem", { name: "Earlier configurations" }).click();
  const configurations = page.getByRole("dialog", { name: "Earlier configurations" });
  await expect(configurations).not.toContainText(bannedWords);
  const missingConfiguration = configurations.getByTestId("mcp-configuration-missing-revision");
  await expect(missingConfiguration.getByTestId("mcp-configuration-build")).toHaveText("Needs rebuild");
  await expect(missingConfiguration.getByRole("button", { name: "Restore" })).toHaveCount(0);
  await missingConfiguration.getByRole("button", { name: "Rebuild and apply" }).click();
  await expect(configurations).toHaveCount(0);
  await expect(page.getByTestId("admin-feedback")).toContainText("Configuration rebuilt and applied.");

  await menu.click();
  await page.getByRole("menuitem", { name: "Disable" }).click();
  await expect(section.getByTestId("mcp-server-page-status")).toContainText("Disabled");
  await menu.click();
  await page.getByRole("menuitem", { name: "Enable" }).click();
  await expect(section.getByTestId("mcp-server-page-status")).toContainText("Working");

  await page.setViewportSize({ height: 900, width: 768 });
  await menu.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirmation = page.getByTestId("admin-confirm-delete-mcp-server");
  await expect(confirmation).toContainText("Delete “browser-mcp”?");
  await confirmation.getByRole("button", { name: "Delete server" }).click();
  await expect(page.getByTestId("admin-feedback")).toContainText("MCP server deleted.");
  await expect(page).not.toHaveURL(/resource=/u);
  await expect(list).toBeVisible();
  await expect(section.getByTestId("mcp-server-row-browser-mcp")).toHaveCount(0);

  expect(requests).toEqual(expect.arrayContaining([
    expect.objectContaining({
      body: expect.objectContaining({ activate: true }),
      method: "POST",
      path: "/api/admin/mcp"
    }),
    expect.objectContaining({
      body: expect.objectContaining({ tool: { enabled: false, name: "fixture_write" } }),
      method: "PATCH",
      path: "/api/admin/mcp/browser-mcp"
    }),
    expect.objectContaining({
      body: expect.objectContaining({ draft: expect.objectContaining({ disabledToolNames: ["fixture_write"] }), publish: true }),
      method: "POST",
      path: "/api/admin/mcp/browser-mcp/test"
    }),
    expect.objectContaining({ body: { canUse: true, groupId: "group-operators" }, method: "PUT", path: "/api/admin/mcp/browser-mcp/grants" }),
    expect.objectContaining({ body: { canUse: true, personalSlotKeys: [], userId: "user-alice" }, method: "PUT", path: "/api/admin/mcp/browser-mcp/grants" }),
    expect.objectContaining({ method: "POST", path: "/api/admin/mcp/browser-mcp/check-update" }),
    expect.objectContaining({
      body: expect.objectContaining({ replaceDraft: true, revisionId: "missing-revision" }),
      method: "POST",
      path: "/api/admin/mcp/browser-mcp/rebuild"
    }),
    expect.objectContaining({ body: { enabled: false }, method: "PATCH", path: "/api/admin/mcp/browser-mcp" }),
    expect.objectContaining({ body: { enabled: true }, method: "PATCH", path: "/api/admin/mcp/browser-mcp" }),
    expect.objectContaining({ method: "DELETE", path: "/api/admin/mcp/browser-mcp" })
  ]));
  expect(requests.filter((request) => request.path === "/api/admin/mcp/browser-mcp/activate")).toEqual([]);
  const saves = requests.filter((request) => request.path.endsWith("/test"));
  expect(saves).toHaveLength(2);
  expect(saves.every((request) => request.body?.publish === true)).toBe(true);
  expect(requests.filter((request) => request.method === "PATCH").every((request) => !request.body?.sharedValues)).toBe(true);
  expect(JSON.stringify(servers)).not.toContain("browser-write-only-secret");
});

test("MCP list exposes authorization and runtime problems without opening each server", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/iu.test(message.text())) hydrationErrors.push(message.text());
  });
  const oauth: AdminMcpServer = {
    ...existingServer(), id: "oauth-tools", name: "Workspace tools",
    draft: { ...existingServer().draft, auth: { mode: "oauth", scopes: [], allowedAuthorizationServerOrigins: ["https://auth.example.test"] } },
    validationOAuth: { state: "reauthorization_required", accountLabel: "Admin", connectedAt: fixedTime }
  };
  const unavailable: AdminMcpServer = { ...existingServer(), runtimeProblem: "unavailable" };
  await page.route("**/api/admin", (route) => route.fulfill({ json: adminDashboard() }));
  await page.route("**/api/admin/mcp", (route) => route.fulfill({ json: { servers: [oauth, unavailable] } }));
  await signInWithLocalToken(page);
  const section = await openMcpServers(page);
  for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    const row = section.getByTestId("mcp-server-row-oauth-tools");
    await expect(row.getByTestId("mcp-server-status")).toHaveText("Setup needed");
    await expect(row).toContainText("Reconnect to check changes");
    const reconnect = row.getByRole("link", { name: "Reconnect Workspace tools" });
    await expect(reconnect).toHaveAttribute("href", "/api/admin/mcp/oauth-tools/oauth/validation/reconnect");
    await expectTouchSafe(reconnect);
    const failing = section.getByTestId("mcp-server-row-existing-server");
    await expect(failing.getByTestId("mcp-server-status")).toHaveText("Runtime unavailable");
    await expect(failing).toContainText("MCP runtime unavailable");
    await expectNoHorizontalOverflow(page);
  }

  // The OAuth return lands on the server page with one banner and leaves no callback parameters behind.
  await page.goto("/admin?section=mcp&oauth=connected&server=oauth-tools");
  await expect(page).toHaveURL(/section=mcp&resource=oauth-tools/u);
  await expect(page).not.toHaveURL(/oauth=|server=/u);
  await expect(section.getByTestId("admin-mcp-oauth-return")).toContainText("Your account is connected");
  await expect(section.getByTestId("mcp-authorization-state")).toHaveText("Reconnect needed");
  await expect(section.getByRole("link", { name: "Reconnect" })).toHaveAttribute("href", "/api/admin/mcp/oauth-tools/oauth/validation/reconnect");
  await expect(section).not.toContainText(bannedWords);
  expect(hydrationErrors).toEqual([]);
});
