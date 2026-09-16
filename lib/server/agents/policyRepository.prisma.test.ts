// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createAgentPolicyRepository } from "./policyRepository";

describe("Agent installation policy persistence", () => {
  afterAll(() => prisma.$disconnect());
  it("serializes versioned edits independently of Workspace and preserves the disabled default", async () => {
    const repository = createAgentPolicyRepository(prisma);
    const original = await repository.read();
    const workspace = await prisma.workspacePolicy.findUniqueOrThrow({ where: { id: "installation" } });
    const user = await prisma.user.create({ data: { id: `agent-policy-${randomUUID()}`, displayName: "Policy fixture", role: "admin", status: "active" } });
    try {
      const { version, ...values } = original;
      const result = await Promise.all([true, false].map((limitsEnabled) => repository.update({
        ...values, limitsEnabled, maxModelCalls: 3, expectedVersion: version, userId: user.id
      })));
      expect(result.filter(Boolean)).toHaveLength(1);
      const current = await createAgentPolicyRepository(prisma).read();
      expect(current).toMatchObject({ version: version + 1, maxModelCalls: 3 });
      expect(await prisma.workspacePolicy.findUniqueOrThrow({ where: { id: "installation" } })).toEqual(workspace);
      expect(await repository.update({ ...values, limitsEnabled: false, expectedVersion: current.version, userId: user.id }))
        .toMatchObject({ limitsEnabled: false });
    } finally {
      await prisma.agentPolicy.update({ where: { id: "installation" }, data: original });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
