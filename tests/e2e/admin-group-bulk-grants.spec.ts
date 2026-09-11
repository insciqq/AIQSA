import { expect, test } from "@playwright/test";
import type { AdminActionRequest, AdminDashboard } from "../../lib/contracts/admin";
import type { AdminMcpServer } from "../../lib/contracts/mcp";
import { authenticateWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

const groupId = "synthetic-new-group";
const groupName = "Research and development";

function dashboardFixture(): AdminDashboard {
  return {
    accessRules: [],
    catalog: {
      models: [
        { displayName: "Alpha model", modelId: "alpha", provider: "provider-a" },
        { displayName: "Beta model", modelId: "beta", provider: "provider-b" }
      ],
      providers: [{ id: "provider-a", name: "Provider A" }, { id: "provider-b", name: "Provider B" }],
      searchStrategies: [{ displayName: "First Search", strategyId: "search-a" }, { displayName: "Second Search", strategyId: "search-b" }]
    },
    groups: [],
    invites: [],
    navigation: { advancedConfigured: true, attention: { activeUsersWithoutModelAccess: 0, openInvites: 0, pendingUsers: 0 }, teamConfigured: false },
    usage: {
      byGroup: [], byUser: [],
      totals: { incompleteUsageCount: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, inputTokens: 0, lastUsedAt: null, outputTokens: 0, reasoningTokens: 0, runCount: 0, totalTokens: 0 }
    },
    users: []
  };
}

function serverFixture(index: number): AdminMcpServer {
  return {
    activePersonalSlots: [], activeRevision: null, activation: null, archivedAt: null, description: "Synthetic tools",
    draft: {
      auth: { mode: "none" }, runtime: { callTimeoutMs: 60000, startupTimeoutMs: 60000 }, slots: [],
      source: { kind: "remote", url: "https://synthetic.example.test/mcp" }, transport: "streamable_http"
    },
    draftTest: null, draftTested: false, enabled: true, grants: [],
    id: `synthetic-server-${index}`, name: `Server ${index}`, namespace: `server_${index}`,
    revisions: [], sharedValues: {}, updatedAt: "2026-09-09T10:00:00Z", validationOAuth: null
  };
}

for (const theme of ["light", "dark"] as const) {
  test(`a newly created group grants and clears all current sections at every viewport (${theme})`, async ({ page }) => {
    await authenticateWithLocalToken(page.request);
    await page.emulateMedia({ colorScheme: theme });
    const dashboard = dashboardFixture();
    const servers = Array.from({ length: 10 }, (_, index) => serverFixture(index));
    const grantRequests: string[] = [];
    await page.route("**/api/admin", (route) => route.fulfill({ json: dashboard }));
    await page.route("**/api/admin/providers", (route) => route.fulfill({ json: { connections: [] } }));
    await page.route("**/api/admin/mcp", (route) => route.fulfill({ json: { servers } }));
    await page.route("**/api/admin/action", async (route) => {
      const body = route.request().postDataJSON() as AdminActionRequest;
      if (body.action === "create_group") {
        const group = { accessGrants: [], archivedAt: null, id: groupId, name: body.name, systemRole: null, userCount: 0 };
        dashboard.groups.push(group);
        return route.fulfill({ json: { group, ok: true } });
      }
      if (body.action !== "set_group_grants" || body.groupId !== groupId) {
        return route.fulfill({ status: 400, json: { error: "action_unknown" } });
      }
      expect(body.changes.length).toBeLessThanOrEqual(200);
      const group = dashboard.groups[0];
      for (const change of body.changes) {
        group.accessGrants = group.accessGrants.filter((grant) => (grant.provider ?? null) !== (change.provider ?? null) ||
          (grant.modelId ?? null) !== (change.modelId ?? null) || (grant.searchStrategy ?? null) !== (change.searchStrategy ?? null));
        if (change.enabled) group.accessGrants.push({
          enabled: true, groupId, id: `grant-${change.provider ?? "search"}-${change.modelId ?? change.searchStrategy ?? "all"}`,
          modelId: change.modelId ?? null, provider: change.provider ?? null, searchStrategy: change.searchStrategy ?? null, userId: null
        });
      }
      return route.fulfill({ json: { ok: true } });
    });
    await page.route("**/api/admin/mcp/*/grants", async (route) => {
      const serverId = new URL(route.request().url()).pathname.split("/").at(-2);
      const server = servers.find((entry) => entry.id === serverId);
      const body = route.request().postDataJSON() as { canUse: boolean; groupId: string; personalSlotKeys?: string[] };
      expect(body.groupId).toBe(groupId);
      expect(body.personalSlotKeys).toBeUndefined();
      expect(server).toBeDefined();
      grantRequests.push(server!.id);
      server!.grants = body.canUse ? [{ canUse: true, groupId, groupName, id: `grant-${server!.id}`, personalSlotKeys: [], userId: null, userName: null }] : [];
      await route.fulfill({ json: { server } });
    });
    await page.goto("/admin?section=groups");
    await page.getByRole("button", { name: "New group", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "New group" });
    await sheet.getByLabel("Group name").fill(groupName);
    await sheet.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`resource=${groupId}`));
    const detail = page.getByTestId("admin-group-page");
    await expect(detail).toBeVisible();

    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 900, height: 420 }]) {
      await page.setViewportSize(viewport);
      const sections = [
        { label: "models", testId: "admin-group-models", total: 2 },
        { label: "Search sources", testId: "admin-group-search", total: 2 },
        { label: "MCP servers", testId: "admin-group-mcp", total: 10 }
      ];
      for (const section of sections) {
        const panel = detail.getByTestId(section.testId);
        await expect(panel.getByText(`0 of ${section.total} ${section.label} granted · None`)).toBeVisible();
        const grant = panel.getByRole("button", { name: `Grant all current ${section.label} to ${groupName}`, exact: true });
        await grant.scrollIntoViewIfNeeded();
        await expectWithinViewport(page, grant);
        await expectNoHorizontalOverflow(page);
        await grant.focus();
        await page.keyboard.press("Enter");
        await expect(panel.getByText(`${section.total} of ${section.total} ${section.label} granted · All`)).toBeVisible();
        await expect(grant).toBeDisabled();
      }
      expect(new Set(grantRequests).size).toBe(10);
      await page.reload();
      await expect(detail).toBeVisible();
      const mcp = detail.getByTestId("admin-group-mcp");
      await expect(mcp.getByRole("switch")).toHaveCount(8);
      await mcp.getByRole("button", { name: "2 more", exact: true }).click();
      await expect(mcp.getByRole("switch")).toHaveCount(10);
      for (const toggle of await mcp.getByRole("switch").all()) await expect(toggle).toHaveAttribute("aria-checked", "true");
      for (const section of sections) {
        const panel = detail.getByTestId(section.testId);
        const clear = panel.getByRole("button", { name: `Clear current ${section.label} for ${groupName}`, exact: true });
        await clear.scrollIntoViewIfNeeded();
        await expectWithinViewport(page, clear);
        await clear.focus();
        await page.keyboard.press("Space");
        await expect(panel.getByText(`0 of ${section.total} ${section.label} granted · None`)).toBeVisible();
      }
      await expectNoHorizontalOverflow(page);
      expect(dashboard.groups[0].accessGrants).toEqual([]);
      expect(servers.every((server) => server.grants.length === 0)).toBe(true);
    }
    expect(grantRequests).toHaveLength(60);
  });
}
