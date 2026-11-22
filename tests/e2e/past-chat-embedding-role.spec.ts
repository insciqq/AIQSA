import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { createEmbeddingModelRoleResolver } from "../../lib/server/providerRuntime/embeddingModelRole";
import { signInWithLocalToken } from "./support/localAuth";
import { expectNoHorizontalOverflow } from "./support/layoutAssertions";

/**
 * Admin › Defaults & roles › Embeddings: the past-chat search embedding role is assigned and cleared through the row,
 * each change only after the cost confirmation, and only a model with embedding evidence on its provider's default
 * key is offered. Fake no-auth provider rows; nothing calls a provider.
 */

const prisma = new PrismaClient();
const fixture = {
  connectionId: randomUUID(),
  credentialId: randomUUID(),
  credentialVersionId: randomUUID(),
  readyCheckId: randomUUID(),
  readyModelId: randomUUID(),
  uncheckedModelId: randomUUID()
};
const DIMENSION = 8;
const connectionConfiguration = {
  allowPrivateNetwork: true,
  apiRoot: "http://127.0.0.1:11434/v1",
  authenticationMode: "none",
  responseTimeoutMs: 30_000
};
function embeddingConfiguration(upstreamModelId: string) {
  return {
    adapterKind: "openai_embeddings_compatible", answerSelectable: false,
    capabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: false, vision: false },
    defaultParams: {},
    embedding: { nativeDimension: DIMENSION, providerFamily: "openai_compatible", queryInstructionTemplate: null,
      supportsMrl: false, targetDimension: DIMENSION },
    modelClass: "embedding" as const, upstreamModelId
  };
}
const ready = embeddingConfiguration("past-chat-embedding-ready");
const unchecked = embeddingConfiguration("past-chat-embedding-unchecked");
const readyLabel = "Past Chat Embedding Fixture / Ready Embedding";

let original: { embeddingConfiguredAt: Date | null; embeddingProviderModelId: string | null } | null = null;

test.describe("past-chat embedding role", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const policy = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
    original = { embeddingConfiguredAt: policy.embeddingConfiguredAt, embeddingProviderModelId: policy.embeddingProviderModelId };
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.providerConnection.create({ data: {
        activeConfig: connectionConfiguration, activeVersion: 1, activatedAt: now, displayName: "Past Chat Embedding Fixture",
        draftConfig: connectionConfiguration, draftVersion: 1, enabled: true, family: "openai_compatible",
        id: fixture.connectionId, unassignedPolicy: "use_default"
      } });
      for (const [id, configuration, displayName] of [
        [fixture.readyModelId, ready, "Ready Embedding"],
        [fixture.uncheckedModelId, unchecked, "Unchecked Embedding"]
      ] as const) {
        await tx.providerModel.create({ data: {
          activeConfig: configuration, activeVersion: 1, activatedAt: now, capabilities: configuration.capabilities,
          connectionId: fixture.connectionId, defaultParams: {}, displayName, draftConfig: configuration, draftVersion: 1,
          enabled: true, id, modelClass: "embedding", modelId: configuration.upstreamModelId, provider: "openai_compatible"
        } });
      }
      await tx.providerCredential.create({ data: {
        activatedAt: now, connectionId: fixture.connectionId, draftSecretEnvelope: null, draftVersion: 1, enabled: true,
        id: fixture.credentialId, label: "No authentication", testedAt: now
      } });
      await tx.providerCredentialVersion.create({ data: {
        activatedAt: now, credentialId: fixture.credentialId, id: fixture.credentialVersionId, secretEnvelope: null,
        testEvidence: { authenticationMode: "none", method: "past_chat_embedding_fixture", status: "available" },
        testedAt: now, version: 1
      } });
      await tx.providerCredential.update({ data: { activeVersionId: fixture.credentialVersionId }, where: { id: fixture.credentialId } });
      await tx.providerConnection.update({ data: { defaultCredentialId: fixture.credentialId }, where: { id: fixture.connectionId } });
      // Only the ready model has embedding evidence on the exact active tuple; the other one was never checked.
      await tx.providerModelCredentialCheck.create({ data: {
        checkedAt: now, connectionId: fixture.connectionId, connectionVersion: 1, credentialId: fixture.credentialId,
        credentialVersionId: fixture.credentialVersionId, id: fixture.readyCheckId, modelVersion: 1,
        providerModelId: fixture.readyModelId, status: "available",
        evidence: { embedding: { dimensions: DIMENSION, document: true, probeVersion: 1, query: true }, method: "tiny_generation",
          selectedProviders: [], upstreamModelId: ready.upstreamModelId }
      } });
      await tx.systemModelPolicy.update({
        data: { embeddingConfiguredAt: null, embeddingProviderModelId: null, version: { increment: 1 } },
        where: { id: "installation" }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });

  test.afterAll(async () => {
    try {
      if (!original) return;
      await prisma.$transaction(async (tx) => {
        await tx.systemModelPolicy.update({
          data: { ...original!, version: { increment: 1 } },
          where: { id: "installation" }
        });
        await tx.providerModelCredentialCheck.deleteMany({ where: { id: fixture.readyCheckId } });
        await tx.providerConnection.updateMany({ data: { defaultCredentialId: null }, where: { id: fixture.connectionId } });
        await tx.providerCredential.updateMany({ data: { activeVersionId: null }, where: { id: fixture.credentialId } });
        await tx.providerModel.deleteMany({ where: { id: { in: [fixture.readyModelId, fixture.uncheckedModelId] } } });
        await tx.providerCredentialVersion.deleteMany({ where: { id: fixture.credentialVersionId } });
        await tx.providerCredential.deleteMany({ where: { id: fixture.credentialId } });
        await tx.providerConnection.deleteMany({ where: { id: fixture.connectionId } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("assigns and clears the model through the Embeddings row, each after the cost confirmation", async ({ page }) => {
    // The Control Center's first compile under `next dev` takes longer than the default 30 s, as in the other admin specs.
    test.setTimeout(120_000);
    const resolver = createEmbeddingModelRoleResolver(prisma);
    await expect(resolver.resolve()).resolves.toMatchObject({ kind: "unset" });

    await signInWithLocalToken(page);
    await page.goto("/admin?section=roles");
    const row = page.getByTestId("admin-role-embedding");
    await expect(row).toContainText("Embeddings", { timeout: 60_000 });
    await expect(row).toContainText("Used by past-chat search");
    await expect(page.getByTestId("admin-role-embedding-status")).toHaveText("Not assigned");

    const trigger = row.getByRole("button", { name: "Embedding deployment" });
    await trigger.click();
    const picker = page.getByRole("dialog", { name: "Embedding deployment" });
    await expect(picker.getByRole("option", { name: readyLabel })).toBeVisible();
    // A model without embedding evidence on its installation key is not offered.
    await expect(picker.getByRole("option", { name: /Unchecked Embedding/u })).toHaveCount(0);

    // Cancelling the confirmation saves nothing.
    await picker.getByRole("option", { name: readyLabel }).click();
    const assign = page.getByTestId("admin-embedding-assign-confirm");
    await expect(assign.getByRole("heading", { name: "Assign the embedding model?" })).toBeVisible();
    await expect(assign).toContainText("provider usage for the whole past-chat index");
    await page.keyboard.press("Escape");
    await expect(assign).toHaveCount(0);
    await expect(page.getByTestId("admin-role-embedding-status")).toHaveText("Not assigned");
    expect((await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } })).embeddingProviderModelId).toBeNull();

    await trigger.click();
    await page.getByRole("dialog", { name: "Embedding deployment" }).getByRole("option", { name: readyLabel }).click();
    await assign.getByRole("button", { name: "Confirm assign and embed" }).click();
    await expect(trigger).toHaveText(readyLabel);
    await expect(page.getByTestId("admin-role-embedding-status")).toHaveText("Working");
    await expect(page.getByTestId("admin-feedback")).toContainText("Saved for future work");
    const assigned = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
    expect(assigned.embeddingProviderModelId).toBe(fixture.readyModelId);
    expect(assigned.embeddingConfiguredAt).not.toBeNull();
    await expect(resolver.resolve()).resolves.toMatchObject({ kind: "model", providerModelId: fixture.readyModelId });

    // A phone keeps the row inside the page.
    await page.setViewportSize({ height: 844, width: 390 });
    await expect(row).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.setViewportSize({ height: 900, width: 1440 });

    await row.getByRole("button", { name: "Embeddings actions" }).click();
    await page.getByRole("menuitem", { name: "Clear assignment" }).click();
    const clear = page.getByTestId("admin-embedding-clear-confirm");
    await expect(clear).toContainText("matches words only");
    await clear.getByRole("button", { name: "Confirm clear role" }).click();
    await expect(page.getByTestId("admin-role-embedding-status")).toHaveText("Not assigned");
    const cleared = await prisma.systemModelPolicy.findUniqueOrThrow({ where: { id: "installation" } });
    expect(cleared.embeddingProviderModelId).toBeNull();
    // An explicit clear stays distinct from never set.
    expect(cleared.embeddingConfiguredAt).not.toBeNull();
    await expect(resolver.resolve()).resolves.toMatchObject({ kind: "unset" });
  });

  test("shows an assigned model that lost its evidence as unavailable, never another model", async ({ page }) => {
    await prisma.systemModelPolicy.update({
      data: { embeddingProviderModelId: fixture.uncheckedModelId, version: { increment: 1 } },
      where: { id: "installation" }
    });
    await expect(createEmbeddingModelRoleResolver(prisma).resolve()).resolves.toMatchObject({
      code: "model_not_available", kind: "unavailable", providerModelId: fixture.uncheckedModelId
    });
    await signInWithLocalToken(page);
    await page.goto("/admin?section=roles");
    await expect(page.getByTestId("admin-role-embedding").getByRole("button", { name: "Embedding deployment" }))
      .toHaveText("Past Chat Embedding Fixture / Unchecked Embedding");
    await expect(page.getByTestId("admin-role-embedding-status")).toHaveText("Unavailable");
    await expect(page.getByTestId("admin-embedding-unavailable")).toContainText("matches words only");
    await prisma.systemModelPolicy.update({
      data: { embeddingProviderModelId: null, version: { increment: 1 } },
      where: { id: "installation" }
    });
  });
});
