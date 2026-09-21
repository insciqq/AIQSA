import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaProjectRepository } from "../projects/prismaRepository";
import { createSkillBundle } from "./bundle";
import { createSkillBundleService } from "./bundleService";
import { createPrismaSkillRepository } from "./prismaRepository";
import { createSkillSharingService } from "./shareRequests";

async function fixture() {
  const suffix = randomUUID();
  const owner = `sharing-owner-${suffix}`, peer = `sharing-peer-${suffix}`, admin = `sharing-admin-${suffix}`;
  await prisma.user.createMany({ data: [owner, peer, admin].map((id) => ({ id, displayName: "Synthetic reviewer", status: "active", role: id === admin ? "admin" : "user" })) });
  const group = await prisma.group.create({ data: { name: `Sharing ${suffix}` } });
  await prisma.userGroup.createMany({ data: [owner, peer, admin].map((userId) => ({ userId, groupId: group.id })) });
  const repository = createPrismaSkillRepository(prisma), service = createSkillSharingService(prisma);
  const projects: string[] = [];
  const draft = { name: "Review workflow", description: "Synthetic approval procedure", instructions: "Approved original" };
  const skillId = await repository.create(owner, draft);
  return { owner, peer, admin, group, skillId, draft, repository, service, projects,
    publish: (id = skillId, userId = owner) => repository.publish({ userId, skillId: id, actorIsAdmin: userId === admin, scope: "group", groupId: group.id }),
    async pending(id = skillId) { return prisma.skillShareRequest.findFirstOrThrow({ where: { skillId: id, state: "pending" } }); },
    async cleanup() {
      await prisma.project.deleteMany({ where: { id: { in: projects } } });
      const skills = await prisma.skillDefinition.findMany({ where: { ownerUserId: { in: [owner, admin] } }, select: { id: true } });
      const ids = skills.map(({ id }) => id);
      await prisma.skillPublication.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillShareRequest.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillDefinition.updateMany({ where: { id: { in: ids } }, data: { currentRevisionId: null, sharedRevisionId: null } });
      await prisma.skillRevisionFile.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillRevision.deleteMany({ where: { skillId: { in: ids } } });
      await prisma.skillDefinition.deleteMany({ where: { id: { in: ids } } });
      await prisma.userGroup.deleteMany({ where: { groupId: group.id } });
      await prisma.group.delete({ where: { id: group.id } });
      await prisma.user.deleteMany({ where: { id: { in: [owner, peer, admin] } } });
    }
  };
}

describe("Skill revision approval persistence", () => {
  afterAll(() => prisma.$disconnect());

  it("hides pending bundles, approves the requested revision after newer edits, and keeps rejections private", async () => {
    const f = await fixture();
    try {
      const bundles = createSkillBundleService(prisma, {
        async putObject() { throw new Error("unexpected_binary_write"); },
        async getObject() { throw new Error("unexpected_binary_read"); },
        async deleteObject() { throw new Error("unexpected_binary_delete"); }
      });
      const bundle = createSkillBundle(f.draft, [{ path: "reference.txt", bytes: Buffer.from("Reviewed reference") }]);
      await bundles.importCandidates(f.owner, [{ name: bundle.name, bundle }], 0);
      expect(await f.publish()).toMatchObject({ kind: "ok" });
      const pending = await f.pending();
      expect(await f.repository.getForUser(f.peer, f.skillId)).toBeNull();
      expect((await f.repository.listForUser(f.peer, { limit: 30 })).entries).toEqual([]);
      await expect(bundles.readFile(f.peer, f.skillId, "reference.txt")).rejects.toThrow("skill_not_available");
      await expect(f.service.detail(f.peer, pending.id)).rejects.toThrow("forbidden");
      const review = await f.service.detail(f.admin, pending.id);
      expect(review.requestedRevision.files).toEqual([{ path: "reference.txt", byteSize: 18, kind: "text", executable: false }]);
      expect(review.diff.files).toMatchObject([{ path: "reference.txt", change: "added" }]);
      expect(await f.service.file(f.admin, pending.id, "reference.txt")).toMatchObject({ content: "Reviewed reference" });
      expect(JSON.stringify(review)).not.toMatch(/storageKey|bundleDigest|checksum|requestedByUserId/);

      await f.repository.revise(f.owner, f.skillId, 2, { ...f.draft, name: "Unapproved private name", instructions: "Private newer body" });
      await f.service.decide(f.admin, pending.id, "approve", null);
      expect(await f.repository.resolveForRun(f.owner, [f.skillId])).toMatchObject({ skills: [{ instructions: "Private newer body" }] });
      expect(await f.repository.resolveForRun(f.peer, [f.skillId])).toMatchObject({ skills: [{ revisionId: pending.revisionId, instructions: f.draft.instructions }] });
      expect((await f.repository.listForUser(f.peer, { limit: 30, query: "Unapproved private name" })).entries).toEqual([]);
      expect((await f.repository.getForUser(f.peer, f.skillId))?.sharing).toBeUndefined();
      expect(await bundles.readFile(f.peer, f.skillId, "reference.txt")).toMatchObject({ content: "Reviewed reference" });
      await f.service.request(f.owner, f.skillId, 3);
      const replacement = await f.pending();
      await f.service.decide(f.admin, replacement.id, "reject", "Please revise the procedure");
      expect((await f.repository.getForUser(f.owner, f.skillId))?.sharing?.request).toMatchObject({ state: "rejected", reviewNote: "Please revise the procedure" });
      expect((await f.repository.getForUser(f.peer, f.skillId))?.revision.id).toBe(pending.revisionId);
      await f.service.request(f.owner, f.skillId, 3);
      expect((await f.pending()).revisionId).toBe(replacement.revisionId);
    } finally { await f.cleanup(); }
  });

  it("automatically approves an administrator's own publication and reuses approval for another audience", async () => {
    const f = await fixture();
    try {
      const skillId = await f.repository.create(f.admin, f.draft);
      expect(await f.publish(skillId, f.admin)).toMatchObject({ kind: "ok" });
      expect((await f.repository.getForUser(f.admin, skillId))?.sharing?.request).toMatchObject({ state: "approved" });
      expect((await f.repository.resolveForRun(f.peer, [skillId])).ok).toBe(true);
      await f.repository.publish({ userId: f.admin, skillId, actorIsAdmin: true, scope: "installation", groupId: null });
      await f.service.request(f.admin, skillId, 1);
      expect(await prisma.skillShareRequest.count({ where: { skillId } })).toBe(1);
    } finally { await f.cleanup(); }
  });

  it("creates the first Project request atomically and gives even its owner only the approved revision", async () => {
    const f = await fixture();
    try {
      const projects = createPrismaProjectRepository(prisma);
      const created = await projects.create({ actorDisplayName: "Owner", description: "Synthetic Project", name: "Sharing Project", userId: f.owner });
      if (created.kind !== "ok") throw new Error("project_fixture_failed");
      f.projects.push(created.value.id);
      const initial = (await projects.getDetail(f.owner, created.value.id))!;
      const result = await projects.addResource({ actorDisplayName: "Owner", expectedPolicyRevision: initial.policyRevision,
        projectId: created.value.id, resourceId: f.skillId, type: "skill", userId: f.owner });
      expect(result.kind).toBe("ok");
      const pending = await f.pending();
      expect(await prisma.projectSkillBinding.count({ where: { projectId: created.value.id, skillId: f.skillId } })).toBe(1);
      expect((await f.repository.resolveForProject(created.value.id, [f.skillId])).ok).toBe(false);
      await f.service.decide(f.admin, pending.id, "approve", null);
      await f.repository.revise(f.owner, f.skillId, 1, { ...f.draft, instructions: "Personal only" });
      expect(await f.repository.resolveForProject(created.value.id, [f.skillId])).toMatchObject({ skills: [{ revisionId: pending.revisionId, instructions: f.draft.instructions }] });
      expect(await f.repository.resolveForRun(f.owner, [f.skillId])).toMatchObject({ skills: [{ instructions: "Personal only" }] });
      const detail = await projects.getDetail(f.owner, created.value.id);
      expect(detail?.resources).toEqual(expect.arrayContaining([expect.objectContaining({ type: "skill", revisionId: pending.revisionId, available: true })]));
      expect(JSON.stringify(detail)).not.toContain("Personal only");
    } finally { await f.cleanup(); }
  });

  it("serializes replacement requests and makes approval versus withdrawal a single winner", async () => {
    const f = await fixture();
    try {
      await f.publish();
      const first = await f.pending();
      await f.repository.revise(f.owner, f.skillId, 1, { ...f.draft, instructions: "New review candidate" });
      await Promise.all([f.service.request(f.owner, f.skillId, 2), f.service.request(f.owner, f.skillId, 2)]);
      expect(await prisma.skillShareRequest.count({ where: { skillId: f.skillId, state: "pending" } })).toBe(1);
      expect(await prisma.skillShareRequest.count({ where: { skillId: f.skillId } })).toBe(2);
      expect((await prisma.skillShareRequest.findUniqueOrThrow({ where: { id: first.id } })).state).toBe("superseded");
      await expect(f.service.decide(f.admin, first.id, "approve", null)).rejects.toThrow("skill_share_request_conflict");
      const current = await f.pending();
      expect((await f.repository.getForUser(f.owner, f.skillId))?.sharing?.request?.id).toBe(current.id);
      const outcomes = await Promise.allSettled([
        f.service.decide(f.admin, current.id, "approve", null), f.service.withdraw(f.owner, f.skillId, current.id)
      ]);
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const request = await prisma.skillShareRequest.findUniqueOrThrow({ where: { id: current.id } });
      const definition = await prisma.skillDefinition.findUniqueOrThrow({ where: { id: f.skillId } });
      expect(definition.sharedRevisionId).toBe(request.state === "approved" ? request.revisionId : null);
    } finally { await f.cleanup(); }
  });

  it.each(["archive", "delete"] as const)("fences approval when an owner concurrently chooses %s", async (action) => {
    const f = await fixture();
    try {
      await f.publish();
      const pending = await f.pending();
      await Promise.allSettled([f.service.decide(f.admin, pending.id, "approve", null),
        action === "archive" ? f.repository.setArchived(f.owner, f.skillId, 1, true) : f.repository.delete(f.owner, f.skillId)]);
      const definition = await prisma.skillDefinition.findUniqueOrThrow({ where: { id: f.skillId } });
      expect(action === "archive" ? definition.archivedAt : definition.deletedAt).not.toBeNull();
      expect((await f.repository.resolveForRun(f.peer, [f.skillId])).ok).toBe(false);
      expect(await prisma.skillShareRequest.count({ where: { skillId: f.skillId, state: "pending" } })).toBe(0);
      await expect(f.service.decide(f.admin, pending.id, "approve", null)).rejects.toThrow();
    } finally { await f.cleanup(); }
  });
});
