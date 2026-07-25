import { expect, test, type Page } from "@playwright/test";
import type { McpErrorResponse, UserMcpCatalogResponse } from "../../lib/contracts/mcp";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import {
  LOCAL_MCP_MEMBER,
  LOCAL_PRIVATE_MCP_FIXTURE,
  LOCAL_RESTRICTED_MEMBER,
  LOCAL_SHARED_MCP_FIXTURE
} from "../../prisma/local-seed-fixtures";

type OrdinaryFixture = typeof LOCAL_MCP_MEMBER | typeof LOCAL_RESTRICTED_MEMBER;

async function signIn(page: Page, fixture: OrdinaryFixture): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(fixture.email);
  await page.getByLabel("Password", { exact: true }).fill(fixture.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

async function userMcpCatalog(page: Page): Promise<UserMcpCatalogResponse> {
  const response = await page.request.get("/api/me/mcp");
  expect(response.status()).toBe(200);
  return response.json() as Promise<UserMcpCatalogResponse>;
}

test.describe("seeded ordinary-user MCP access", () => {
  test("MCP Member can write only its exact direct slot and cannot reach admin operations", async ({ page }) => {
    await signIn(page, LOCAL_MCP_MEMBER);

    const resetFixturePreference = await page.request.patch(`/api/me/mcp/${LOCAL_SHARED_MCP_FIXTURE.id}`, {
      data: { enabled: false, values: { workspace: null } }
    });
    expect(resetFixturePreference.status()).toBe(200);

    const [adminCatalog, adminDefinition, adminGrant] = await Promise.all([
      page.request.get("/api/admin/mcp"),
      page.request.patch(`/api/admin/mcp/${LOCAL_SHARED_MCP_FIXTURE.id}`, {
        data: {
          draft: {
            slots: [{ target: { kind: "header", name: "X-Attacker-Override" } }],
            source: { kind: "remote", url: "https://attacker.example.test/mcp" }
          },
          name: "Forbidden rename"
        }
      }),
      page.request.put(`/api/admin/mcp/${LOCAL_SHARED_MCP_FIXTURE.id}/grants`, {
        data: { canUse: true, personalSlotKeys: [], userId: LOCAL_MCP_MEMBER.id }
      })
    ]);
    for (const response of [adminCatalog, adminDefinition, adminGrant]) {
      expect(response.status()).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    }

    const catalog = await userMcpCatalog(page);
    expect(catalog.servers.map((server) => server.id)).toEqual([
      LOCAL_PRIVATE_MCP_FIXTURE.id,
      LOCAL_SHARED_MCP_FIXTURE.id
    ]);
    const shared = catalog.servers.find((server) => server.id === LOCAL_SHARED_MCP_FIXTURE.id)!;
    expect(shared.fields).toEqual([
      expect.objectContaining({ configured: false, slotKey: "workspace", source: "missing" })
    ]);

    const overbroad = await page.request.patch(`/api/me/mcp/${LOCAL_SHARED_MCP_FIXTURE.id}`, {
      data: {
        values: {
          endpoint: "https://attacker.example.test/mcp",
          workspace: "member-workspace"
        }
      }
    });
    expect(overbroad.status()).toBe(400);
    await expect(overbroad.json() as Promise<McpErrorResponse>).resolves.toMatchObject({
      error: "invalid_mcp_values",
      issues: [{ code: "slot_not_permitted", path: "values.endpoint" }]
    });

    const exact = await page.request.patch(`/api/me/mcp/${LOCAL_SHARED_MCP_FIXTURE.id}`, {
      data: { values: { workspace: "member-workspace" } }
    });
    expect(exact.status()).toBe(200);
    await expect(exact.json()).resolves.toMatchObject({
      server: {
        enabled: false,
        fields: [{ configured: true, slotKey: "workspace", source: "personal", value: "member-workspace" }]
      }
    });

    const enabled = await page.request.patch(`/api/me/mcp/${LOCAL_SHARED_MCP_FIXTURE.id}`, {
      data: { enabled: true }
    });
    expect(enabled.status()).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({ server: { enabled: true } });
    const disabled = await page.request.patch(`/api/me/mcp/${LOCAL_SHARED_MCP_FIXTURE.id}`, {
      data: { enabled: false }
    });
    expect(disabled.status()).toBe(200);

    await page.goto("/?settings=mcp");
    const settings = page.getByTestId("settings-dialog");
    await expect(settings.getByRole("heading", { name: LOCAL_SHARED_MCP_FIXTURE.displayName })).toBeVisible();
    await expect(settings.getByRole("heading", { name: LOCAL_PRIVATE_MCP_FIXTURE.displayName })).toBeVisible();
    await expect(settings.getByLabel("Fixture workspace")).toHaveValue("member-workspace");

    await page.goto("/admin");
    await expect(page.getByTestId("admin-denied")).toContainText("Admin access required");
  });

  test("Restricted Member sees only the group server and receives no personal-field authority", async ({ page }) => {
    await signIn(page, LOCAL_RESTRICTED_MEMBER);

    const catalog = await userMcpCatalog(page);
    expect(catalog.servers).toHaveLength(1);
    expect(catalog.servers[0]).toMatchObject({
      fields: [],
      id: LOCAL_SHARED_MCP_FIXTURE.id,
      name: LOCAL_SHARED_MCP_FIXTURE.displayName
    });
    expect(JSON.stringify(catalog)).not.toContain("member-workspace");

    const personalWrite = await page.request.patch(`/api/me/mcp/${LOCAL_SHARED_MCP_FIXTURE.id}`, {
      data: { values: { workspace: "restricted-workspace" } }
    });
    expect(personalWrite.status()).toBe(400);
    await expect(personalWrite.json() as Promise<McpErrorResponse>).resolves.toMatchObject({
      error: "invalid_mcp_values",
      issues: [{ code: "slot_not_permitted", path: "values.workspace" }]
    });

    const ungrantedWrite = await page.request.patch(`/api/me/mcp/${LOCAL_PRIVATE_MCP_FIXTURE.id}`, {
      data: { enabled: true }
    });
    expect(ungrantedWrite.status()).toBe(404);
    await expect(ungrantedWrite.json()).resolves.toEqual({ error: "mcp_not_found" });

    const groupOnlyEnable = await page.request.patch(`/api/me/mcp/${LOCAL_SHARED_MCP_FIXTURE.id}`, {
      data: { enabled: true }
    });
    expect(groupOnlyEnable.status()).toBe(400);
    await expect(groupOnlyEnable.json() as Promise<McpErrorResponse>).resolves.toMatchObject({
      error: "invalid_mcp_values",
      issues: [{ code: "slot_value_required", path: "values.workspace" }]
    });

    const modelCatalog = await page.request.get("/api/me/catalog");
    expect(modelCatalog.status()).toBe(200);
    await expect(modelCatalog.json()).resolves.toMatchObject({
      catalog: {
        models: [
          expect.objectContaining({
            modelId: providerTemplateIds.fakeModel,
            upstreamModelId: "fake-qsa"
          })
        ]
      }
    });

    await page.goto("/?settings=mcp");
    const settings = page.getByTestId("settings-dialog");
    await expect(settings.getByRole("heading", { name: LOCAL_SHARED_MCP_FIXTURE.displayName })).toBeVisible();
    await expect(settings.getByRole("heading", { name: LOCAL_PRIVATE_MCP_FIXTURE.displayName })).toHaveCount(0);
    await expect(settings.getByText("Personal configuration")).toHaveCount(0);
    await settings.getByRole("button", { name: `Enable ${LOCAL_SHARED_MCP_FIXTURE.displayName}` }).click();
    await expect(settings.getByRole("alert")).toContainText(
      "This server needs additional administrator configuration before it can be enabled."
    );

    await page.goto("/admin");
    await expect(page.getByTestId("admin-denied")).toContainText("Admin access required");
  });
});
