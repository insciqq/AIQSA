import { randomUUID } from "node:crypto";
import type { AuthSignInMethodSetting, AuthSignInPolicy, PrismaClient } from "@prisma/client";
import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
  type TestInfo
} from "@playwright/test";
import { LOCAL_PRIVATE_MCP_DRAFT } from "../../../prisma/local-seed-fixtures";
import type { AuthSignInMethod } from "../../../lib/contracts/authSignInMethods";
import { SESSION_COOKIE_NAME } from "../../../lib/server/auth/constants";
import { authenticateWithLocalToken } from "./localAuth";

/**
 * Shared steps of the opt-in real-IdP specs (`tests/e2e/auth-real-*.spec.ts`). They run only on
 * the disposable stand `tests/auth-idp/stand.mjs` starts, with AIQSA_AUTH_IDP_E2E=DISPOSABLE and
 * the stand's AIQSA_E2E_* variables. Values from the environment are passwords and secrets of
 * that stand: they are typed into forms and sent to admin APIs, never printed, attached or
 * asserted by value (a failing value assertion would print them).
 */

export const realIdpEnabled = process.env.AIQSA_AUTH_IDP_E2E === "DISPOSABLE";
export const REAL_IDP_SKIP_REASON = "needs AIQSA_AUTH_IDP_E2E=DISPOSABLE and the real-IdP stand (tests/auth-idp)";

/** `trusted`: the app runs in trusted-proxy client identity mode behind the stand's header proxy. */
export const standMode: "direct" | "trusted" = process.env.AIQSA_E2E_STAND_MODE === "trusted" ? "trusted" : "direct";

/**
 * In trusted-proxy mode the app identifies clients by the proxy's forwarded address, so every
 * request that does not pass the stand's proxy carries one, as `auth-trusted-header.spec.ts` does.
 */
export const FORWARDED: Readonly<Record<string, string>> = standMode === "trusted" ? { "X-Forwarded-For": "203.0.113.20" } : {};

const POLICY_ID = "installation";

/** A stand variable; a missing one fails with its name only. */
export function standEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`stand_env_missing:${name}`);
  return value;
}

export function standEnvPresent(...names: string[]): boolean {
  return names.every((name) => Boolean(process.env[name]?.trim()));
}

export type Evidence = Record<string, boolean | number | string>;

/** Attaches content-free evidence: counts, booleans and stable codes, never emails or claims. */
export async function attachEvidence(testInfo: TestInfo, name: string, evidence: Evidence): Promise<void> {
  for (const [key, value] of Object.entries(evidence)) {
    if (typeof value === "string" && !/^[a-z0-9_.:-]{0,64}$/u.test(value)) throw new Error(`evidence_not_content_free:${key}`);
  }
  await testInfo.attach(`${name}.json`, { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
}

/** A browser context of the stand: English, reduced motion, the forwarded address in trusted mode. */
export async function standContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  return browser.newContext({
    locale: "en-US",
    reducedMotion: "reduce",
    ...options,
    extraHTTPHeaders: { ...FORWARDED, ...(options.extraHTTPHeaders ?? {}) }
  });
}

export async function hasSessionCookie(context: BrowserContext): Promise<boolean> {
  return (await context.cookies()).some((cookie) => cookie.name === SESSION_COOKIE_NAME);
}

/**
 * The bootstrap administrator in a new context, without passing `/login`: an active
 * auto-redirect or trusted-header method would leave the login page at once.
 */
export async function adminSession(browser: Browser, options: BrowserContextOptions = {}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await standContext(browser, options);
  await authenticateWithLocalToken(context.request);
  return { context, page: await context.newPage() };
}

export async function openSignInSection(page: Page): Promise<Locator> {
  await page.goto("/admin?section=sign-in");
  await expect(page.getByTestId("admin-topbar-title")).toHaveText("Sign-in", { timeout: 60_000 });
  const section = page.getByTestId("admin-sign-in-section");
  await expect(section.getByTestId("admin-sign-in-policy")).toBeVisible({ timeout: 30_000 });
  return section;
}

export async function openSignInCard(page: Page, method: AuthSignInMethod): Promise<Locator> {
  const section = await openSignInSection(page);
  const card = section.getByTestId(`admin-sign-in-card-${method}`);
  await expect(card).toBeVisible();
  return card;
}

/**
 * Save → Test → Activate on a method card. `secretField` names a write-only field the save
 * clears: it is polled as a boolean so a failure never prints the value; the first save also
 * waits for the route to compile on a fresh dev server.
 */
export async function saveTestActivate(
  page: Page,
  card: Locator,
  options: Readonly<{ secretField?: string; testPassed?: RegExp | string }> = {}
): Promise<void> {
  await card.getByRole("button", { name: "Save" }).click();
  if (options.secretField) {
    await expect.poll(async () => (await card.getByLabel(options.secretField!).inputValue()) === "", { timeout: 60_000 }).toBe(true);
  }
  await expect(card.getByText("The saved settings are not active yet.")).toBeVisible({ timeout: 60_000 });
  const testButton = card.getByRole("button", { name: "Test", exact: true });
  if (await testButton.count()) {
    await testButton.click();
    await expect(card.getByTestId("admin-sign-in-test")).toContainText(options.testPassed ?? "Test passed", { timeout: 60_000 });
  }
  await card.getByRole("button", { name: "Activate" }).click();
  // Identities a previous configuration left on this stand belong to another source.
  const status = card.getByTestId("admin-sign-in-status");
  const sourceChange = page.getByTestId("admin-confirm-sign-in-source-change");
  await expect(status.filter({ hasText: "Active (admin)" }).or(sourceChange)).toBeVisible({ timeout: 30_000 });
  if (await sourceChange.isVisible()) await sourceChange.getByRole("button", { name: "Activate anyway" }).click();
  await expect(status).toHaveText("Active (admin)");
}

type MethodState = {
  active: { config: Record<string, unknown> | null; version: number };
  draft: { config: Record<string, unknown> | null; version: number };
  method: AuthSignInMethod;
  requiresTest: boolean;
  status: "active_admin" | "active_environment" | "off";
};

type Overview = { methods: MethodState[]; policy: { passwordLoginEnabled: boolean; registrationEnabled: boolean; version: number } };

export async function signInOverview(request: APIRequestContext): Promise<Overview> {
  const response = await request.get("/api/admin/sign-in");
  expect(response.ok(), `admin sign-in overview (${response.status()})`).toBe(true);
  return await response.json() as Overview;
}

export async function signInMethodState(request: APIRequestContext, method: AuthSignInMethod): Promise<MethodState> {
  const state = (await signInOverview(request)).methods.find((entry) => entry.method === method);
  expect(state, `method ${method} in the overview`).toBeTruthy();
  return state!;
}

type SecretAction = { kind: "preserve" } | { kind: "replace"; value: string };

/**
 * Saves a draft through the admin API, tests it when the method has a tester and activates it.
 * Used for reconfiguration between steps; the first configuration of each spec goes through the
 * card. Failures name only the status and the content-free code.
 */
export async function configureMethod(
  request: APIRequestContext,
  method: AuthSignInMethod,
  config: Record<string, unknown>,
  secretActions: Record<string, SecretAction> = {}
): Promise<void> {
  const before = await signInMethodState(request, method);
  const saved = await request.put(`/api/admin/sign-in/methods/${method}`, {
    data: { config, expectedDraftVersion: before.draft.version, secretActions }
  });
  const savedBody = await saved.json() as { error?: string; method?: MethodState };
  expect(saved.ok(), `save ${method} draft: ${saved.status()} ${savedBody.error ?? ""}`).toBe(true);
  let draft = savedBody.method!;
  if (draft.requiresTest) {
    const tested = await request.post(`/api/admin/sign-in/methods/${method}`, {
      data: { action: "test", expectedDraftVersion: draft.draft.version },
      timeout: 60_000
    });
    const testBody = await tested.json() as { error?: string; method?: MethodState; test?: { code: string; passed: boolean } };
    expect(tested.ok() && testBody.test?.passed, `test ${method}: ${tested.status()} ${testBody.error ?? testBody.test?.code ?? ""}`).toBe(true);
    draft = testBody.method!;
  }
  const activated = await request.post(`/api/admin/sign-in/methods/${method}`, {
    data: {
      action: "activate",
      confirmSourceChange: true,
      expectedActiveVersion: draft.active.version,
      expectedDraftVersion: draft.draft.version
    }
  });
  const activatedBody = await activated.json() as { error?: string };
  expect(activated.ok(), `activate ${method}: ${activated.status()} ${activatedBody.error ?? ""}`).toBe(true);
}

/** The active configuration with `patch` applied, saved, tested and activated again. */
export async function reconfigureMethod(
  request: APIRequestContext,
  method: AuthSignInMethod,
  patch: Record<string, unknown>,
  secretFields: readonly string[] = []
): Promise<void> {
  const state = await signInMethodState(request, method);
  expect(state.active.config, `${method} has an active configuration`).toBeTruthy();
  await configureMethod(
    request,
    method,
    { ...state.active.config, ...patch },
    Object.fromEntries(secretFields.map((field) => [field, { kind: "preserve" } as const]))
  );
}

/** Disables an admin-active method through the API: activation and disable drop the settings snapshot. */
export async function disableMethod(request: APIRequestContext, method: AuthSignInMethod): Promise<void> {
  const state = await signInMethodState(request, method);
  if (state.status !== "active_admin") return;
  const response = await request.post(`/api/admin/sign-in/methods/${method}`, {
    data: { action: "disable", expectedActiveVersion: state.active.version }
  });
  expect(response.ok(), `disable ${method} (${response.status()})`).toBe(true);
}

/** Snapshots an installation singleton row; `restore` puts it back exactly. */
export async function snapshotMethod(prisma: PrismaClient, method: AuthSignInMethod): Promise<{ restore(): Promise<void> }> {
  const snapshot: AuthSignInMethodSetting | null = await prisma.authSignInMethodSetting.findUnique({ where: { method } });
  return {
    async restore() {
      await prisma.authSignInMethodSetting.deleteMany({ where: { method } });
      if (snapshot) {
        await prisma.authSignInMethodSetting.create({
          data: { ...snapshot, activeConfig: snapshot.activeConfig ?? undefined, draftConfig: snapshot.draftConfig ?? undefined }
        });
      }
    }
  };
}

export async function snapshotPolicy(prisma: PrismaClient): Promise<{ restore(): Promise<void> }> {
  const snapshot: AuthSignInPolicy | null = await prisma.authSignInPolicy.findUnique({ where: { id: POLICY_ID } });
  return {
    async restore() {
      await prisma.authSignInPolicy.deleteMany({ where: { id: POLICY_ID } });
      if (snapshot) await prisma.authSignInPolicy.create({ data: snapshot });
    }
  };
}

/** A group created through the admin API. */
export async function createGroup(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post("/api/admin/action", { data: { action: "create_group", name } });
  expect(response.ok(), `create group (${response.status()})`).toBe(true);
  return (await response.json() as { group: { id: string } }).group.id;
}

/** Adds an external name on the group page, as an administrator does. */
export async function addExternalNameInUi(page: Page, groupId: string, sourceLabel: string, value: string): Promise<Locator> {
  await page.goto(`/admin?section=groups&resource=${encodeURIComponent(groupId)}`);
  const names = page.getByTestId("admin-group-page").getByTestId("admin-group-external-names");
  const source = names.getByTestId("admin-group-external-source").filter({ hasText: sourceLabel });
  await source.getByLabel(`Add an external name for ${sourceLabel}`).fill(value);
  await source.getByRole("button", { name: "Add" }).click();
  await expect(source.getByTestId("admin-group-external-name").filter({ hasText: value })).toBeVisible();
  return names;
}

export async function addExternalName(request: APIRequestContext, groupId: string, source: string, value: string): Promise<void> {
  const response = await request.post(`/api/admin/sign-in/groups/${encodeURIComponent(groupId)}`, {
    data: { action: "add_external_name", source, value }
  });
  expect(response.ok(), `add external name (${response.status()})`).toBe(true);
}

/** Removes the stand users a spec signed in or created, by account or identity email. */
export async function deleteStandUsers(prisma: PrismaClient, emails: readonly string[]): Promise<void> {
  const users = await prisma.user.findMany({
    select: { id: true },
    where: { OR: [{ email: { in: [...emails] } }, { authIdentities: { some: { normalizedEmail: { in: [...emails] } } } }] }
  });
  const ids = users.map((user) => user.id);
  if (!ids.length) return;
  await prisma.userGroup.deleteMany({ where: { userId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
}

export type SyntheticMcpServer = Readonly<{ revisionId: string; serverId: string }>;

/**
 * An installation MCP server granted to one group with a ready revision, never started: the
 * fixture `groupMembership.prisma.test.ts` uses to observe membership side effects.
 */
export async function syntheticMcpServer(prisma: PrismaClient, label: string, groupId: string): Promise<SyntheticMcpServer> {
  const namespace = `real_idp_${label}_${randomSuffix()}`.replace(/[^a-z0-9_]/gu, "_");
  // A valid stored draft: the admin MCP catalog refuses to list servers whose stored draft fails validation.
  const draft = { ...LOCAL_PRIVATE_MCP_DRAFT, source: { kind: "remote", url: `https://${namespace.replaceAll("_", "-")}.mcp-fixture.invalid/mcp` } };
  const server = await prisma.mcpServer.create({ data: { displayName: `Real IdP ${label}`, draft, enabled: true, namespace } });
  const revision = await prisma.mcpRevision.create({
    data: {
      configuration: draft,
      draftHash: "a".repeat(64),
      identityHash: `real-idp-${label}`,
      revisionNumber: 1,
      serverId: server.id,
      validationEvidence: {}
    }
  });
  await prisma.mcpGrant.create({ data: { canUse: true, groupId, serverId: server.id } });
  return { revisionId: revision.id, serverId: server.id };
}

/** The user's enabled preference for the server with a desired runtime generation, as after use. */
export async function enabledMcpPreference(prisma: PrismaClient, server: SyntheticMcpServer, userId: string): Promise<void> {
  const preference = await prisma.mcpUserServer.create({ data: { enabled: true, serverId: server.serverId, userId } });
  const generation = await prisma.mcpRuntimeGeneration.create({
    data: { fingerprint: randomSuffix(), revisionId: server.revisionId, state: "ready", userServerId: preference.id }
  });
  await prisma.mcpUserServer.update({ data: { desiredRuntimeGenerationId: generation.id }, where: { id: preference.id } });
}

export async function deleteSyntheticMcpServers(prisma: PrismaClient, servers: readonly SyntheticMcpServer[]): Promise<void> {
  const serverIds = servers.map((server) => server.serverId);
  if (!serverIds.length) return;
  await prisma.mcpUserServer.updateMany({ data: { desiredRuntimeGenerationId: null }, where: { serverId: { in: serverIds } } });
  await prisma.mcpRuntimeGeneration.deleteMany({ where: { revision: { serverId: { in: serverIds } } } });
  await prisma.mcpUserServer.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpRevision.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpServer.deleteMany({ where: { id: { in: serverIds } } });
}

export function randomSuffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 8);
}

/** Opens a page of a fresh stand context. */
export async function loginPage(browser: Browser, path = "/login", options: BrowserContextOptions = {}) {
  const context = await standContext(browser, options);
  const page = await context.newPage();
  await page.goto(path);
  return { context, page };
}

export function alert(page: Page): Locator {
  return page.locator("[role=alert]:not(#__next-route-announcer__)");
}

// Keycloak

const keycloakIssuer = () => new URL(standEnv("AIQSA_E2E_KEYCLOAK_ISSUER"));

/** The Keycloak login form: fills the stand user's password, never prints it. */
export async function keycloakSignIn(page: Page, username: string, password: string): Promise<void> {
  const form = page.locator("#kc-form-login");
  await expect(form).toBeVisible({ timeout: 60_000 });
  await form.locator("#username").fill(username);
  await form.locator("#password").fill(password);
  await form.locator("#kc-login").click();
}

/**
 * A stand user signs in through the OIDC button: login page → Keycloak → callback. Returns the
 * context and page after the callback's redirect, whatever it ended in.
 */
export async function oidcSignIn(
  browser: Browser,
  input: Readonly<{ buttonLabel: string; options?: BrowserContextOptions; password: string; username: string }>
): Promise<{ context: BrowserContext; page: Page }> {
  const { context, page } = await loginPage(browser, "/login?local=1", input.options);
  await page.getByRole("link", { name: `Continue with ${input.buttonLabel}` }).click();
  await keycloakSignIn(page, input.username, input.password);
  await page.waitForURL((url) => url.origin !== keycloakIssuer().origin, { timeout: 60_000 });
  return { context, page };
}

type KeycloakRepresentation = Record<string, unknown> & { id: string };

/** Keycloak's admin REST API with the stand's bootstrap administrator. */
export function keycloakAdmin() {
  const issuer = keycloakIssuer();
  const origin = issuer.origin;
  const realm = issuer.pathname.split("/").filter(Boolean).at(-1)!;
  let token: { expiresAt: number; value: string } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 5_000) return token.value;
    const response = await fetch(`${origin}/realms/master/protocol/openid-connect/token`, {
      body: new URLSearchParams({
        client_id: "admin-cli",
        grant_type: "password",
        password: standEnv("AIQSA_E2E_KEYCLOAK_ADMIN_PASSWORD"),
        username: "kcadmin"
      }),
      method: "POST"
    });
    if (!response.ok) throw new Error(`keycloak_admin_token:${response.status}`);
    const body = await response.json() as { access_token: string; expires_in: number };
    token = { expiresAt: Date.now() + body.expires_in * 1_000, value: body.access_token };
    return token.value;
  }

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${origin}/admin/realms/${realm}${path}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        authorization: `Bearer ${await accessToken()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      method
    });
    if (!response.ok) throw new Error(`keycloak_admin:${method}:${path.split("?")[0]!.split("/").slice(1, 3).join("/")}:${response.status}`);
    const text = await response.text();
    return text ? JSON.parse(text) as unknown : null;
  }

  async function userId(username: string): Promise<string> {
    const users = await call("GET", `/users?username=${encodeURIComponent(username)}&exact=true`) as KeycloakRepresentation[];
    if (users.length !== 1) throw new Error("keycloak_user_not_found");
    return users[0]!.id;
  }

  async function groupId(name: string): Promise<string> {
    return (await call("GET", `/group-by-path/${encodeURIComponent(name)}`) as KeycloakRepresentation).id;
  }

  async function realmRole(name: string): Promise<KeycloakRepresentation> {
    return await call("GET", `/roles/${encodeURIComponent(name)}`) as KeycloakRepresentation;
  }

  return {
    async addRealmRole(username: string, role: string) {
      await call("POST", `/users/${await userId(username)}/role-mappings/realm`, [await realmRole(role)]);
    },
    async addToGroup(username: string, group: string) {
      await call("PUT", `/users/${await userId(username)}/groups/${await groupId(group)}`);
    },
    async client(clientId: string): Promise<KeycloakRepresentation> {
      const clients = await call("GET", `/clients?clientId=${encodeURIComponent(clientId)}`) as KeycloakRepresentation[];
      if (clients.length !== 1) throw new Error("keycloak_client_not_found");
      return clients[0]!;
    },
    async groupsOf(username: string): Promise<string[]> {
      const groups = await call("GET", `/users/${await userId(username)}/groups`) as Array<{ path: string }>;
      return groups.map((group) => group.path);
    },
    /** Ends the user's Keycloak sessions, so the next sign-in shows the login form again. */
    async logout(username: string) {
      await call("POST", `/users/${await userId(username)}/logout`);
    },
    async realmRolesOf(username: string): Promise<string[]> {
      const roles = await call("GET", `/users/${await userId(username)}/role-mappings/realm`) as Array<{ name: string }>;
      return roles.map((role) => role.name);
    },
    async removeFromGroup(username: string, group: string) {
      await call("DELETE", `/users/${await userId(username)}/groups/${await groupId(group)}`);
    },
    async removeRealmRole(username: string, role: string) {
      await call("DELETE", `/users/${await userId(username)}/role-mappings/realm`, [await realmRole(role)]);
    },
    async updateClient(client: KeycloakRepresentation) {
      await call("PUT", `/clients/${client.id}`, client);
    },
    /**
     * Puts a stand user back to the realm template's groups and realm roles (IdP state persists
     * across spec files of one stand run; each spec restores what it changed).
     */
    async restoreUser(username: string, input: Readonly<{ groups: readonly string[]; roles?: readonly string[] }>) {
      const current = await this.groupsOf(username);
      for (const path of current) if (!input.groups.includes(path)) await this.removeFromGroup(username, path.replace(/^\//u, ""));
      for (const path of input.groups) if (!current.includes(path)) await this.addToGroup(username, path.replace(/^\//u, ""));
      if (input.roles) {
        const roles = await this.realmRolesOf(username);
        for (const role of ["aiqsa-admin", "aiqsa-user"]) {
          if (input.roles.includes(role) && !roles.includes(role)) await this.addRealmRole(username, role);
          if (!input.roles.includes(role) && roles.includes(role)) await this.removeRealmRole(username, role);
        }
      }
    }
  };
}

/** The realm template's stand users. */
export const keycloakUsers = {
  alice: { email: "alice@idp.aiqsa.test", groups: ["/engineers"], passwordEnv: "AIQSA_E2E_PW_ALICE", roles: ["aiqsa-user"], username: "alice" },
  bob: { email: "bob@idp.aiqsa.test", groups: ["/contractors"], passwordEnv: "AIQSA_E2E_PW_BOB", roles: [], username: "bob" },
  carol: { email: "carol@local.aiqsa.test", groups: ["/engineers"], passwordEnv: "AIQSA_E2E_PW_CAROL", roles: [], username: "carol" },
  dave: {
    email: "dave@idp.aiqsa.test",
    groups: ["/admins", "/engineers"],
    passwordEnv: "AIQSA_E2E_PW_DAVE",
    roles: ["aiqsa-admin"],
    username: "dave"
  }
} as const;

export type KeycloakUser = (typeof keycloakUsers)[keyof typeof keycloakUsers];

export async function restoreKeycloakUsers(): Promise<void> {
  const admin = keycloakAdmin();
  for (const user of Object.values(keycloakUsers)) {
    await admin.restoreUser(user.username, { groups: user.groups, roles: user.roles });
  }
}

/** The Keycloak OIDC configuration of the stand, as the card would save it. */
export function keycloakOidcConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    adminGroups: [],
    allowedGroups: [],
    autoCreateUsers: true,
    autoRedirect: false,
    buttonLabel: "Keycloak",
    clientId: "aiqsa",
    groupsClaimPath: "groups",
    groupsFrom: "id_token_then_userinfo",
    idpLogout: false,
    issuer: standEnv("AIQSA_E2E_KEYCLOAK_ISSUER"),
    scopes: "openid email profile",
    syncGroups: true,
    trustUnverifiedEmail: false,
    ...overrides
  };
}

export const keycloakClientSecret = () => ({ clientSecret: { kind: "replace" as const, value: standEnv("AIQSA_E2E_OIDC_CLIENT_SECRET") } });
