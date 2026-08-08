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
  upstreamModelId: "system-policy-model"
};

let originalPolicy: {
  providerModelId: string | null;
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
          contextWindow: capabilities.contextWindow,
          defaultParams: {},
          displayName: "System Policy Model",
          draftConfig: modelConfiguration,
          draftVersion: 1,
          enabled: true,
          id: fixture.modelId,
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
      userId: fixture.adminId
    });
    const resolved = await resolver.resolve();
    expect(resolved).toMatchObject({
      credentialScope: "installation",
      ok: true,
      providerModelId: fixture.modelId,
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

    await expect(prisma.providerModel.delete({ where: { id: fixture.modelId } }))
      .rejects.toMatchObject({ code: "P2003" });

    const selected = await service.list();
    await service.update({
      expectedVersion: selected.policy.version,
      providerModelId: null,
      userId: fixture.adminId
    });
    await expect(resolver.resolve()).resolves.toEqual({ code: SYSTEM_MODEL_ABSENT, ok: false });
  });

  test("sets and clears the exact role through the administrator Providers UI", async ({ page }) => {
    await signInWithLocalToken(page);
    await page.goto("/admin");
    await page.getByRole("tab", { name: "System model" }).click();
    const deployment = page.getByLabel("Active answer model deployment");
    await expect(deployment).toBeVisible();
    await deployment.selectOption(fixture.modelId);
    await page.getByRole("button", { name: "Save system model" }).click();
    await expect(page.getByText("System model updated.", { exact: true })).toBeVisible();
    await expect(page.getByText("Status: Available.", { exact: true })).toBeVisible();

    const response = await page.request.get("/api/admin/providers/system-model-policy");
    expect(response.status()).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      systemModelPolicy: {
        policy: {
          systemModel: { available: true, id: fixture.modelId }
        }
      }
    });

    await page.getByRole("button", { name: "Clear system model" }).click();
    await expect(page.getByText("System model cleared.", { exact: true })).toBeVisible();
    await expect(deployment).toHaveValue("");
  });
});
