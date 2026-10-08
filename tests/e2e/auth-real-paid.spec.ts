/**
 * Opt-in, paid, bounded end-to-end check that IdP groups grant models (auth-wave-e2e-docs, the
 * operator's paid scenario). On the disposable real-IdP stand with AIQSA_AUTH_IDP_E2E=DISPOSABLE
 * plus CODEX_LB_API_KEY and CODEX_LB_BASE_URL (the Codex root ending in `/backend-api/codex`):
 * an administrator sets up one codex-lb answer model and grants it only to an AIQSA group whose
 * OIDC external name is Keycloak's `/engineers`; alice signs in through Keycloak, gets the group,
 * sees the model in her catalog and one bounded message completes; bob, outside the group, does
 * not see it.
 *
 * Oracles are the stand's database and HTTP status codes, never the model's wording; the prompt
 * and the answer are never printed. The codex-lb connection stays on the disposable stand.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { expect, test, type BrowserContext } from "@playwright/test";
import { decodeCatalogResponse } from "../../lib/contracts/catalog";
import { journeyRunParams } from "../../scripts/context-compaction-journey-support";
import { authenticateWithLocalToken } from "./support/localAuth";
import { PAID_TURN_TIMEOUT_MS, paidEnv, pollUntil, setupCodexLbAnswerModel } from "./support/paidProviders";
import {
  addExternalName,
  attachEvidence,
  configureMethod,
  createGroup,
  deleteStandUsers,
  disableMethod,
  keycloakClientSecret,
  keycloakOidcConfig,
  keycloakUsers,
  oidcSignIn,
  randomSuffix,
  REAL_IDP_SKIP_REASON,
  realIdpEnabled,
  restoreKeycloakUsers,
  snapshotMethod,
  standContext,
  standEnv
} from "./support/realIdp";

test.skip(!realIdpEnabled, REAL_IDP_SKIP_REASON);
test.skip(!paidEnv("CODEX_LB_API_KEY") || !paidEnv("CODEX_LB_BASE_URL"), "paid: needs CODEX_LB_API_KEY and CODEX_LB_BASE_URL");
test.describe.configure({ mode: "serial" });
// Traces would record the stand passwords typed into Keycloak's form.
// Traces would record IdP passwords; a failure screenshot shows at most a username.
test.use({ screenshot: "only-on-failure", trace: "off" });

const prisma = new PrismaClient();
const run = randomSuffix();
const ACTIVE = ["preparing", "queued", "streaming", "in_progress"];
const emails = [keycloakUsers.alice.email, keycloakUsers.bob.email];
let restoreOidc: (() => Promise<void>) | null = null;
let groupId = "";
let chatId = "";
let aliceContext: BrowserContext | null = null;

test.beforeAll(async () => {
  restoreOidc = (await snapshotMethod(prisma, "oidc")).restore;
  await prisma.authSignInMethodSetting.deleteMany({ where: { method: "oidc" } });
  await restoreKeycloakUsers();
  await deleteStandUsers(prisma, emails);
});

test.afterAll(async ({ browser }) => {
  try {
    if (chatId && aliceContext) {
      await aliceContext.request.post(`/api/chats/${chatId}/delete-permanently`, { data: {
        alsoForgetOriginMemories: false, confirmationCopyVersion: "memory-confirmation-v1", requestId: randomUUID()
      } }).catch(() => undefined);
      await pollUntil(PAID_TURN_TIMEOUT_MS, async () => (await prisma.chat.findUnique({ where: { id: chatId } })) === null ? true : null)
        .catch(() => undefined);
    }
    await aliceContext?.close();
    const admin = await standContext(browser);
    await authenticateWithLocalToken(admin.request);
    await disableMethod(admin.request, "oidc").catch(() => undefined);
    await admin.close();
  } finally {
    await restoreOidc?.();
    // A permanently deleted chat leaves its owner a Memory deletion obligation that guards the
    // account row; the disposable stand's database goes with the stand, so the account may stay.
    await deleteStandUsers(prisma, emails).catch(() => undefined);
    if (groupId) {
      await prisma.accessGrant.deleteMany({ where: { groupId } });
      await prisma.group.deleteMany({ where: { id: groupId } });
    }
    await prisma.$disconnect();
  }
});

test("a Keycloak group grants a real model: alice gets it through /engineers and a message completes; bob does not see it", async ({ browser }, testInfo) => {
  test.setTimeout(1_800_000);
  const admin = await standContext(browser);
  await authenticateWithLocalToken(admin.request);
  const model = await setupCodexLbAnswerModel(admin.request, { label: "IdP groups", nativeSearch: false });
  groupId = await createGroup(admin.request, `Engineers paid ${run}`);
  await addExternalName(admin.request, groupId, "oidc", "/engineers");
  const granted = await admin.request.post("/api/admin/action", { data: {
    action: "set_group_grants", changes: [{ enabled: true, modelId: model.modelId, provider: model.connectionId }], groupId
  } });
  expect(granted.ok(), `group grant (${granted.status()})`).toBe(true);
  await configureMethod(admin.request, "oidc", keycloakOidcConfig(), keycloakClientSecret());
  await admin.close();

  const alice = await oidcSignIn(browser, {
    buttonLabel: "Keycloak",
    password: standEnv(keycloakUsers.alice.passwordEnv),
    username: keycloakUsers.alice.username
  });
  await expect(alice.page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  aliceContext = alice.context;
  const aliceRequest = alice.context.request;
  const aliceId = (await (await aliceRequest.get("/api/me")).json() as { user: { id: string } }).user.id;
  const aliceMember = (await prisma.userGroup.count({ where: { groupId, userId: aliceId } })) === 1;
  expect(aliceMember).toBe(true);
  const catalog = decodeCatalogResponse(await (await aliceRequest.get("/api/me/catalog")).json());
  const catalogModel = catalog?.models.find((entry) => entry.provider === model.connectionId && entry.modelId === model.modelId);
  expect(Boolean(catalogModel), "the group's model is in alice's catalog").toBe(true);

  const created = await aliceRequest.post("/api/chats", { data: { title: "IdP group model check" } });
  expect(created.ok()).toBe(true);
  chatId = (await created.json() as { chat: { id: string } }).chat.id;
  expect((await aliceRequest.patch(`/api/me/chats/${chatId}/memory-mode`, { data: { mode: "EXCLUDED" } })).ok()).toBe(true);
  const chat = await prisma.chat.findUniqueOrThrow({ select: { activeLeafMessageId: true }, where: { id: chatId } });
  const sent = await aliceRequest.post(`/api/chats/${chatId}/messages`, { timeout: PAID_TURN_TIMEOUT_MS, data: {
    content: { blocks: [{ text: "Reply with exactly one word: ready.", type: "text" }] },
    expectedActiveLeafId: chat.activeLeafMessageId,
    mcp: { mode: "off" },
    modelId: model.modelId,
    params: journeyRunParams(catalogModel!, 512),
    provider: model.connectionId,
    searchPlan: { mode: "all_selected", optionIds: [] },
    searchStrategy: "search-disabled",
    timeZone: "UTC"
  } });
  expect(sent.ok(), `send is accepted (${sent.status()})`).toBe(true);
  await sent.body();
  const newest = await prisma.modelRun.findFirstOrThrow({ orderBy: { createdAt: "desc" }, where: { chatId } });
  const settled = await pollUntil(PAID_TURN_TIMEOUT_MS, async () => {
    const runRow = await prisma.modelRun.findUniqueOrThrow({ select: { status: true }, where: { id: newest.id } });
    return ACTIVE.includes(runRow.status) ? null : runRow;
  }, "idp_paid_run_timeout");
  expect(settled.status).toBe("complete");

  const bob = await oidcSignIn(browser, {
    buttonLabel: "Keycloak",
    password: standEnv(keycloakUsers.bob.passwordEnv),
    username: keycloakUsers.bob.username
  });
  await expect(bob.page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
  const bobCatalog = decodeCatalogResponse(await (await bob.context.request.get("/api/me/catalog")).json());
  const bobSees = Boolean(bobCatalog?.models.some((entry) => entry.provider === model.connectionId && entry.modelId === model.modelId));
  expect(bobSees).toBe(false);
  await bob.context.close();

  const summary = { aliceMember, aliceSeesModel: true, bobSeesModel: bobSees, runStatus: settled.status };
  await attachEvidence(testInfo, "idp-group-model-paid", summary);
  console.log(`idp_group_model_paid_summary ${JSON.stringify(summary)}`);
});
