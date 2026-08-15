import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test, type Page } from "@playwright/test";
import { providerTemplateIds } from "../../lib/domain/providerTemplates";
import { createAdminModelPolicyService } from "../../lib/server/admin/providers/modelPolicyService";
import { LOCAL_RESTRICTED_MEMBER } from "../../prisma/local-seed-fixtures";
import { signInWithLocalToken } from "./support/localAuth";
import {
  closeRunSetup,
  expectRunSummary,
  openModelPicker,
  openRunSetup
} from "./shell/composer";

const prisma = new PrismaClient();
const fixture = {
  checkId: randomUUID(),
  connectionId: randomUUID(),
  credentialId: randomUUID(),
  credentialVersionId: randomUUID(),
  grantId: randomUUID(),
  modelId: randomUUID()
};

const connectionConfiguration = {
  allowPrivateNetwork: true,
  apiRoot: "http://127.0.0.1:11434/v1",
  authenticationMode: "none",
  responseTimeoutMs: 300_000
};
const capabilities = {
  contextWindow: 8_192,
  nativePdfInput: false,
  nativeSearch: false,
  pdf: false,
  reasoning: false,
  streaming: true,
  toolCalling: false,
  vision: false
};
const modelConfiguration = {
  adapterKind: "openai_responses_compatible",
  answerSelectable: true,
  capabilities,
  defaultParams: {},
  modelClass: "answer" as const,
  upstreamModelId: "browser-policy-model"
};

let createdChatId: string | null = null;
let originalPolicy: {
  defaultProviderModelId: string | null;
  updatedByUserId: string | null;
} | null = null;
let originalUserDefault: string | null = null;

async function signInOrdinaryUser(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(LOCAL_RESTRICTED_MEMBER.email);
  await page.getByLabel("Password", { exact: true }).fill(LOCAL_RESTRICTED_MEMBER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByTestId("app-shell")).toBeVisible();
}

test.describe("installation model default policy", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const [policy, settings] = await Promise.all([
      prisma.modelPolicy.findUniqueOrThrow({ where: { id: "installation" } }),
      prisma.userSettings.findUniqueOrThrow({
        where: { userId: LOCAL_RESTRICTED_MEMBER.id }
      })
    ]);
    originalPolicy = {
      defaultProviderModelId: policy.defaultProviderModelId,
      updatedByUserId: policy.updatedByUserId
    };
    originalUserDefault = settings.defaultProviderModelId;

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.providerConnection.create({
        data: {
          activeConfig: connectionConfiguration,
          activeVersion: 1,
          activatedAt: now,
          displayName: "Browser Default Fixture",
          draftConfig: connectionConfiguration,
          draftVersion: 1,
          enabled: true,
          family: "openai_compatible",
          id: fixture.connectionId,
          unassignedPolicy: "use_default"
        }
      });
      await tx.providerModel.create({
        data: {
          activeConfig: modelConfiguration,
          activeVersion: 1,
          activatedAt: now,
          capabilities,
          connectionId: fixture.connectionId,
          defaultParams: {},
          displayName: "Browser Policy Model",
          draftConfig: modelConfiguration,
          draftVersion: 1,
          enabled: true,
          id: fixture.modelId,
          modelClass: "answer",
          modelId: modelConfiguration.upstreamModelId,
          provider: "openai_compatible"
        }
      });
      await tx.providerCredential.create({
        data: {
          activatedAt: now,
          connectionId: fixture.connectionId,
          draftSecretEnvelope: null,
          draftVersion: 1,
          enabled: true,
          id: fixture.credentialId,
          label: "No authentication",
          testedAt: now
        }
      });
      await tx.providerCredentialVersion.create({
        data: {
          activatedAt: now,
          credentialId: fixture.credentialId,
          id: fixture.credentialVersionId,
          secretEnvelope: null,
          testEvidence: {
            authenticationMode: "none",
            method: "browser_fixture",
            status: "available"
          },
          testedAt: now,
          version: 1
        }
      });
      await tx.providerCredential.update({
        data: { activeVersionId: fixture.credentialVersionId },
        where: { id: fixture.credentialId }
      });
      await tx.providerConnection.update({
        data: { defaultCredentialId: fixture.credentialId },
        where: { id: fixture.connectionId }
      });
      await tx.providerModelCredentialCheck.create({
        data: {
          checkedAt: now,
          connectionId: fixture.connectionId,
          connectionVersion: 1,
          credentialId: fixture.credentialId,
          credentialVersionId: fixture.credentialVersionId,
          evidence: { method: "browser_fixture" },
          id: fixture.checkId,
          modelVersion: 1,
          providerModelId: fixture.modelId,
          status: "available"
        }
      });
      await tx.accessGrant.create({
        data: {
          enabled: true,
          id: fixture.grantId,
          providerModelId: fixture.modelId,
          userId: LOCAL_RESTRICTED_MEMBER.id
        }
      });
      await tx.userSettings.update({
        data: { defaultProviderModelId: null },
        where: { userId: LOCAL_RESTRICTED_MEMBER.id }
      });
      await tx.modelPolicy.update({
        data: {
          defaultProviderModelId: null,
          updatedByUserId: null,
          version: { increment: 1 }
        },
        where: { id: "installation" }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });

  test.afterAll(async () => {
    try {
      if (!originalPolicy) return;
      await prisma.$transaction(async (tx) => {
        await tx.modelPolicy.update({
          data: {
            defaultProviderModelId: originalPolicy!.defaultProviderModelId,
            updatedByUserId: originalPolicy!.updatedByUserId,
            version: { increment: 1 }
          },
          where: { id: "installation" }
        });
        await tx.userSettings.update({
          data: { defaultProviderModelId: originalUserDefault },
          where: { userId: LOCAL_RESTRICTED_MEMBER.id }
        });
        if (createdChatId) {
          await tx.chat.deleteMany({ where: { id: createdChatId } });
        }
        await tx.accessGrant.deleteMany({ where: { id: fixture.grantId } });
        await tx.providerModelCredentialCheck.deleteMany({ where: { id: fixture.checkId } });
        await tx.providerConnection.updateMany({
          data: { defaultCredentialId: null },
          where: { id: fixture.connectionId }
        });
        await tx.providerCredential.updateMany({
          data: { activeVersionId: null },
          where: { id: fixture.credentialId }
        });
        await tx.providerModel.deleteMany({ where: { id: fixture.modelId } });
        await tx.providerCredentialVersion.deleteMany({
          where: { id: fixture.credentialVersionId }
        });
        await tx.providerCredential.deleteMany({ where: { id: fixture.credentialId } });
        await tx.providerConnection.deleteMany({ where: { id: fixture.connectionId } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("inherits, switches without mutation, overrides explicitly, resets, and denies non-admin policy access", async ({
    browser,
    page
  }) => {
    test.setTimeout(60_000);
    const adminPolicy = await createAdminModelPolicyService(prisma).list();
    expect(adminPolicy.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: fixture.modelId })])
    );
    await signInWithLocalToken(page);
    await page.goto("/admin");
    await page.getByRole("tab", { name: "Default model" }).click();
    const installationDefault = page.getByLabel("Active answer model deployment");
    await expect(installationDefault).toBeVisible();
    await installationDefault.selectOption(fixture.modelId);
    await page.getByRole("button", { name: "Save default" }).click();
    await expect(page.getByText("Installation default updated.", { exact: true })).toBeVisible();

    const policyResponse = await page.request.get("/api/admin/providers/model-policy");
    expect(policyResponse.status()).toBe(200);
    const policyBody = await policyResponse.json() as {
      modelPolicy: { policy: { defaultModel: { id: string } | null; version: number } };
    };
    expect(policyBody.modelPolicy.policy.defaultModel?.id).toBe(fixture.modelId);

    const userContext = await browser.newContext();
    const userPage = await userContext.newPage();
    try {
      await signInOrdinaryUser(userPage);

      const inheritedResponse = await userPage.request.get("/api/me/catalog");
      expect(inheritedResponse.status()).toBe(200);
      await expect(inheritedResponse.json()).resolves.toMatchObject({
        catalog: {
          defaults: {
            hasPersonalModelDefault: false,
            modelId: fixture.modelId,
            modelPreferenceSource: "organization",
            organizationModelDefault: {
              modelId: fixture.modelId,
              provider: fixture.connectionId
            },
            personalModelDefault: null,
            provider: fixture.connectionId
          }
        }
      });
      await expectRunSummary(userPage, { model: "Browser Policy Model" });

      const settingsBodies: Record<string, unknown>[] = [];
      userPage.on("request", (request) => {
        if (request.method() !== "PATCH" || new URL(request.url()).pathname !== "/api/me/settings") {
          return;
        }
        try {
          settingsBodies.push(request.postDataJSON() as Record<string, unknown>);
        } catch {
          settingsBodies.push({ malformed: true });
        }
      });

      let modelPicker = await openModelPicker(userPage);
      const inheritedRow = modelPicker.getByRole("option", { name: /Browser Policy Model/ });
      await expect(inheritedRow).toContainText("Current");
      await expect(inheritedRow).toContainText("Org default");
      await modelPicker.getByRole("option", { name: /Fake QSA/ }).click();
      await expectRunSummary(userPage, { model: "Fake QSA" });
      await userPage.waitForTimeout(650);
      expect(settingsBodies).toEqual([]);
      expect((await prisma.userSettings.findUniqueOrThrow({
        where: { userId: LOCAL_RESTRICTED_MEMBER.id }
      })).defaultProviderModelId).toBeNull();

      modelPicker = await openModelPicker(userPage);
      await expect(modelPicker.getByRole("option", { name: /Fake QSA/ })).toContainText("Current");
      await expect(modelPicker.getByRole("option", { name: /Browser Policy Model/ }))
        .toContainText("Org default");
      const personalSave = userPage.waitForResponse((response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === "/api/me/settings"
      );
      await modelPicker.getByRole("button", { name: "Make Fake QSA your default model" }).click();
      expect((await personalSave).status()).toBe(200);
      await expect(userPage.getByTestId("shell-notice")).toContainText(
        "Personal default model updated."
      );
      expect(settingsBodies).toEqual([{
        defaultProviderModelId: providerTemplateIds.fakeModel
      }]);
      await modelPicker.getByRole("option", { name: /Browser Policy Model/ }).click();
      await expectRunSummary(userPage, { model: "Browser Policy Model" });
      await userPage
        .getByRole("complementary", { name: "Chat navigation" })
        .getByRole("button", { name: "New chat", exact: true })
        .click();
      await expectRunSummary(userPage, { model: "Fake QSA" });

      await userPage.reload();
      await expect(userPage.getByTestId("app-shell")).toBeVisible();
      await expectRunSummary(userPage, { model: "Fake QSA" });
      const runSetup = await openRunSetup(userPage);
      const inheritSave = userPage.waitForResponse((response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === "/api/me/settings"
      );
      await runSetup.getByRole("button", { name: "Use organization model default" }).click();
      expect((await inheritSave).status()).toBe(200);
      await expect(userPage.getByTestId("shell-notice")).toContainText(
        "Using the organization default model."
      );
      await closeRunSetup(userPage);
      await expectRunSummary(userPage, { model: "Fake QSA" });
      expect(settingsBodies).toEqual([
        {
          defaultProviderModelId: providerTemplateIds.fakeModel
        },
        { defaultProviderModelId: null }
      ]);

      const resetCatalogResponse = await userPage.request.get("/api/me/catalog");
      expect(resetCatalogResponse.status()).toBe(200);
      await expect(resetCatalogResponse.json()).resolves.toMatchObject({
        catalog: {
          defaults: {
            hasPersonalModelDefault: false,
            modelId: fixture.modelId,
            modelPreferenceSource: "organization",
            personalModelDefault: null
          }
        }
      });

      await userPage.reload();
      await expect(userPage.getByTestId("app-shell")).toBeVisible();
      await expectRunSummary(userPage, { model: "Browser Policy Model" });

      const createChatResponse = await userPage.request.post("/api/chats", {
        data: { title: "Model policy browser evidence" }
      });
      expect(createChatResponse.status()).toBe(201);
      const created = await createChatResponse.json() as {
        chat: { defaultModelId: string | null; defaultProvider: string | null; id: string };
      };
      createdChatId = created.chat.id;
      expect(created.chat).toMatchObject({
        defaultModelId: fixture.modelId,
        defaultProvider: fixture.connectionId
      });

      const [forbiddenRead, forbiddenWrite] = await Promise.all([
        userPage.request.get("/api/admin/providers/model-policy"),
        userPage.request.patch("/api/admin/providers/model-policy", {
          data: {
            expectedVersion: policyBody.modelPolicy.policy.version,
            providerModelId: null
          }
        })
      ]);
      for (const response of [forbiddenRead, forbiddenWrite]) {
        expect(response.status()).toBe(403);
        await expect(response.json()).resolves.toEqual({ error: "forbidden" });
      }
    } finally {
      await userContext.close();
    }
  });
});
