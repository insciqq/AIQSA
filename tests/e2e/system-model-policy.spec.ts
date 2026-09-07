import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { expect, test } from "@playwright/test";
import { createAdminSystemModelPolicyService } from "../../lib/server/admin/providers/systemModelPolicyService";
import {
  createSystemModelRoleResolver,
  SYSTEM_MODEL_ABSENT,
  SYSTEM_MODEL_UNAVAILABLE
} from "../../lib/server/providerRuntime/systemModelRole";
import { signInWithLocalToken } from "./support/localAuth";

const prisma = new PrismaClient();
const fixture = {
  adminId: randomUUID(),
  checkId: randomUUID(),
  connectionId: randomUUID(),
  credentialId: randomUUID(),
  credentialVersionId: randomUUID(),
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
  defaultReasoningEffort: "medium",
  reasoning: true,
  reasoningEfforts: ["low", "medium", "high", "xhigh"],
  streaming: true,
  toolCalling: true,
  vision: false
};
const modelConfiguration = {
  adapterKind: "openai_responses_compatible",
  answerSelectable: true,
  capabilities,
  defaultParams: {},
  modelClass: "answer" as const,
  upstreamModelId: "system-policy-model"
};

let originalPolicy: {
  providerModelId: string | null;
  reasoningEffort: string | null;
  updatedByUserId: string | null;
} | null = null;

test.describe("system model policy", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    const policy = await prisma.systemModelPolicy.findUniqueOrThrow({
      where: { id: "installation" }
    });
    originalPolicy = {
      providerModelId: policy.providerModelId,
      reasoningEffort: policy.reasoningEffort,
      updatedByUserId: policy.updatedByUserId
    };
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          displayName: "System policy administrator",
          email: `${fixture.adminId}@example.invalid`,
          id: fixture.adminId,
          role: "admin",
          status: "active"
        }
      });
      await tx.providerConnection.create({
        data: {
          activeConfig: connectionConfiguration,
          activeVersion: 1,
          activatedAt: now,
          displayName: "System Policy Fixture",
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
          displayName: "System Policy Model",
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
            method: "system_policy_fixture",
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
          evidence: { method: "system_policy_fixture" },
          id: fixture.checkId,
          modelVersion: 1,
          providerModelId: fixture.modelId,
          status: "available"
        }
      });
      await tx.systemModelPolicy.update({
        data: {
          providerModelId: null,
          reasoningEffort: null,
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
        await tx.systemModelPolicy.update({
          data: {
            providerModelId: originalPolicy!.providerModelId,
            reasoningEffort: originalPolicy!.reasoningEffort,
            updatedByUserId: originalPolicy!.updatedByUserId,
            version: { increment: 1 }
          },
          where: { id: "installation" }
        });
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
        await tx.user.deleteMany({ where: { id: fixture.adminId } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } finally {
      await prisma.$disconnect();
    }
  });

  test("pins exact installation authority and fails closed without substitution", async () => {
    const service = createAdminSystemModelPolicyService(prisma);
    const resolver = createSystemModelRoleResolver(prisma);
    const initial = await service.list();
    expect(initial.candidates).toContainEqual(expect.objectContaining({ id: fixture.modelId }));
    await expect(resolver.resolve()).resolves.toEqual({ code: SYSTEM_MODEL_ABSENT, ok: false });

    await service.update({
      expectedVersion: initial.policy.version,
      providerModelId: fixture.modelId,
      reasoningEffort: "xhigh",
      rerankerProviderModelId: null,
      userId: fixture.adminId
    });
    const resolved = await resolver.resolve();
    expect(resolved).toMatchObject({
      credentialScope: "installation",
      ok: true,
      providerModelId: fixture.modelId,
      reasoningEffort: "xhigh",
      role: {
        authority: {
          credentialId: fixture.credentialId,
          credentialVersionId: fixture.credentialVersionId,
          providerModelId: fixture.modelId
        },
        credentialSource: "default",
        snapshot: { providerModelId: fixture.modelId }
      }
    });

    await prisma.providerModel.update({
      data: { enabled: false },
      where: { id: fixture.modelId }
    });
    await expect(resolver.resolve()).resolves.toEqual({
      code: SYSTEM_MODEL_UNAVAILABLE,
      ok: false
    });
    await prisma.providerModel.update({
      data: { enabled: true },
      where: { id: fixture.modelId }
    });

    await prisma.user.update({
      data: { status: "disabled" },
      where: { id: fixture.adminId }
    });
    await expect(resolver.resolve()).resolves.toMatchObject({
      credentialScope: "installation",
      ok: true,
      providerModelId: fixture.modelId
    });
    await prisma.user.update({
      data: { status: "active" },
      where: { id: fixture.adminId }
    });

    // The pinned model row is protected by an ON DELETE RESTRICT foreign key;
    // Prisma reports it as P2003 or as the raw PostgreSQL 23001 error.
    const rejection = await prisma.providerModel.delete({ where: { id: fixture.modelId } })
      .then(() => null, (error: unknown) => error as { code?: string; message?: string });
    expect(rejection).not.toBeNull();
    expect(rejection?.code === "P2003" || /23001|RESTRICT/u.test(rejection?.message ?? "")).toBe(true);

    const selected = await service.list();
    await service.update({
      expectedVersion: selected.policy.version,
      providerModelId: null,
      reasoningEffort: null,
      rerankerProviderModelId: null,
      userId: fixture.adminId
    });
    await expect(resolver.resolve()).resolves.toEqual({ code: SYSTEM_MODEL_ABSENT, ok: false });
  });

  test("checks and assigns the exact role through the Defaults & roles picker", async ({ page }) => {
    await signInWithLocalToken(page);
    await page.goto("/admin?section=roles");
    const trigger = page.getByRole("button", { name: "Memory & structured helpers deployment" });
    await expect(trigger).toBeVisible();
    await expect(page.getByTestId("admin-role-memory-status")).toHaveText("Not assigned");

    const fixtureLabel = "System Policy Fixture / System Policy Model";
    await page.route("**/api/admin/providers/system-model-policy", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      expect(route.request().postDataJSON()).toEqual({ providerModelId: fixture.modelId, role: "memory" });
      await prisma.providerModelCredentialCheck.update({
        data: {
          evidence: {
            forcedToolCall: {
              adapterKind: "openai_responses_compatible",
              probeVersion: 1,
              upstreamModelId: modelConfiguration.upstreamModelId,
              verified: true
            },
            method: "system_policy_fixture",
            structuredOutput: {
              adapterKind: "openai_responses_compatible",
              probeVersion: 2,
              upstreamModelId: modelConfiguration.upstreamModelId,
              verified: true
            }
          }
        },
        where: { id: fixture.checkId }
      });
      const systemModelPolicy = await createAdminSystemModelPolicyService(prisma).list();
      await route.fulfill({
        contentType: "application/json",
        json: { systemModelPolicy },
        status: 200
      });
    });

    await trigger.click();
    const picker = page.getByRole("dialog", { name: "Memory & structured helpers deployment" });
    // Without role evidence the fixture is not selectable; it offers one Check instead.
    await expect(picker.getByRole("option", { name: fixtureLabel })).toHaveCount(0);
    await expect(picker.getByText("System roles always use the provider's default key")).toBeVisible();
    await picker.getByRole("button", { name: `Check ${fixtureLabel}` }).click();
    await expect(trigger).toHaveText(fixtureLabel);
    await expect(page.getByTestId("admin-role-memory-status")).toHaveText("Working");
    await expect(page.getByTestId("admin-feedback")).toContainText("Saved for future work");
    await expect(picker).toHaveCount(0);

    const reasoning = page.getByRole("combobox", { name: "Memory reasoning" });
    await reasoning.selectOption("xhigh");
    await expect(reasoning).toHaveValue("xhigh");

    const response = await page.request.get("/api/admin/providers/system-model-policy");
    expect(response.status()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      systemModelPolicy: {
        policy: {
          reasoningEffort: "xhigh",
          systemModel: { available: true, id: fixture.modelId }
        }
      }
    });

    await page.getByRole("button", { name: "Memory & structured helpers actions" }).click();
    await page.getByRole("menuitem", { name: "Clear assignment" }).click();
    await expect(trigger).toHaveText("Not assigned");
    await expect(page.getByTestId("admin-role-memory-status")).toHaveText("Not assigned");
  });
});
