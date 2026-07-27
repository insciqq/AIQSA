import { expect, test, type Page } from "@playwright/test";
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

const fixedTime = "2026-07-26T08:00:00.000Z";

function emptyAdminDashboard(): AdminDashboard {
  return {
    accessRules: [],
    catalog: { models: [], providers: [], searchStrategies: [] },
    groups: [],
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
    users: []
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
    description: "Existing server used to prove compact catalog search state.",
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
  const section = page.getByTestId("admin-section-mcp");
  if (await section.isVisible().catch(() => false)) return section;

  const allSections = page.getByRole("button", { name: "All sections" });
  if (await allSections.isVisible().catch(() => false)) {
    await allSections.click();
    await expect(page.getByTestId("admin-section-index-pane")).toBeVisible();
  }

  let tab = page.getByRole("tab", { exact: true, name: "MCP servers" });
  if ((await tab.count()) === 0) {
    await page.getByRole("button", { exact: true, name: "Advanced" }).click();
    tab = page.getByRole("tab", { exact: true, name: "MCP servers" });
  }
  await tab.click();
  await expect(section).toBeVisible();
  return section;
}

test("admin MCP task workspace preserves compact context and drives the tested revision lifecycle", async ({ page }) => {
  test.setTimeout(60_000);
  let servers: AdminMcpServer[] = [existingServer()];
  const requests: Array<{
    body: Record<string, unknown> | null;
    method: string;
    path: string;
  }> = [];

  await page.route("**/api/admin", async (route) => {
    await route.fulfill({ contentType: "application/json", json: emptyAdminDashboard() });
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
      const tested = replace({
        ...current,
        draftTest: testedDraft("tested-identity"),
        draftTested: true
      });
      await route.fulfill({ contentType: "application/json", json: { server: tested } });
      return;
    }

    if (method === "POST" && path.endsWith("/activate")) {
      const active = revision("active-revision", 2, current.draftTest?.identityHash ?? "tested-identity", "available");
      const missing = revision("missing-revision", 1, "missing-identity", "missing");
      const activated = replace({
        ...current,
        activeRevision: active,
        enabled: true,
        revisions: [active, missing]
      });
      await route.fulfill({ contentType: "application/json", json: { server: activated } });
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

    if (method === "PATCH" && path === `/api/admin/mcp/${encodeURIComponent(serverId)}`) {
      const update = body as AdminMcpUpdateRequest;
      const updated = replace({
        ...current,
        ...(typeof update.enabled === "boolean" ? { enabled: update.enabled } : {}),
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
  await page.goto("/admin");
  const section = await openMcpServers(page);

  await expect(section.getByTestId("mcp-catalog-view")).toBeVisible();
  await expect(section.getByTestId("mcp-detail-view")).toBeVisible();
  await expectNoHorizontalOverflow(page);

  await page.setViewportSize({ height: 900, width: 768 });
  await expectNoHorizontalOverflow(page);
  const search = section.getByRole("searchbox", { name: "Search MCP servers" });
  await search.fill("Existing Search");
  await section.getByRole("listitem").filter({ hasText: "Existing Search Server" }).click();
  await expect(section.getByTestId("mcp-server-task-index")).toBeVisible();
  await section.getByRole("button", { name: "Back to MCP servers" }).click();
  await expect(search).toHaveValue("Existing Search");
  await search.fill("");

  await section.getByRole("button", { name: "New server" }).click();
  const importEditor = section.getByLabel("Configuration JSON, URL, or install command");
  const normalizeImport = section.getByRole("button", { name: "Parse" });
  expect((await importEditor.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(280);

  await page.setViewportSize({ height: 844, width: 390 });
  await expectNoHorizontalOverflow(page);
  await importEditor.scrollIntoViewIfNeeded();
  expect((await importEditor.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(280);
  await expectTouchSafe(normalizeImport);

  await page.setViewportSize({ height: 390, width: 844 });
  await expectNoHorizontalOverflow(page);
  await importEditor.scrollIntoViewIfNeeded();
  expect((await importEditor.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(150);
  await normalizeImport.scrollIntoViewIfNeeded();
  await expectTouchSafe(normalizeImport);

  await page.setViewportSize({ height: 900, width: 768 });
  await importEditor.fill(`{
  "mcpServers": {
    "browser-mcp": {
      "args": ["-y", "@example/mcp@1.0.0",],
      "command": "npx",
      "env": { "API_KEY": "browser-write-only-secret", },
    },
  },
}`);
  await normalizeImport.click();
  await expect(section.getByLabel("Display name")).toHaveValue("browser-mcp");
  await expect(section.getByLabel("Display name")).toBeFocused();
  await expect(section.getByLabel("Source")).toHaveValue("npm");
  const importedSecret = section.getByLabel("New shared value for API_KEY");
  await expect(importedSecret).toHaveAttribute("type", "password");
  await expect(importedSecret).toHaveValue("browser-write-only-secret");

  await page.setViewportSize({ height: 900, width: 1440 });
  await expectNoHorizontalOverflow(page);
  await section.getByRole("button", { name: "Activate" }).click();
  await expect(section.getByText(/activation started/u)).toBeVisible();
  await expect(section.getByTestId("admin-mcp-activation-progress")).toContainText("Starting");

  await page.setViewportSize({ height: 844, width: 390 });
  await expectNoHorizontalOverflow(page);
  const overviewTask = section.getByRole("button", { name: /Overview Publication and trust/u });
  await expectTouchSafe(overviewTask);
  await overviewTask.click();
  await expect(section.getByTestId("mcp-server-task-detail")).toBeVisible();

  await page.setViewportSize({ height: 390, width: 844 });
  await expectNoHorizontalOverflow(page);
  const backToServerTasks = section.getByRole("button", { name: "Back to server tasks" });
  await backToServerTasks.scrollIntoViewIfNeeded();
  await backToServerTasks.click();
  await expect(section.getByTestId("mcp-server-task-index")).toBeVisible();
  await expectTouchSafe(section.getByRole("button", { name: /Validate & tools/u }));

  await page.setViewportSize({ height: 900, width: 1440 });
  await expectNoHorizontalOverflow(page);
  await section.getByRole("button", { name: /Validate & tools/u }).click();
  await section.getByRole("button", { name: /Overview Publication and trust/u }).click();
  await expect(section.getByText("Active revision tested")).toBeVisible();
  await expect(section.getByRole("button", { name: "Activate tested revision" })).toHaveCount(0);

  await section.getByRole("button", { name: /Revisions Rollback and rebuild/u }).click();
  const missingRevision = section.getByRole("heading", { name: "Revision 1" }).locator("xpath=ancestor::section[1]");
  await expect(missingRevision.getByText("Artifact missing")).toBeVisible();
  await missingRevision.getByRole("button", { name: "Rebuild" }).click();
  await missingRevision.getByRole("button", { name: /Replace draft, rebuild, and activate/u }).click();
  await expect(section.getByText(/newly materialized MCP revision activated/u)).toBeVisible();

  await section.getByRole("button", { name: /Runtime Availability to users/u }).click();
  const runtimeDetail = section.getByTestId("mcp-server-task-detail");
  await expect(runtimeDetail.locator('[data-resource-availability="enabled"]')).toHaveText("Enabled");
  await section.getByRole("button", { name: "Disable" }).click();
  await expect(runtimeDetail.locator('[data-resource-availability="disabled"]')).toHaveText("Disabled");
  await section.getByRole("button", { name: "Enable" }).click();
  await expect(runtimeDetail.locator('[data-resource-availability="enabled"]')).toHaveText("Enabled");

  await section.getByRole("button", { name: /Delete Irreversible removal/u }).click();
  await section.getByRole("button", { name: "Delete…" }).click();
  await section.getByRole("button", { name: "Delete server" }).click();
  await expect(section.getByText("MCP server deleted.")).toBeVisible();
  await expect(section.getByRole("listitem").filter({ hasText: "browser-mcp" })).toHaveCount(0);

  expect(requests).toEqual(expect.arrayContaining([
    expect.objectContaining({
      body: expect.objectContaining({ activate: true }),
      method: "POST",
      path: "/api/admin/mcp"
    }),
    expect.objectContaining({
      body: expect.objectContaining({ replaceDraft: true, revisionId: "missing-revision" }),
      method: "POST",
      path: "/api/admin/mcp/browser-mcp/rebuild"
    }),
    expect.objectContaining({ body: { enabled: false }, method: "PATCH", path: "/api/admin/mcp/browser-mcp" }),
    expect.objectContaining({ body: { enabled: true }, method: "PATCH", path: "/api/admin/mcp/browser-mcp" }),
    expect.objectContaining({ method: "DELETE", path: "/api/admin/mcp/browser-mcp" })
  ]));
  expect(requests.filter((request) => [
    "/api/admin/mcp/browser-mcp/check-update",
    "/api/admin/mcp/browser-mcp/test",
    "/api/admin/mcp/browser-mcp/activate"
  ].includes(request.path))).toEqual([]);
  expect(JSON.stringify(servers)).not.toContain("browser-write-only-secret");
});
