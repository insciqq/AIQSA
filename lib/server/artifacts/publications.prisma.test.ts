// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { createPrismaRetentionRepository } from "../retention/prune";
import type { StorageAdapter, StoredObjectInput } from "../uploads/storage";
import { createArtifactService } from "./service";
import { ARTIFACT_RENDERER_VERSION } from "./bundle";
import { readSkillZip } from "../skills/zipReader";

async function fixture() {
  const owner = await prisma.user.create({ data: { id: `versioned-test-${randomUUID()}`, displayName: "Versioned fixture", status: "active" } });
  const bytes = new Map<string, StoredObjectInput>();
  let beforeGet: ((key: string) => Promise<void>) | undefined;
  const storage: StorageAdapter = {
    async putObject(value) { bytes.set(value.storageKey, { ...value, body: Buffer.from(value.body) }); },
    async getObject(key) { await beforeGet?.(key); const value = bytes.get(key); if (!value) throw new Error("fixture_missing_object"); return { ...value, body: Buffer.from(value.body) }; },
    async deleteObject(key) { bytes.delete(key); }
  };
  const service = createArtifactService(prisma, storage);
  const operation = { intent: "create" as const, title: "Version one", kind: "html" as const, entrypoint: "index.html",
    files: [{ path: "index.html", mimeType: "text/html", text: "<main>version-one-canary</main>" }] };
  const v1 = (await service.createVersion({ ownerUserId: owner.id, operation }))!;
  const next = async (baseVersionId: string, title: string, content: string) => (await service.createVersion({ ownerUserId: owner.id, artifactId: v1.artifactId,
    operation: { ...operation, intent: "update", baseVersionId, title, files: [{ ...operation.files[0]!, text: `<main>${content}</main>` }] } }))!;
  const v2 = await next(v1.id, "Private version two", "private-version-two-canary");
  const v3 = await next(v2.id, "Version three", "version-three-canary");
  const publish = (ids = [v1.id, v3.id], defaultVersionId = v3.id) => service.publishSet({ ownerUserId: owner.id,
    artifactId: v1.artifactId, versionIds: ids, defaultVersionId });
  return { owner, service, v1, v2, v3, bytes, publish, next, setBeforeGet(value: typeof beforeGet) { beforeGet = value; },
    async cleanup() {
      await prisma.user.deleteMany({ where: { id: owner.id } });
      await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: { contains: owner.id } } });
    }
  };
}
afterAll(() => prisma.$disconnect());

describe("explicit Artifact version set persistence", () => {
  it("shares only explicit permanent version numbers, with no asset copies or future-version auto publication", async () => {
    const f = await fixture();
    try {
      const before = [...f.bytes.keys()];
      const pub = await f.publish();
      expect([...f.bytes.keys()]).toEqual(before);
      const row = await prisma.artifactPublication.findUniqueOrThrow({ where: { id: pub.id } });
      expect(row).toMatchObject({ mode: "VERSION_SET", revision: 1, artifactVersionId: null, bundleStorageKey: null, checksum: null, byteSize: null, publicManifest: null });
      expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(row)).not.toContain(pub.shareToken);
      const expected = { mode: "version_set", title: "Version three", kind: "html", expiresAt: null, defaultVersionNumber: 3,
        versions: [{ versionNumber: 1, title: "Version one", kind: "html" }, { versionNumber: 3, title: "Version three", kind: "html" }] };
      expect(await f.service.publicManifest(pub.shareToken)).toEqual(expected);
      const v4 = await f.next(f.v3.id, "Private version four", "private-version-four-canary");
      expect(await f.service.publicManifest(pub.shareToken)).toEqual(expected);
      expect(await f.service.publicBundle(pub.shareToken, false, 2)).toBeNull();
      expect(await f.service.publicBundle(pub.shareToken, false, v4.versionNumber)).toBeNull();
      expect((await f.service.publicBundle(pub.shareToken))?.body.toString()).toContain("version-three-canary");
      expect((await f.service.publicBundle(pub.shareToken, false, 1))?.body.toString()).toContain("version-one-canary");
      const zip = await f.service.publicZip(pub.shareToken, 1);
      expect(zip?.versionNumber).toBe(1);
      if (!zip) throw new Error("fixture_zip_missing");
      const exported = readSkillZip(zip.body).find(file => file.path === "index.html")?.bytes.toString();
      expect(exported).toContain("version-one-canary");
      expect(exported).not.toContain("private-version-two-canary");
      expect(await prisma.artifactRender.count({ where: { versionId: { in: [f.v1.id, f.v3.id] }, rendererVersion: ARTIFACT_RENDERER_VERSION } })).toBe(2);
      const another = await f.publish();
      await f.service.publicBundle(another.shareToken, false, 1);
      expect(await prisma.artifactRender.count({ where: { versionId: f.v1.id, rendererVersion: ARTIFACT_RENDERER_VERSION } })).toBe(1);
      const summary = await f.service.publication(f.owner.id, pub.id);
      expect(JSON.stringify(summary)).not.toContain(pub.shareToken);
      expect(JSON.stringify(summary)).not.toContain(row.tokenHash);
    } finally { await f.cleanup(); }
  });

  it("requires a separate successful default operation before removal and preserves numbering through reorder", async () => {
    const f = await fixture();
    try {
      const pub = await f.publish();
      const mutate = (mutation: Parameters<typeof f.service.mutatePublication>[0]["mutation"]) => f.service.mutatePublication({ ownerUserId: f.owner.id, publicationId: pub.id, mutation });
      await expect(mutate({ action: "remove", versionId: f.v3.id, expectedRevision: 1 })).rejects.toThrow("artifact_publication_default_required");
      expect(await mutate({ action: "reorder", versionIds: [f.v3.id, f.v1.id], expectedRevision: 1 })).toMatchObject({ revision: 2, defaultVersionId: f.v3.id });
      expect((await f.service.publicManifest(pub.shareToken))?.versions.map(version => version.versionNumber)).toEqual([3, 1]);
      await mutate({ action: "set_default", versionId: f.v1.id, expectedRevision: 2 });
      await expect(mutate({ action: "remove", versionId: f.v3.id, expectedRevision: 2 })).rejects.toThrow("artifact_publication_conflict");
      expect(await mutate({ action: "remove", versionId: f.v3.id, expectedRevision: 3 })).toMatchObject({ revision: 4 });
      expect(await f.service.publicBundle(pub.shareToken, false, 3)).toBeNull();
      await expect(mutate({ action: "remove", versionId: f.v1.id, expectedRevision: 4 })).rejects.toThrow("artifact_publication_empty");
      await expect(mutate({ action: "reorder", versionIds: [f.v2.id], expectedRevision: 4 })).rejects.toThrow("artifact_publication_version_invalid");
      await mutate({ action: "add", versionIds: [f.v2.id], expectedRevision: 4 });
      expect((await f.service.publicManifest(pub.shareToken))?.versions.map(version => version.versionNumber)).toEqual([1, 2]);
      expect(await prisma.artifactVersion.count({ where: { artifactId: f.v1.artifactId } })).toBe(3);
    } finally { await f.cleanup(); }
  });

  it("gives concurrent mutations and reissues exactly one revision winner without extending expiry", async () => {
    const f = await fixture();
    try {
      const expiresAt = new Date(Date.now() + 86_400_000);
      const pub = await f.service.publishSet({ ownerUserId: f.owner.id, artifactId: f.v1.artifactId,
        versionIds: [f.v1.id, f.v3.id], defaultVersionId: f.v1.id, expiresAt });
      const input = { ownerUserId: f.owner.id, publicationId: pub.id, expectedRevision: 1 };
      const rotations = await Promise.allSettled([f.service.reissue(input), f.service.reissue(input)]);
      expect(rotations.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(rotations.filter(result => result.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ message: "artifact_publication_conflict" }) })]);
      const winner = rotations.find(result => result.status === "fulfilled");
      if (winner?.status !== "fulfilled") throw new Error("fixture_winner_missing");
      expect(winner.value).toMatchObject({ revision: 2, expiresAt: expiresAt.toISOString(), defaultVersionId: f.v1.id });
      expect(await f.service.publicManifest(pub.shareToken)).toBeNull();
      expect((await f.service.publicManifest(winner.value.shareToken))?.versions.map(version => version.versionNumber)).toEqual([1, 3]);
      const changes = await Promise.allSettled([
        f.service.mutatePublication({ ...input, mutation: { action: "set_default", versionId: f.v3.id, expectedRevision: 2 } }),
        f.service.mutatePublication({ ...input, mutation: { action: "reorder", versionIds: [f.v3.id, f.v1.id], expectedRevision: 2 } })
      ]);
      expect(changes.filter(result => result.status === "fulfilled")).toHaveLength(1);
      expect(changes.filter(result => result.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ message: "artifact_publication_conflict" }) })]);
      expect((await prisma.artifactPublication.findUniqueOrThrow({ where: { id: pub.id } })).expiresAt).toEqual(expiresAt);
    } finally { await f.cleanup(); }
  });

  it("rechecks exact membership and token after object I/O and never substitutes a default for corrupted bytes", async () => {
    const f = await fixture();
    try {
      const pub = await f.publish();
      // Prime renders so delayed reads test delivery rather than render writes.
      await f.service.publicBundle(pub.shareToken, false, 1);
      const render = await prisma.artifactRender.findFirstOrThrow({ where: { versionId: f.v1.id } });
      let removed = false;
      f.setBeforeGet(async key => {
        if (key !== render.renderedStorageKey || removed) return;
        removed = true;
        await f.service.mutatePublication({ ownerUserId: f.owner.id, publicationId: pub.id,
          mutation: { action: "remove", versionId: f.v1.id, expectedRevision: 1 } });
      });
      expect(await f.service.publicBundle(pub.shareToken, false, 1)).toBeNull();
      expect(removed).toBe(true);
      f.setBeforeGet(undefined);
      const v3 = await prisma.artifactVersion.findUniqueOrThrow({ where: { id: f.v3.id } });
      const original = f.bytes.get(v3.bundleStorageKey)!;
      f.bytes.set(v3.bundleStorageKey, { ...original, body: Buffer.from("corrupted") });
      expect(await f.service.publicBundle(pub.shareToken, false, 3)).toBeNull();
      expect(await f.service.publicZip(pub.shareToken, 3)).toBeNull();
      expect((await f.service.publicManifest(pub.shareToken))?.versions).toHaveLength(1);
      f.bytes.set(v3.bundleStorageKey, original);
      let reissued = false;
      f.setBeforeGet(async key => {
        if (key !== v3.bundleStorageKey || reissued) return;
        reissued = true;
        await f.service.reissue({ ownerUserId: f.owner.id, publicationId: pub.id, expectedRevision: 2 });
      });
      expect(await f.service.publicZip(pub.shareToken, 3)).toBeNull();
      expect(reissued).toBe(true);
    } finally { await f.cleanup(); }
  });

  it("fences expiry, revocation, disabled owners and archival without reissue resurrection", async () => {
    const f = await fixture();
    try {
      const pub = await f.publish();
      await prisma.user.update({ where: { id: f.owner.id }, data: { status: "disabled" } });
      expect(await f.service.publicManifest(pub.shareToken)).toBeNull();
      expect(await f.service.publicBundle(pub.shareToken)).toBeNull();
      await expect(f.service.reissue({ ownerUserId: f.owner.id, publicationId: pub.id, expectedRevision: 1 })).rejects.toThrow("artifact_publication_not_found");
      await prisma.user.update({ where: { id: f.owner.id }, data: { status: "active" } });
      await prisma.artifactPublication.update({ where: { id: pub.id }, data: { expiresAt: new Date(0) } });
      expect(await f.service.publicManifest(pub.shareToken)).toBeNull();
      await expect(f.service.reissue({ ownerUserId: f.owner.id, publicationId: pub.id, expectedRevision: 1 })).rejects.toThrow("artifact_publication_not_found");
      const active = await f.publish();
      await f.service.revoke({ ownerUserId: f.owner.id, publicationId: active.id, expectedRevision: 1 });
      expect(await f.service.publicManifest(active.shareToken)).toBeNull();
      await expect(f.service.reissue({ ownerUserId: f.owner.id, publicationId: active.id, expectedRevision: 2 })).rejects.toThrow("artifact_publication_not_found");
      const archived = await f.publish();
      const racing = await Promise.allSettled([
        f.service.reissue({ ownerUserId: f.owner.id, publicationId: archived.id, expectedRevision: 1 }),
        f.service.setArchived({ ownerUserId: f.owner.id, artifactId: f.v1.artifactId, archived: true })
      ]);
      expect(racing[1]!.status).toBe("fulfilled");
      if (racing[0]!.status === "fulfilled") expect(await f.service.publicManifest(racing[0]!.value.shareToken)).toBeNull();
      else expect(racing[0]!.reason).toMatchObject({ message: "artifact_publication_not_found" });
      await f.service.setArchived({ ownerUserId: f.owner.id, artifactId: f.v1.artifactId, archived: false });
      expect(await f.service.publicManifest(archived.shareToken)).toBeNull();
      await expect(f.service.reissue({ ownerUserId: f.owner.id, publicationId: archived.id, expectedRevision: 1 })).rejects.toThrow("artifact_publication_not_found");
    } finally { await f.cleanup(); }
  });

  it("keeps canonical byte and render references through member removal and deletes only after artifact lifecycle", async () => {
    const f = await fixture();
    try {
      const pub = await f.publish();
      await f.service.publicBundle(pub.shareToken, false, 1);
      await f.service.mutatePublication({ ownerUserId: f.owner.id, publicationId: pub.id, mutation: { action: "remove", versionId: f.v1.id, expectedRevision: 1 } });
      const retention = createPrismaRetentionRepository(prisma);
      const jobs = await prisma.attachmentDeletionJob.findMany({ where: { storageKey: { contains: f.owner.id } } });
      const claimable = await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 });
      expect(jobs.some(job => claimable.includes(job.id))).toBe(false);
      expect(await f.service.remove({ ownerUserId: f.owner.id, artifactId: f.v1.artifactId })).toBe(true);
      expect(await prisma.artifactPublicationVersion.count({ where: { publicationId: pub.id } })).toBe(0);
      expect(await prisma.artifactRender.count({ where: { versionId: f.v1.id } })).toBe(0);
      const after = await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 });
      expect(jobs.every(job => after.includes(job.id))).toBe(true);
    } finally { await f.cleanup(); }
  });

  it("renders each page of a multi-page version once for owner views and publications, and serves pages only while published", async () => {
    const f = await fixture();
    try {
      const site = (await f.service.createVersion({ ownerUserId: f.owner.id, operation: { intent: "create", kind: "html", title: "Site", entrypoint: "index.html", files: [
        { path: "index.html", mimeType: "text/html", text: '<main>home-canary</main><a href="about.html">About</a>' },
        { path: "about.html", mimeType: "text/html", text: '<main>about-canary</main><a href="docs/guide.html#part">Guide</a>' },
        { path: "docs/guide.html", mimeType: "text/html", text: '<main id="part">guide-canary</main><script>fetch("../data.json")</script>' },
        { path: "data.json", mimeType: "application/json", text: '{"visits":3}' }
      ] } }))!;
      const owner = { ownerUserId: f.owner.id, artifactId: site.artifactId, versionId: site.id };
      const renders = () => prisma.artifactRender.findMany({ where: { versionId: site.id }, orderBy: { page: "asc" } });
      // Concurrent owner views of a cold page share one render.
      const [about, again] = await Promise.all([f.service.getPrivateBundle({ ...owner, page: "about.html" }), f.service.getPrivateBundle({ ...owner, page: "about.html" })]);
      expect(about).toMatchObject({ page: "about.html", contentType: "text/html; charset=utf-8" });
      expect(about!.body.toString()).toContain("about-canary"); expect(about!.body.toString()).not.toContain("home-canary");
      expect(again!.body.equals(about!.body)).toBe(true);
      expect((await renders()).map(render => render.page)).toEqual(["about.html"]);
      const entry = await f.service.getPrivateBundle(owner);
      expect(entry).toMatchObject({ page: "index.html" }); expect(entry!.body.toString()).toContain("home-canary");
      expect((await f.service.getPrivateBundle({ ...owner, page: "index.html" }))!.body.equals(entry!.body)).toBe(true);
      expect((await renders()).map(render => render.page)).toEqual(["", "about.html"]);
      for (const page of ["data.json", "missing.html"]) await expect(f.service.getPrivateBundle({ ...owner, page })).rejects.toThrow("artifact_page_not_found");
      expect(await f.service.getPrivateBundle({ ...owner, ownerUserId: "foreign-owner", page: "about.html" })).toBeNull();

      // A publication reads the same cached pages and adds only the pages its viewers open.
      const single = await f.service.publish(owner);
      expect((await f.service.publicBundle(single.shareToken, false, undefined, "about.html"))!.body.equals(about!.body)).toBe(true);
      const guide = await f.service.publicBundle(single.shareToken, false, undefined, "docs/guide.html");
      expect(guide).toMatchObject({ page: "docs/guide.html", versionNumber: 1 }); expect(guide!.body.toString()).toContain("guide-canary");
      expect((await renders()).map(render => render.page)).toEqual(["", "about.html", "docs/guide.html"]);
      for (const page of ["data.json", "missing.html"]) expect(await f.service.publicBundle(single.shareToken, false, undefined, page)).toBeNull();

      // Rendering any page again drops every page of an older renderer version.
      await prisma.artifactRender.updateMany({ where: { versionId: site.id }, data: { rendererVersion: ARTIFACT_RENDERER_VERSION - 1 } });
      expect((await f.service.publicBundle(single.shareToken, false, undefined, "about.html"))!.body.toString()).toContain("about-canary");
      expect((await renders()).map(render => [render.page, render.rendererVersion])).toEqual([["about.html", ARTIFACT_RENDERER_VERSION]]);
      const retention = createPrismaRetentionRepository(prisma);
      const live = (await renders()).map(render => render.renderedStorageKey);
      const jobs = await prisma.attachmentDeletionJob.findMany({ where: { storageKey: { startsWith: `artifact-renders/${f.owner.id}/` } } });
      const claimable = await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 });
      expect(jobs.filter(job => claimable.includes(job.id)).map(job => job.storageKey).sort())
        .toEqual(jobs.map(job => job.storageKey).filter(key => !live.includes(key)).sort());
      expect(jobs.filter(job => !claimable.includes(job.id)).map(job => job.storageKey)).toEqual(live);

      await f.service.revoke({ ownerUserId: f.owner.id, publicationId: single.id });
      expect(await f.service.publicBundle(single.shareToken, false, undefined, "about.html")).toBeNull();
      expect(await f.service.publicBundle(single.shareToken)).toBeNull();
      expect((await f.service.getPrivateBundle({ ...owner, page: "about.html" }))!.body.toString()).toContain("about-canary");
      expect(await f.service.remove({ ownerUserId: f.owner.id, artifactId: site.artifactId })).toBe(true);
      expect(await prisma.artifactRender.count({ where: { versionId: site.id } })).toBe(0);
      const released = await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 });
      expect(jobs.every(job => released.includes(job.id))).toBe(true);
    } finally { await f.cleanup(); }
  });

  it("keeps legacy single snapshots usable, denies their reissue and validates owner paging anchors", async () => {
    const f = await fixture();
    try {
      const single = await f.service.publish({ ownerUserId: f.owner.id, artifactId: f.v1.artifactId, versionId: f.v1.id });
      expect((await f.service.publicManifest(single.shareToken))?.mode).toBe("single");
      expect((await f.service.publicBundle(single.shareToken))?.body.toString()).toContain("version-one-canary");
      expect(await f.service.publicBundle(single.shareToken, false, 3)).toBeNull();
      await expect(f.service.reissue({ ownerUserId: f.owner.id, publicationId: single.id, expectedRevision: 1 })).rejects.toThrow("artifact_publication_not_found");
      const first = await f.service.versionPage(f.owner.id, f.v1.artifactId, { limit: 2 });
      expect(first?.versions.map(version => version.versionNumber)).toEqual([1, 2]);
      expect(first?.nextCursor).toBe(f.v2.id);
      expect((await f.service.versionPage(f.owner.id, f.v1.artifactId, { cursor: first!.nextCursor!, limit: 2 }))?.versions.map(version => version.versionNumber)).toEqual([3]);
      expect((await f.service.versionPage(f.owner.id, f.v1.artifactId, { versionId: f.v1.id }))?.versions.map(version => version.versionNumber)).toEqual([1]);
      await expect(f.service.versionPage(f.owner.id, f.v1.artifactId, { cursor: "foreign" })).rejects.toThrow("artifact_page_invalid");
      expect(await f.service.publication("foreign", single.id)).toBeNull();
      await f.publish();
      const page = await f.service.publicationPage(f.owner.id, f.v1.artifactId, { limit: 1 });
      expect(page?.publications).toHaveLength(1);
      expect(page?.nextCursor).toBeTruthy();
      const second = await f.service.publicationPage(f.owner.id, f.v1.artifactId, { cursor: page!.nextCursor!, limit: 1 });
      expect(second?.publications).toHaveLength(1);
      expect(second?.publications[0]?.id).not.toBe(page?.publications[0]?.id);
      expect(second?.nextCursor).toBeNull();
      await f.service.revoke({ ownerUserId: f.owner.id, publicationId: single.id });
      expect(await f.service.revoke({ ownerUserId: f.owner.id, publicationId: single.id })).toBe(true);
    } finally { await f.cleanup(); }
  });
});
