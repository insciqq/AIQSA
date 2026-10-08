// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_LIMITS, type ArtifactOperation, type ArtifactReference } from "@/lib/contracts/artifacts";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "@/lib/contracts/memory";
import { textMessageContent } from "@/lib/domain/content";
import { prisma } from "../prisma";
import { scheduleTemporaryChatDeletion, temporaryRetentionDeadline } from "../memory/temporaryRetention";
import type { StorageAdapter, StoredObjectInput } from "../uploads/storage";
import { createPrismaRetentionRepository } from "../retention/prune";
import type { ProviderRunRequest } from "../providers/types";
import { createArtifactService } from "./service";
import { writeZip } from "./zip";
import { readZipArchive } from "./zipReader";

const operation: ArtifactOperation = { intent: "create", kind: "game", title: "Counter", entrypoint: "index.html",
  files: [{ path: "index.html", mimeType: "text/html", text: '<button id="count">Count</button><script>let n=0;count.onclick=()=>count.textContent=String(++n)</script>' }] };
function artifactReadRequest(chatId: string, reference?: ArtifactReference): ProviderRunRequest {
  return {
    artifactTool: true, artifactReferences: reference ? [reference] : [], attachmentIds: [], attachments: [], chatId,
    content: { blocks: [{ type: "text", text: "Read the accepted artifact version." }] },
    knowledgePlan: { version: 1, mode: "none", baseIds: [], sourceIds: [] },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false,
      reasoning: false, streaming: false, toolCalling: true, vision: false },
    modelId: "artifact-read-fixture", provider: "fake", params: {},
    prompt: { system: null, developer: null }, searchPlan: { mode: "all_selected", options: [] },
    toolMode: "auto"
  };
}
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { release, wait };
}
async function fixture(temporary = false) {
  const { owner, chat } = await prisma.$transaction(async (tx) => {
    const owner = await tx.user.create({ data: { id: `artifact-test-${randomUUID()}`, displayName: "Artifact test", status: "active" } });
    const now = new Date();
    const deadline = temporary ? temporaryRetentionDeadline(now) : null;
    const chat = await tx.chat.create({ data: { userId: owner.id, title: "Artifact test", memoryMode: temporary ? "TEMPORARY" : "EXCLUDED",
      ...(deadline ? { temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION, temporaryRetentionDeadline: deadline } : {}) } });
    if (deadline) await scheduleTemporaryChatDeletion(tx, { chatId: chat.id, deadline, now, userId: owner.id });
    return { owner, chat };
  });
  const objects = new Map<string, StoredObjectInput>();
  let beforePut: ((value: StoredObjectInput) => Promise<void>) | undefined;
  const storage: StorageAdapter = {
    async putObject(value) { await beforePut?.(value); objects.set(value.storageKey, { ...value, body: Buffer.from(value.body) }); },
    async getObject(key) { const value = objects.get(key); if (!value) throw new Error("missing_object"); return { ...value, body: Buffer.from(value.body) }; },
    async deleteObject(key) { objects.delete(key); }
  };
  const service = createArtifactService(prisma, storage);
  return { owner, chat, service, storage, objects, setBeforePut(value: typeof beforePut) { beforePut = value; },
    async cleanup() {
      if (temporary) {
        await prisma.$transaction(async (tx) => {
          await tx.memoryDeletionOutbox.updateMany({ where: { userId: owner.id, operation: "TEMPORARY_DELETE" }, data: {
            state: "RUNNING", leaseToken: "artifact-test-cleanup", leaseExpiresAt: new Date(Date.now() + 60_000), completedAt: null, nextAttemptAt: null
          } });
          await tx.chat.deleteMany({ where: { userId: owner.id } });
        });
        await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: owner.id } });
      }
      await prisma.user.deleteMany({ where: { id: owner.id } });
      await prisma.attachmentDeletionJob.deleteMany({ where: { storageKey: { contains: owner.id } } });
    } };
}

describe("artifact settlement and lifecycle in PostgreSQL", () => {
  afterAll(async () => { await prisma.$disconnect(); });

  it("creates exactly one ready game through the tool and preserves its entrypoint on a later edit", async () => {
    const f = await fixture();
    try {
      const message = await prisma.message.create({ data: { chatId: f.chat.id, role: "user", content: textMessageContent("Synthetic game") } });
      const run = await prisma.modelRun.create({ data: { chatId: f.chat.id, userId: f.owner.id,
        userMessageId: message.id, provider: "fake", modelId: "fixture", status: "in_progress", normalizedRequest: {} } });
      const call = { id: "create", name: "create_artifact", arguments: operation };
      const persisted = await prisma.modelRunToolCall.create({ data: { modelRunId: run.id, roundIndex: 1,
        ordinal: 0, providerCallId: call.id, toolName: call.name, arguments: {} } });
      const context = { userId: f.owner.id, runId: run.id, persistedToolCallId: persisted.id,
        request: artifactReadRequest(f.chat.id) };
      const { entrypoint: _entrypoint, ...incomplete } = operation;
      const rejected = await f.service.execute({ ...call, arguments: incomplete }, context);
      expect(rejected).toMatchObject({ status: "error", content: [{ type: "json", value: { error: "artifact_entrypoint_missing" } }] });
      expect(await prisma.artifactVersion.count({ where: { sourceModelRunId: run.id } })).toBe(0);
      expect(f.objects.size).toBe(0);
      const created = await f.service.execute(call, context);
      expect(created.status).toBe("complete");
      const first = await prisma.artifactVersion.findUniqueOrThrow({ where: { sourceToolCallId: persisted.id } });
      expect(first).toMatchObject({ status: "READY", entrypoint: "index.html", versionNumber: 1 });
      expect(await f.service.execute(call, context)).toEqual(created);
      expect(await prisma.artifactVersion.count({ where: { sourceModelRunId: run.id } })).toBe(1);
      const edit = await prisma.modelRunToolCall.create({ data: { modelRunId: run.id, roundIndex: 2,
        ordinal: 0, providerCallId: "edit", toolName: call.name, arguments: {} } });
      const updated = await f.service.execute({ id: "edit", name: call.name, arguments: { intent: "update", base_version_id: first.id,
        edits: [{ path: "index.html", old_string: "Count</button>", new_string: "Score</button>" }] } }, {
        ...context, persistedToolCallId: edit.id, request: artifactReadRequest(f.chat.id, { artifactId: first.artifactId, versionId: first.id })
      });
      expect(updated.status).toBe("complete");
      expect(await prisma.artifactVersion.findUniqueOrThrow({ where: { sourceToolCallId: edit.id } }))
        .toMatchObject({ artifactId: first.artifactId, status: "READY", entrypoint: "index.html", versionNumber: 2 });
    } finally {
      await prisma.modelRun.deleteMany({ where: { userId: f.owner.id } });
      await f.cleanup();
    }
  });

  it("keeps temporary chats outside durable artifact creation and editing", async () => {
    const f = await fixture(true);
    try {
      const version = (await f.service.createVersion({ ownerUserId: f.owner.id, operation }))!;
      await expect(f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation })).rejects.toThrow("artifact_not_found");
      await expect(f.service.prepareEdit({ ownerUserId: f.owner.id, artifactId: version.artifactId, versionId: version.id, chatId: f.chat.id })).rejects.toThrow("artifact_chat_unavailable");
      expect(await prisma.artifactChatBinding.count({ where: { chatId: f.chat.id } })).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("rejects an oversized image set before reading objects or allocating a version", async () => {
    const f = await fixture();
    try {
      const images = await Promise.all(["one", "two"].map((name) => prisma.attachment.create({ data: {
        userId: f.owner.id, chatId: f.chat.id, fileName: `${name}.png`, mimeType: "image/png", kind: "image", status: "ready",
        byteSize: 20 * 1024 * 1024, storageKey: `source/${f.owner.id}/${name}.png`, metadata: {}
      } })));
      // No objects exist: an attempted storage read would fail with missing_object.
      await expect(f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation: {
        intent: "create", kind: "image", title: "Too large", files: images.map((image, index) => ({
          path: `image-${index}.png`, mimeType: "image/png", assetRef: image.id
        }))
      } })).rejects.toThrow("artifact_bundle_limit_exceeded");
      expect(await prisma.artifact.count({ where: { ownerUserId: f.owner.id } })).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("serializes concurrent updates while storage is slow and preserves the previous ready version", async () => {
    const f = await fixture(); const entered = barrier(); const release = barrier();
    let pending: ReturnType<typeof f.service.createVersion> | undefined;
    try {
      const v1 = (await f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation }))!;
      f.setBeforePut(async () => { entered.release(); await release.wait; });
      const update = { ...operation, intent: "update" as const, baseVersionId: v1.id, title: "Updated" };
      pending = f.service.createVersion({ ownerUserId: f.owner.id, artifactId: v1.artifactId, operation: update });
      await entered.wait;
      expect((await prisma.artifact.findUniqueOrThrow({ where: { id: v1.artifactId } })).currentVersionId).toBe(v1.id);
      await expect(f.service.createVersion({ ownerUserId: f.owner.id, artifactId: v1.artifactId, operation: update })).rejects.toThrow("artifact_version_conflict");
      release.release(); const v2 = (await pending)!;
      expect(v2.versionNumber).toBe(2);
      expect((await f.service.getArtifactVersion({ ownerUserId: f.owner.id, artifactId: v1.artifactId, versionId: v1.id }))?.title).toBe("Counter");
      expect(await f.service.getPrivateBundle({ ownerUserId: "other-user", artifactId: v1.artifactId })).toBeNull();
      await expect(f.service.createVersion({ ownerUserId: f.owner.id, artifactId: v1.artifactId, operation: update })).rejects.toThrow("artifact_version_conflict");
    } finally { release.release(); await pending?.catch(() => undefined); await f.cleanup(); }
  });

  it("fences a publication against concurrent archive and retains cleanup jobs", async () => {
    const f = await fixture(); const entered = barrier(); const release = barrier();
    let publishing: Promise<unknown> | undefined;
    try {
      const version = (await f.service.createVersion({ ownerUserId: f.owner.id, operation }))!;
      f.setBeforePut(async (value) => { if (value.storageKey.startsWith("artifact-publications/")) { entered.release(); await release.wait; } });
      publishing = f.service.publish({ ownerUserId: f.owner.id, artifactId: version.artifactId, versionId: version.id }).catch(error => error);
      await entered.wait;
      expect(await f.service.archive({ ownerUserId: f.owner.id, artifactId: version.artifactId })).toBe(true);
      release.release(); expect(await publishing).toMatchObject({ message: "artifact_publication_unavailable" });
      expect(await prisma.artifactPublication.count({ where: { artifactId: version.artifactId, status: "READY" } })).toBe(0);
      expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: { contains: f.owner.id } } })).toBe(2);
    } finally { release.release(); await publishing; await f.cleanup(); }
  });

  it("copies selected image bytes, survives source deletion, and fails closed on revocation, expiry and corruption", async () => {
    const f = await fixture();
    try {
      const bytes = Buffer.from("synthetic-image-bytes");
      const source = await prisma.attachment.create({ data: { userId: f.owner.id, chatId: f.chat.id, fileName: "private-name.png", mimeType: "image/png",
        kind: "image", status: "ready", byteSize: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), storageKey: `source/${f.owner.id}/image.png`, metadata: {} } });
      f.objects.set(source.storageKey, { body: bytes, contentType: source.mimeType, storageKey: source.storageKey });
      const version = (await f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id,
        operation: { intent: "create", kind: "image", title: "Picture", files: [{ path: "image.png", mimeType: "image/png", assetRef: source.id }] } }))!;
      expect(JSON.stringify(version.manifest)).not.toContain(source.id);
      const pub = await f.service.publish({ ownerUserId: f.owner.id, artifactId: version.artifactId, versionId: version.id });
      await prisma.attachment.delete({ where: { id: source.id } }); f.objects.delete(source.storageKey);
      expect((await f.service.publicBundle(pub.shareToken))?.body).toEqual(bytes);
      expect(JSON.stringify((await f.service.publicBundle(pub.shareToken))?.manifest)).not.toContain(source.id);
      expect(JSON.stringify((await f.service.publicBundle(pub.shareToken))?.manifest)).not.toContain(source.fileName);
      const retention = createPrismaRetentionRepository(prisma);
      const jobs = await prisma.attachmentDeletionJob.findMany({ where: { storageKey: { contains: f.owner.id } } });
      const prunable = await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 });
      expect(jobs.some(job => prunable.includes(job.id))).toBe(false);
      await prisma.artifactPublication.update({ where: { id: pub.id }, data: { expiresAt: new Date(0) } });
      expect(await f.service.publicBundle(pub.shareToken)).toBeNull();
      await prisma.artifactPublication.update({ where: { id: pub.id }, data: { expiresAt: null } });
      const privateInput = { ownerUserId: f.owner.id, artifactId: version.artifactId, versionId: version.id };
      const versionRow = await prisma.artifactVersion.findUniqueOrThrow({ where: { id: version.id } });
      const originalBundle = f.objects.get(versionRow.bundleStorageKey)!;
      const corruptBundle = Buffer.from(originalBundle.body.toString().replace('"image.png"', '"Image.png"'));
      expect(corruptBundle.byteLength).toBe(originalBundle.body.byteLength);
      expect(corruptBundle.equals(originalBundle.body)).toBe(false);
      f.objects.set(versionRow.bundleStorageKey, { ...originalBundle, body: corruptBundle });
      await expect(f.service.getPrivateBundle(privateInput)).rejects.toThrow("artifact_bundle_unavailable");
      f.objects.set(versionRow.bundleStorageKey, originalBundle);

      const blob = await prisma.artifactBlob.findFirstOrThrow({ where: { ownerUserId: f.owner.id } });
      // The deferred FK still rejects deleting a live blob at commit; owner
      // cascades below may remove its references before that final check.
      await expect(prisma.artifactBlob.delete({ where: { id: blob.id } })).rejects.toMatchObject({ code: "P2003" });
      const originalBlob = f.objects.get(blob.storageKey)!;
      const corruptBlob = Buffer.from(originalBlob.body);
      corruptBlob[0] = corruptBlob[0]! ^ 1;
      f.objects.set(blob.storageKey, { ...originalBlob, body: corruptBlob });
      await expect(f.service.getPrivateBundle(privateInput)).rejects.toThrow("artifact_blob_unavailable");
      expect(await f.service.publicZip(pub.shareToken)).toBeNull();
      f.objects.set(blob.storageKey, originalBlob);
      expect((await f.service.getPrivateBundle(privateInput))?.body).toEqual(bytes);

      const render = await prisma.artifactRender.findFirstOrThrow({ where: { versionId: version.id } });
      const originalRender = f.objects.get(render.renderedStorageKey)!;
      const corruptRender = Buffer.from(originalRender.body);
      corruptRender[0] = corruptRender[0]! ^ 1;
      f.objects.set(render.renderedStorageKey, { ...originalRender, body: corruptRender });
      expect(await f.service.publicBundle(pub.shareToken)).toBeNull();
      f.objects.set(render.renderedStorageKey, originalRender);
      expect((await f.service.publicBundle(pub.shareToken))?.body).toEqual(bytes);
      expect(await f.service.revoke({ ownerUserId: f.owner.id, publicationId: pub.id })).toBe(true);
      expect(await f.service.revoke({ ownerUserId: f.owner.id, publicationId: pub.id })).toBe(true);
      expect(await f.service.publicBundle(pub.shareToken)).toBeNull();
      await prisma.user.delete({ where: { id: f.owner.id } });
      expect(await prisma.artifact.count({ where: { ownerUserId: f.owner.id } })).toBe(0);
      expect(await prisma.artifactBlob.count({ where: { ownerUserId: f.owner.id } })).toBe(0);
      expect(await prisma.artifactVersionBlob.count({ where: { versionId: version.id } })).toBe(0);
      expect(await prisma.attachmentDeletionJob.count({ where: { storageKey: { contains: f.owner.id } } })).toBe(4);
    } finally { await f.cleanup(); }
  });

  it("restores historical versions, preserves archived bytes, and releases objects only on permanent deletion", async () => {
    const f = await fixture();
    try {
      const v1 = (await f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation }))!;
      const v2 = (await f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation: { ...operation, title: "Second", intent: "update", baseVersionId: v1.id } }))!;
      const pub = await f.service.publish({ ownerUserId: f.owner.id, artifactId: v1.artifactId, versionId: v2.id });
      await f.service.restoreVersion({ ownerUserId: f.owner.id, artifactId: v1.artifactId, versionId: v1.id });
      expect((await f.service.contextForChat({ ownerUserId: f.owner.id, chatId: f.chat.id }))[0]?.base_version_id).toBe(v1.id);
      const v3 = (await f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation: { ...operation, title: "Restored edit", intent: "update", baseVersionId: v1.id } }))!;
      expect(v3.versionNumber).toBe(3);
      expect((await f.service.list(f.owner.id))[0]?.versions[0]?.id).toBe(v3.id);
      await f.service.setArchived({ ownerUserId: f.owner.id, artifactId: v1.artifactId, archived: true });
      expect(await f.service.publicBundle(pub.shareToken)).toBeNull();
      expect(await f.service.list(f.owner.id)).toHaveLength(0);
      expect(await f.service.list(f.owner.id, true)).toHaveLength(1);
      const retention = createPrismaRetentionRepository(prisma);
      const jobs = await prisma.attachmentDeletionJob.findMany({ where: { storageKey: { contains: f.owner.id } } });
      const claimable = await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 });
      const version = await prisma.artifactVersion.findUniqueOrThrow({ where: { id: v3.id } });
      expect(claimable).not.toContain(jobs.find(job => job.storageKey === version.bundleStorageKey)?.id);
      await f.service.setArchived({ ownerUserId: f.owner.id, artifactId: v1.artifactId, archived: false });
      expect((await f.service.getPrivateBundle({ ownerUserId: f.owner.id, artifactId: v1.artifactId }))?.version.id).toBe(v3.id);
      expect(await f.service.publicBundle(pub.shareToken)).toBeNull();
      await f.service.remove({ ownerUserId: f.owner.id, artifactId: v1.artifactId });
      const released = await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 });
      expect(released).toEqual(expect.arrayContaining(jobs.map(job => job.id)));
    } finally { await f.cleanup(); }
  });

  it("expires an interrupted writer without letting its late completion overwrite a newer edit", async () => {
    const f = await fixture(); const entered = barrier(); const release = barrier();
    let pending: Promise<unknown> | undefined;
    try {
      const v1 = (await f.service.createVersion({ ownerUserId: f.owner.id, operation }))!;
      f.setBeforePut(async () => { entered.release(); await release.wait; });
      pending = f.service.createVersion({ ownerUserId: f.owner.id, operation: { ...operation, intent: "update", baseVersionId: v1.id } }).catch(error => error);
      await entered.wait;
      await prisma.artifactVersion.updateMany({ where: { artifactId: v1.artifactId, status: "PENDING" }, data: { createdAt: new Date(0) } });
      f.setBeforePut(undefined);
      const v3 = (await f.service.createVersion({ ownerUserId: f.owner.id, operation: { ...operation, title: "Recovered", intent: "update", baseVersionId: v1.id } }))!;
      release.release();
      expect(await pending).toMatchObject({ message: "artifact_version_settlement_conflict" });
      expect((await f.service.getArtifactVersion({ ownerUserId: f.owner.id, artifactId: v1.artifactId }))?.id).toBe(v3.id);
      expect((await f.service.getPrivateBundle({ ownerUserId: f.owner.id, artifactId: v1.artifactId }))?.version.title).toBe("Recovered");
    } finally { release.release(); await pending; await f.cleanup(); }
  });

  it("does not advance ready state after a failed write and safely retries from the prior version", async () => {
    const f = await fixture();
    try {
      const first = (await f.service.createVersion({ ownerUserId: f.owner.id, operation, sourceToolCallId: randomUUID() }))!;
      f.setBeforePut(async () => { throw new Error("storage_unavailable"); });
      await expect(f.service.createVersion({ ownerUserId: f.owner.id, artifactId: first.artifactId,
        operation: { ...operation, intent: "update", baseVersionId: first.id } })).rejects.toThrow("storage_unavailable");
      expect((await prisma.artifact.findUniqueOrThrow({ where: { id: first.artifactId } })).currentVersionId).toBe(first.id);
      f.setBeforePut(undefined);
      const next = (await f.service.createVersion({ ownerUserId: f.owner.id, artifactId: first.artifactId,
        operation: { ...operation, intent: "update", baseVersionId: first.id } }))!;
      expect(next.versionNumber).toBe(3);
      expect(next.status).toBe("READY");
    } finally { await f.cleanup(); }
  });
});


describe("artifact blob/render economy and frozen edits", () => {
  it("reuses vendored code and font blobs across edits, copies and anonymous snapshots", async () => {
    const f = await fixture();
    const root = "https://cdnjs.cloudflare.com/ajax/libs/synthetic/1.2.3/";
    const resources = new Map([
      [`${root}library.js`, { bytes: Buffer.from("window.syntheticLibrary = 42;"), mimeType: "text/javascript" }],
      [`${root}theme.css`, { bytes: Buffer.from('@font-face{font-family:Synthetic;src:url("font.woff2")}body{color:rgb(1,2,3)}'), mimeType: "text/css" }],
      [`${root}font.woff2`, { bytes: Buffer.from("wOF2synthetic-font"), mimeType: "font/woff2" }]
    ]);
    let downloads = 0;
    const service = createArtifactService(prisma, f.storage, { fetchResource: async input => {
      downloads++;
      const resource = resources.get(input.url);
      if (!resource || downloads > 3) throw new Error("unexpected_external_download");
      return { ...resource, resolvedUrl: input.url };
    } });
    try {
      const first = (await service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation: {
        intent: "create", kind: "html", title: "Bundled resources", entrypoint: "index.html", files: [{ path: "index.html", mimeType: "text/html",
          text: `<script src="${root}library.js"></script><link rel="stylesheet" href="${root}theme.css"><p>version one</p>` }]
      } }))!;
      const second = (await service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation: {
        intent: "update", baseVersionId: first.id, edits: [{ path: "index.html", old_string: "version one", new_string: "version two" }]
      } }))!;
      const copy = await service.duplicate({ ownerUserId: f.owner.id, artifactId: first.artifactId });
      expect(downloads).toBe(3);
      const blobs = await prisma.artifactBlob.findMany({ where: { ownerUserId: f.owner.id } });
      expect(blobs).toHaveLength(3);
      expect(new Set(blobs.map(blob => blob.sha256))).toEqual(new Set([...resources.values()].map(resource => createHash("sha256").update(resource.bytes).digest("hex"))));
      expect(await prisma.artifactVersionBlob.count({ where: { blob: { ownerUserId: f.owner.id } } })).toBe(9);
      const source = await service.source({ ownerUserId: f.owner.id, artifactId: first.artifactId, versionId: second.id });
      expect(source?.files.filter(file => file.group === "vendored")).toHaveLength(3);
      expect(source?.files.find(file => file.path.endsWith("/library.js"))).toMatchObject({ text: resources.get(`${root}library.js`)!.bytes.toString() });
      expect(source?.files.find(file => file.path.endsWith("/font.woff2"))).toMatchObject({ binary: true, group: "vendored" });
      expect(source?.files.some(file => "sourceUrl" in file || "resolvedUrl" in file || "sha256" in file)).toBe(false);
      const context = await service.contextForChat({ ownerUserId: f.owner.id, chatId: f.chat.id });
      expect(context[0]?.files).toHaveLength(1);
      const publication = await service.publish({ ownerUserId: f.owner.id, artifactId: first.artifactId, versionId: first.id });
      const rendered = await service.publicBundle(publication.shareToken);
      expect(rendered?.body.toString()).toContain("version one");
      expect(rendered?.body.toString()).not.toContain("version two");
      expect(rendered?.body.toString()).toContain("window.syntheticLibrary = 42;");
      expect(rendered?.body.toString()).toContain("data:font/woff2;base64,");
      expect(downloads).toBe(3);
      const retention = createPrismaRetentionRepository(prisma);
      const jobs = await prisma.attachmentDeletionJob.findMany({ where: { storageKey: { in: blobs.map(blob => blob.storageKey) } } });
      expect(jobs).toHaveLength(3);
      await service.remove({ ownerUserId: f.owner.id, artifactId: first.artifactId });
      expect(await service.publicBundle(publication.shareToken)).toBeNull();
      const retained = await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 });
      expect(jobs.some(job => retained.includes(job.id))).toBe(false);
      expect(await prisma.artifactVersionBlob.count({ where: { blob: { ownerUserId: f.owner.id } } })).toBe(3);
      await service.remove({ ownerUserId: f.owner.id, artifactId: copy.id });
      const released = await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 });
      expect(released).toEqual(expect.arrayContaining(jobs.map(job => job.id)));
    } finally { await f.cleanup(); }
  });

  it("releases binary references after failed settlement while retaining cleanup evidence", async () => {
    const f = await fixture();
    try {
      const bytes = Buffer.from("synthetic image bytes");
      const image = await prisma.attachment.create({ data: { userId: f.owner.id, chatId: f.chat.id, fileName: "photo.png", mimeType: "image/png", kind: "image", status: "ready",
        byteSize: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), storageKey: `source/${f.owner.id}/failed-photo.png`, metadata: {} } });
      f.objects.set(image.storageKey, { body: bytes, contentType: image.mimeType, storageKey: image.storageKey });
      f.setBeforePut(async value => { if (value.storageKey.endsWith(".bundle.json")) throw new Error("synthetic_bundle_failure"); });
      await expect(f.service.createVersion({ ownerUserId: f.owner.id, operation: { intent: "create", kind: "image", title: "Failed image",
        files: [{ path: "photo.png", mimeType: "image/png", assetRef: image.id }] } })).rejects.toThrow("synthetic_bundle_failure");
      const blob = await prisma.artifactBlob.findFirstOrThrow({ where: { ownerUserId: f.owner.id } });
      expect(await prisma.artifactVersionBlob.count({ where: { blobId: blob.id } })).toBe(0);
      const job = await prisma.attachmentDeletionJob.findUniqueOrThrow({ where: { storageKey: blob.storageKey } });
      const retention = createPrismaRetentionRepository(prisma);
      const claims = await retention.claimAttachmentDeletionJobs({ claimableBefore: new Date(), now: new Date(), limit: 1000 });
      expect(claims.map(claim => claim.id)).toContain(job.id);
      expect(await prisma.artifactBlob.count({ where: { ownerUserId: f.owner.id } })).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("deduplicates ten image-bearing versions, synchronizes all chats and shares one immutable render", async () => {
    const f = await fixture();
    try {
      const bytes = Buffer.alloc(5 * 1024 * 1024, 42);
      const image = await prisma.attachment.create({ data: { userId: f.owner.id, chatId: f.chat.id, fileName: "photo.png", mimeType: "image/png", kind: "image", status: "ready",
        byteSize: bytes.length, checksum: createHash("sha256").update(bytes).digest("hex"), storageKey: `source/${f.owner.id}/photo.png`, metadata: {} } });
      f.objects.set(image.storageKey, { body: bytes, contentType: image.mimeType, storageKey: image.storageKey });
      const first = (await f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation: {
        intent: "create", kind: "html", title: "Picture counter", entrypoint: "index.html", files: [
          { path: "index.html", mimeType: "text/html", text: '<p>count:1</p><img src="photo.png">' },
          { path: "photo.png", mimeType: "image/png", assetRef: image.id }
        ] } }))!;
      const secondChat = await prisma.chat.create({ data: { userId: f.owner.id, title: "Second binding" } });
      await f.service.prepareEdit({ ownerUserId: f.owner.id, artifactId: first.artifactId, versionId: first.id, chatId: secondChat.id });
      await prisma.attachment.delete({ where: { id: image.id } }); f.objects.delete(image.storageKey);
      let version = first;
      for (let number = 2; number <= 10; number++) {
        version = (await f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation: { intent: "update", baseVersionId: version.id,
          edits: [{ path: "index.html", old_string: `count:${number - 1}`, new_string: `count:${number}` }] } }))!;
      }
      expect(await prisma.artifactBlob.count({ where: { ownerUserId: f.owner.id } })).toBe(1);
      expect(await prisma.artifactVersionBlob.count({ where: { version: { artifactId: first.artifactId } } })).toBe(10);
      expect((await prisma.artifactChatBinding.findUniqueOrThrow({ where: { artifactId_chatId: { artifactId: first.artifactId, chatId: secondChat.id } } })).versionId).toBe(version.id);
      const versionRow = await prisma.artifactVersion.findUniqueOrThrow({ where: { id: version.id } });
      expect(versionRow.byteSize).toBeLessThan(2048);
      const storedBundle = JSON.parse(f.objects.get(versionRow.bundleStorageKey)!.body.toString());
      expect(storedBundle).toMatchObject({ version: 2, files: [expect.anything(), { path: "photo.png", blob: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length }] });
      expect(JSON.stringify(storedBundle)).not.toContain("base64");
      const read = await f.service.execute({ id: "read-call", name: "read_artifact", arguments: { artifact_id: first.artifactId, paths: ["index.html"] } }, {
        userId: f.owner.id, runId: "accepted-run", request: artifactReadRequest(f.chat.id, { artifactId: first.artifactId, versionId: first.id })
      });
      expect(JSON.stringify(read.content)).toContain("count:1"); expect(JSON.stringify(read.content)).not.toContain("count:10");
      const publications = await Promise.all([1, 2].map(() => f.service.publish({ ownerUserId: f.owner.id, artifactId: first.artifactId, versionId: version.id })));
      expect(await prisma.artifactRender.count({ where: { versionId: version.id } })).toBe(1);
      expect((await f.service.publicMetadata(publications[0]!.shareToken))?.title).toBe("Picture counter");
      const checksumBefore = versionRow.checksum;
      await prisma.artifactRender.updateMany({ where: { versionId: version.id }, data: { rendererVersion: 1 } });
      expect((await f.service.publicBundle(publications[0]!.shareToken))?.body.toString()).toContain("count:10");
      expect(await prisma.artifactRender.count({ where: { versionId: version.id } })).toBe(1);
      expect((await prisma.artifactVersion.findUniqueOrThrow({ where: { id: version.id } })).checksum).toBe(checksumBefore);
      const copy = await f.service.duplicate({ ownerUserId: f.owner.id, artifactId: first.artifactId });
      expect(copy).toMatchObject({ title: "Copy of Picture counter", sourceChatId: null, publicationCount: 0, version: { versionNumber: 1 } });
      expect(await prisma.artifactBlob.count({ where: { ownerUserId: f.owner.id } })).toBe(1);
      const blob = await prisma.artifactBlob.findFirstOrThrow({ where: { ownerUserId: f.owner.id } });
      const job = await prisma.attachmentDeletionJob.findUniqueOrThrow({ where: { storageKey: blob.storageKey } });
      const retention = createPrismaRetentionRepository(prisma);
      await f.service.remove({ ownerUserId: f.owner.id, artifactId: first.artifactId });
      expect(await retention.findClaimableAttachmentDeletionJobIds({ claimableBefore: new Date(), limit: 1000 })).not.toContain(job.id);
      await f.service.remove({ ownerUserId: f.owner.id, artifactId: copy.id });
      const claims = await retention.claimAttachmentDeletionJobs({ claimableBefore: new Date(), now: new Date(), limit: 1000 });
      expect(claims.map(claim => claim.id)).toContain(job.id);
      expect(await prisma.artifactBlob.count({ where: { ownerUserId: f.owner.id } })).toBe(0);
    } finally { await f.cleanup(); }
  });

  it("keeps a large focused artifact as a compact manifest and rejects cross-owner reads", async () => {
    const f = await fixture();
    try {
      const version = (await f.service.createVersion({ ownerUserId: f.owner.id, sourceChatId: f.chat.id, operation: {
        intent: "create", title: "Large", kind: "html", entrypoint: "index.html", files: [{ path: "index.html", mimeType: "text/html", text: "x".repeat(300 * 1024) }]
      } }))!;
      const context = await f.service.contextForChat({ ownerUserId: f.owner.id, chatId: f.chat.id });
      expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(8 * 1024);
      expect(context[0]!.files[0]).toMatchObject({ path: "index.html", bytes: 300 * 1024 });
      expect(context[0]!.files[0]).not.toHaveProperty("text");
      const result = await f.service.execute({ id: "call", name: "read_artifact", arguments: { artifact_id: version.artifactId } }, {
        userId: "foreign", runId: "run", request: artifactReadRequest(f.chat.id, { artifactId: version.artifactId, versionId: version.id })
      });
      expect(result.status).toBe("error"); expect(JSON.stringify(result)).not.toContain("Large");
    } finally { await f.cleanup(); }
  });
});

describe("artifact files supplied by reference in PostgreSQL", () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const MIB = 1024 * 1024;
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  type ErrorValue = { error: string; path?: string; hint: string; excerpt?: string };

  /** A chat attachment row with its stored object; `stored` lets a test corrupt the bytes. */
  async function attach(f: Fixture, input: { bytes: Buffer; mimeType: string; fileName?: string; chatId?: string | null; userId?: string;
    status?: "ready" | "processing" | "failed"; checksum?: string | null; byteSize?: number; stored?: Buffer; producerModelRunId?: string }) {
    const owner = input.userId ?? f.owner.id;
    const storageKey = `source/${owner}/${randomUUID()}`;
    const row = await prisma.attachment.create({ data: { userId: owner, chatId: input.chatId === undefined ? f.chat.id : input.chatId,
      fileName: input.fileName ?? "synthetic.bin", mimeType: input.mimeType, kind: input.mimeType === "text/html" ? "document" : "file",
      status: input.status ?? "ready", ...(input.status === "failed" ? { processingErrorCode: "parser_timeout" } : {}),
      byteSize: input.byteSize ?? input.bytes.length, checksum: input.checksum === undefined ? sha(input.bytes) : input.checksum, storageKey, metadata: {},
      ...(input.producerModelRunId ? { producerModelRunId: input.producerModelRunId, origin: "WORKSPACE_OUTPUT" as const } : {}) } });
    f.objects.set(storageKey, { body: input.stored ?? input.bytes, contentType: input.mimeType, storageKey });
    return row;
  }

  /** One accepted run of the chat; each call is a separately persisted create_artifact tool call. */
  async function acceptedRun(f: Fixture) {
    const message = await prisma.message.create({ data: { chatId: f.chat.id, role: "user", content: textMessageContent("Make an artifact from my file") } });
    const run = await prisma.modelRun.create({ data: { chatId: f.chat.id, userId: f.owner.id, userMessageId: message.id,
      provider: "fake", modelId: "fixture", status: "in_progress", normalizedRequest: {} } });
    let round = 0;
    async function call(args: Record<string, unknown>, allowed: readonly string[] = [], reference?: ArtifactReference) {
      round += 1;
      const persisted = await prisma.modelRunToolCall.create({ data: { modelRunId: run.id, roundIndex: round,
        ordinal: 0, providerCallId: `reference-${round}`, toolName: "create_artifact", arguments: {} } });
      const request = { ...artifactReadRequest(f.chat.id, reference), imageReferences: allowed.map(attachmentId => ({
        attachmentId, messageId: message.id, fileName: "synthetic.bin", origin: "upload" as const })) };
      return f.service.execute({ id: `reference-${round}`, name: "create_artifact", arguments: args },
        { userId: f.owner.id, runId: run.id, persistedToolCallId: persisted.id, request });
    }
    return { message, run, call };
  }

  async function cleanupRuns(f: Fixture) {
    await prisma.attachment.deleteMany({ where: { producerModelRunId: { not: null }, userId: f.owner.id } });
    await prisma.modelRun.deleteMany({ where: { userId: f.owner.id } });
  }

  const errorOf = (result: Awaited<ReturnType<Fixture["service"]["execute"]>>) => {
    expect(result.status).toBe("error");
    return (result.content[0] as { value: ErrorValue }).value;
  };
  const storedBundle = (f: Fixture, bundleStorageKey: string) => JSON.parse(f.objects.get(bundleStorageKey)!.body.toString()) as { files: Array<Record<string, unknown>> };

  it("copies a referenced page larger than written text as a blob and renders, reads, lists and copies it as text", async () => {
    vi.stubEnv("AIQSA_AUTH_SESSION_SECRET", "artifact-reference-read-secret");
    const f = await fixture();
    try {
      const run = await acceptedRun(f);
      const payload = Buffer.alloc(450 * 1024, 7).toString("base64");
      const html = `<!doctype html><html><head><title>Scene</title></head><body><h1>SYNTHETIC_SCENE</h1>` +
        `<script id="data" type="application/octet-stream">${payload}</script><script>document.title = "ready";</script></body></html>`;
      const bytes = Buffer.from(html);
      expect(bytes.length).toBeGreaterThan(ARTIFACT_LIMITS.maxTextFileBytes);
      // Text extraction is still running: the stored bytes and checksum are what counts.
      const page = await attach(f, { bytes, mimeType: "text/html", fileName: "scene.html", status: "processing" });
      const created = await run.call({ intent: "create", kind: "html", title: "Scene", entrypoint: "index.html",
        files: [{ path: "index.html", mimeType: "text/html", asset_ref: page.id }] }, [page.id]);
      expect(created.status).toBe("complete");
      const version = await prisma.artifactVersion.findFirstOrThrow({ where: { sourceModelRunId: run.run.id } });
      expect(storedBundle(f, version.bundleStorageKey).files).toEqual([{ path: "index.html", mimeType: "text/html", blob: sha(bytes), byteSize: bytes.length }]);
      expect(version.byteSize).toBeLessThan(1024);
      expect(await prisma.artifactBlob.findMany({ where: { ownerUserId: f.owner.id }, select: { sha256: true, byteSize: true } }))
        .toEqual([{ sha256: sha(bytes), byteSize: bytes.length }]);
      const projection = await f.service.getArtifactVersion({ ownerUserId: f.owner.id, artifactId: version.artifactId });
      expect(projection?.manifest.files).toEqual([{ path: "index.html", mimeType: "text/html", byteSize: bytes.length, group: "authored" }]);
      expect(JSON.stringify(projection)).not.toContain(page.id);
      const privateInput = { ownerUserId: f.owner.id, artifactId: version.artifactId };
      expect((await f.service.getPrivateBundle(privateInput))!.body.toString()).toContain(`SYNTHETIC_SCENE</h1><script id="data" type="application/octet-stream">${payload}`);
      const read = await f.service.execute({ id: "read", name: "read_artifact", arguments: { artifact_id: version.artifactId, paths: ["index.html"] } },
        { userId: f.owner.id, runId: "accepted-run", request: artifactReadRequest(f.chat.id, { artifactId: version.artifactId, versionId: version.id }) });
      const first = (read.content[0] as { value: { files: Array<{ path: string; text?: string; binary?: true; offset: number }>; truncated: boolean; next_cursor?: string } }).value;
      expect(first.files[0]).toMatchObject({ path: "index.html", offset: 0 });
      expect(first.files[0]!.text!.startsWith("<!doctype html><html><head><title>Scene</title>")).toBe(true);
      expect(first.files[0]!.binary).toBeUndefined();
      expect(first).toMatchObject({ truncated: true, next_cursor: expect.any(String) });
      const next = await f.service.execute({ id: "read-next", name: "read_artifact", arguments: { artifact_id: version.artifactId, paths: ["index.html"], cursor: first.next_cursor } },
        { userId: f.owner.id, runId: "accepted-run", request: artifactReadRequest(f.chat.id, { artifactId: version.artifactId, versionId: version.id }) });
      expect((next.content[0] as { value: { files: Array<{ offset: number; text: string }> } }).value.files[0]!.offset).toBe(first.files[0]!.text!.length);
      const source = await f.service.source({ ownerUserId: f.owner.id, artifactId: version.artifactId, versionId: version.id });
      expect(source?.files).toEqual([{ path: "index.html", mimeType: "text/html", group: "authored", byteSize: bytes.length, text: html }]);
      const context = await f.service.contextForChat({ ownerUserId: f.owner.id, chatId: f.chat.id });
      expect(context[0]?.files).toEqual([{ path: "index.html", mimeType: "text/html", bytes: bytes.length }]);
      // The artifact keeps its own copy: the attachment can disappear.
      await prisma.attachment.delete({ where: { id: page.id } }); f.objects.delete(page.storageKey);
      const copy = await f.service.duplicate({ ownerUserId: f.owner.id, artifactId: version.artifactId });
      expect((await f.service.getPrivateBundle({ ownerUserId: f.owner.id, artifactId: copy.id }))!.body.toString()).toContain("SYNTHETIC_SCENE");
      expect(await prisma.artifactBlob.count({ where: { ownerUserId: f.owner.id } })).toBe(1);
    } finally { await cleanupRuns(f); await f.cleanup(); }
  });

  it("copies binary files of any type, including the run's own Workspace output, and deduplicates them per owner", async () => {
    const f = await fixture();
    try {
      const run = await acceptedRun(f);
      const gif = Buffer.from("GIF89a synthetic animation");
      const pdf = Buffer.from("%PDF-1.7 synthetic document");
      const mp4 = Buffer.from("\u0000\u0000\u0000\u0018ftypisom synthetic video");
      const animation = await attach(f, { bytes: gif, mimeType: "image/gif", fileName: "loop.gif", status: "failed" });
      const document = await attach(f, { bytes: pdf, mimeType: "application/pdf", fileName: "report.pdf" });
      // Produced by this run and not listed as a conversation file.
      const video = await attach(f, { bytes: mp4, mimeType: "video/mp4", fileName: "clip.mp4", producerModelRunId: run.run.id });
      const files = [{ path: "index.html", mimeType: "text/html", text: '<img alt="Loop" src="loop.gif"><p>Files</p>' },
        { path: "loop.gif", mimeType: "image/gif", asset_ref: animation.id }, { path: "report.pdf", mimeType: "application/pdf", asset_ref: document.id },
        { path: "media/clip.mp4", mimeType: "video/mp4", asset_ref: video.id }];
      expect((await run.call({ intent: "create", kind: "html", title: "Files", entrypoint: "index.html", files }, [animation.id, document.id])).status).toBe("complete");
      const version = await prisma.artifactVersion.findFirstOrThrow({ where: { sourceModelRunId: run.run.id } });
      expect(storedBundle(f, version.bundleStorageKey).files.slice(1)).toEqual([
        { path: "loop.gif", mimeType: "image/gif", blob: sha(gif), byteSize: gif.length },
        { path: "report.pdf", mimeType: "application/pdf", blob: sha(pdf), byteSize: pdf.length },
        { path: "media/clip.mp4", mimeType: "video/mp4", blob: sha(mp4), byteSize: mp4.length }
      ]);
      expect((await f.service.getPrivateBundle({ ownerUserId: f.owner.id, artifactId: version.artifactId }))!.body.toString())
        .toContain(`data:image/gif;base64,${gif.toString("base64")}`);
      expect((await run.call({ intent: "create", kind: "html", title: "Again", entrypoint: "index.html", files: files.slice(0, 2) }, [animation.id])).status).toBe("complete");
      expect(await prisma.artifactBlob.count({ where: { ownerUserId: f.owner.id } })).toBe(3);
      expect(await prisma.artifactVersionBlob.count({ where: { blob: { ownerUserId: f.owner.id } } })).toBe(4);
    } finally { await cleanupRuns(f); await f.cleanup(); }
  });

  it("refuses files outside the run's authority and unverifiable files without writing anything", async () => {
    const f = await fixture();
    const stranger = await prisma.user.create({ data: { id: `artifact-test-${randomUUID()}`, displayName: "Stranger", status: "active" } });
    const project = await prisma.project.create({ data: { name: "Synthetic artifact Project", createdByUserId: f.owner.id,
      createdByDisplayName: "Artifact test", grants: { create: { userId: f.owner.id, role: "OWNER" } } } });
    try {
      const run = await acceptedRun(f);
      const html = Buffer.from("<p>synthetic</p>");
      const strangerChat = await prisma.chat.create({ data: { userId: stranger.id, title: "Stranger chat" } });
      const foreign = await attach(f, { bytes: html, mimeType: "text/html", userId: stranger.id, chatId: strangerChat.id });
      const otherChat = await prisma.chat.create({ data: { userId: f.owner.id, title: "Other chat" } });
      const elsewhere = await attach(f, { bytes: html, mimeType: "text/html", chatId: otherChat.id });
      const projectKey = `source/${f.owner.id}/${randomUUID()}`;
      f.objects.set(projectKey, { body: html, contentType: "text/html", storageKey: projectKey });
      const projectFile = await prisma.attachment.create({ data: { projectId: project.id, uploaderUserId: f.owner.id, uploaderDisplayName: "Artifact test",
        fileName: "project.html", mimeType: "text/html", kind: "document", status: "ready", byteSize: html.length, checksum: sha(html), storageKey: projectKey, metadata: {} } });
      const otherMessage = await prisma.message.create({ data: { chatId: f.chat.id, role: "user", content: textMessageContent("Earlier request") } });
      const otherRun = await prisma.modelRun.create({ data: { chatId: f.chat.id, userId: f.owner.id, userMessageId: otherMessage.id,
        provider: "fake", modelId: "fixture", status: "complete", normalizedRequest: {} } });
      const otherOutput = await attach(f, { bytes: html, mimeType: "text/html", producerModelRunId: otherRun.id });
      const pdf = Buffer.from("%PDF-1.7 synthetic");
      const mismatched = await attach(f, { bytes: pdf, mimeType: "application/pdf" });
      const corruptedBytes = Buffer.from(pdf); corruptedBytes[0] = corruptedBytes[0]! ^ 1;
      const corrupted = await attach(f, { bytes: pdf, mimeType: "application/pdf", stored: corruptedBytes });
      const unchecked = await attach(f, { bytes: pdf, mimeType: "application/pdf", checksum: null });
      const latin1 = await attach(f, { bytes: Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]), mimeType: "text/html" });
      const control = await attach(f, { bytes: Buffer.from("<p>bell\u0007</p>"), mimeType: "text/html" });
      const oversized = await attach(f, { bytes: pdf, mimeType: "application/pdf", byteSize: ARTIFACT_LIMITS.maxAssetBytes + 1 });
      const large = await Promise.all([1, 2].map(() => attach(f, { bytes: pdf, mimeType: "application/pdf", byteSize: 20 * MIB })));
      const entry = { path: "index.html", mimeType: "text/html", text: "<p>Entry</p>" };
      const refer = (id: string, mimeType: string, path = "file.bin") => [entry, { path, mimeType, asset_ref: id }];
      const cases: Array<[string, unknown[], readonly string[], string, string?]> = [
        ["another owner's file", refer(foreign.id, "text/html", "page.html"), [foreign.id], "artifact_asset_unavailable"],
        ["another chat's file, even when listed", refer(elsewhere.id, "text/html", "page.html"), [elsewhere.id], "artifact_asset_unavailable"],
        ["another chat's file", refer(elsewhere.id, "text/html", "page.html"), [], "artifact_asset_unavailable"],
        ["a Project file", refer(projectFile.id, "text/html", "page.html"), [projectFile.id], "artifact_asset_unavailable"],
        ["another run's output", refer(otherOutput.id, "text/html", "page.html"), [], "artifact_asset_unavailable"],
        ["a different declared type", refer(mismatched.id, "text/html", "page.html"), [mismatched.id], "artifact_asset_mime_mismatch", '"application/pdf"'],
        ["corrupted stored bytes", refer(corrupted.id, "application/pdf"), [corrupted.id], "artifact_asset_invalid"],
        ["a file without a checksum", refer(unchecked.id, "application/pdf"), [unchecked.id], "artifact_asset_checksum_missing"],
        ["text that is not UTF-8", refer(latin1.id, "text/html", "page.html"), [latin1.id], "artifact_text_encoding_invalid"],
        ["text with control characters", refer(control.id, "text/html", "page.html"), [control.id], "artifact_text_invalid", "U+0007"],
        ["a file over 24 MiB", refer(oversized.id, "application/pdf"), [oversized.id], "artifact_asset_too_large", "24.0 MiB"],
        ["files over 32 MiB together", [entry, ...large.map((row, index) => ({ path: `part-${index}.pdf`, mimeType: "application/pdf", asset_ref: row.id }))],
          large.map(row => row.id), "artifact_bundle_limit_exceeded"]
      ];
      for (const [name, files, allowed, code, hint] of cases) {
        const value = errorOf(await run.call({ intent: "create", kind: "html", title: name, entrypoint: "index.html", files }, allowed));
        expect(value, name).toMatchObject({ error: code, path: expect.any(String), ...(hint ? { hint: expect.stringContaining(hint) } : {}) });
        if (code === "artifact_asset_unavailable") expect(value.hint, name).not.toMatch(/text\/html|synthetic/u);
      }
      expect(await prisma.artifactVersion.count({ where: { sourceModelRunId: run.run.id } })).toBe(0);
      expect(await prisma.artifact.count({ where: { ownerUserId: f.owner.id } })).toBe(0);
      expect(await prisma.artifactBlob.count({ where: { ownerUserId: f.owner.id } })).toBe(0);
      expect([...f.objects.keys()].filter(key => key.startsWith("artifact"))).toEqual([]);
    } finally {
      await cleanupRuns(f);
      await prisma.project.deleteMany({ where: { id: project.id } });
      await prisma.user.deleteMany({ where: { id: stranger.id } });
      await f.cleanup();
    }
  });

  it("edits a referenced page at creation and stores every later edit of it as a new blob", async () => {
    vi.stubEnv("AIQSA_AUTH_SESSION_SECRET", "artifact-reference-read-secret");
    const f = await fixture();
    try {
      const run = await acceptedRun(f);
      const refresh = '<meta http-equiv="refresh" content="5">';
      const html = `<!doctype html><html><head>${refresh}<title>Original title</title></head><body><h1>Scene</h1>${"<p>filler</p>".repeat(50_000)}</body></html>`;
      const page = await attach(f, { bytes: Buffer.from(html), mimeType: "text/html", fileName: "scene.html", status: "failed" });
      const create = { intent: "create", kind: "html", title: "Scene", entrypoint: "index.html", files: [{ path: "index.html", mimeType: "text/html", asset_ref: page.id }] };
      const refused = errorOf(await run.call(create, [page.id]));
      expect(refused).toMatchObject({ error: "artifact_element_unsupported", path: "index.html", excerpt: expect.stringContaining(refresh) });
      expect(html).toContain(refused.excerpt);
      expect((await run.call({ ...create, edits: [{ path: "index.html", old_string: refused.excerpt!.slice(refused.excerpt!.indexOf("<meta"), refused.excerpt!.indexOf("<meta") + refresh.length), new_string: "" }] }, [page.id])).status).toBe("complete");
      const first = await prisma.artifactVersion.findFirstOrThrow({ where: { sourceModelRunId: run.run.id } });
      const firstText = html.replace(refresh, "");
      expect(storedBundle(f, first.bundleStorageKey).files).toEqual([{ path: "index.html", mimeType: "text/html", blob: sha(Buffer.from(firstText)), byteSize: Buffer.byteLength(firstText) }]);
      // Edited bytes no longer equal the attachment, so the manifest does not name it.
      expect(JSON.stringify(first.manifest)).not.toContain(page.id);
      const reference = { artifactId: first.artifactId, versionId: first.id };
      expect((await run.call({ intent: "update", base_version_id: first.id, edits: [{ path: "index.html", old_string: "Original title", new_string: "Renamed title" }] }, [], reference)).status).toBe("complete");
      const second = await prisma.artifactVersion.findFirstOrThrow({ where: { artifactId: first.artifactId, versionNumber: 2 } });
      const secondText = firstText.replace("Original title", "Renamed title");
      expect(storedBundle(f, second.bundleStorageKey).files).toEqual([{ path: "index.html", mimeType: "text/html", blob: sha(Buffer.from(secondText)), byteSize: Buffer.byteLength(secondText) }]);
      expect(storedBundle(f, first.bundleStorageKey).files[0]).toMatchObject({ blob: sha(Buffer.from(firstText)) });
      expect((await f.service.getPrivateBundle({ ownerUserId: f.owner.id, artifactId: first.artifactId, versionId: first.id }))!.body.toString()).toContain("Original title");
      expect((await f.service.getPrivateBundle({ ownerUserId: f.owner.id, artifactId: first.artifactId, versionId: second.id }))!.body.toString()).toContain("Renamed title");
      const read = await f.service.execute({ id: "read", name: "read_artifact", arguments: { artifact_id: first.artifactId, paths: ["index.html"] } },
        { userId: f.owner.id, runId: "accepted-run", request: artifactReadRequest(f.chat.id, { artifactId: first.artifactId, versionId: second.id }) });
      expect(JSON.stringify(read.content)).toContain("Renamed title");
      // An unrelated change keeps the stored page as the same deduplicated blob.
      expect((await run.call({ intent: "update", base_version_id: second.id, files: [{ path: "notes.txt", mimeType: "text/plain", text: "notes" }] }, [], { artifactId: first.artifactId, versionId: second.id })).status).toBe("complete");
      const third = await prisma.artifactVersion.findFirstOrThrow({ where: { artifactId: first.artifactId, versionNumber: 3 } });
      expect(storedBundle(f, third.bundleStorageKey).files).toEqual([
        { path: "index.html", mimeType: "text/html", blob: sha(Buffer.from(secondText)), byteSize: Buffer.byteLength(secondText) },
        { path: "notes.txt", mimeType: "text/plain", text: "notes" }
      ]);
      expect(await prisma.artifactBlob.count({ where: { ownerUserId: f.owner.id } })).toBe(2);
      expect(await prisma.artifactVersionBlob.count({ where: { version: { artifactId: first.artifactId } } })).toBe(3);
    } finally { await cleanupRuns(f); await f.cleanup(); }
  });

  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const archiveOf = (files: Record<string, string | Buffer>) => writeZip(Object.entries(files).map(([path, bytes]) => ({ path, bytes: Buffer.from(bytes) })));
  const unpackFile = (id: string) => ({ path: "site.zip", mimeType: "application/zip", asset_ref: id, unpack: true });
  const sitePaths = ["about.html", "css/empty.css", "css/site.css", "img/copy.png", "img/logo.png", "index.html"];
  const siteArchive = () => archiveOf({
    "site/index.html": '<!doctype html><html><head><link rel="stylesheet" href="css/site.css"></head><body><h1>SYNTHETIC_SITE</h1><img alt="Logo" src="img/logo.png"><a href="contact.html">Contact</a></body></html>',
    "site/about.html": "<p>About</p>", "site/css/site.css": "h1{color:teal}", "site/css/empty.css": "",
    "site/img/logo.png": png, "site/img/copy.png": png, "site/img/.DS_Store": "x", "__MACOSX/site/._index.html": "x"
  });

  it("unpacks a referenced site into owner blobs, renders it, recovers the same receipt and keeps other files on later edits", async () => {
    const f = await fixture();
    try {
      const run = await acceptedRun(f);
      // Extraction of the archive never finishes: stored bytes and checksum are what counts.
      const archive = await attach(f, { bytes: siteArchive(), mimeType: "application/zip", fileName: "site.zip", status: "processing" });
      const created = await run.call({ intent: "create", kind: "html", title: "Site", files: [unpackFile(archive.id)] }, [archive.id]);
      expect(created.status).toBe("complete");
      expect((created.content[0] as { value: Record<string, unknown> }).value).toMatchObject({ entrypoint: "index.html",
        unpacked: { root_folder: "site", skipped_entries: 2, file_count: sitePaths.length, paths: sitePaths },
        render_notes: { missing_links: [{ page: "index.html", href: "contact.html", path: "contact.html" }], hint: expect.stringContaining("missing_links") } });
      const first = await prisma.artifactVersion.findFirstOrThrow({ where: { sourceModelRunId: run.run.id } });
      // The notes stay in the private manifest, out of the public one.
      expect(first.manifest).toMatchObject({ report: { renderNotes: { missingLinks: [{ page: "index.html", href: "contact.html", path: "contact.html" }] } } });
      expect((await f.service.getArtifactVersion({ ownerUserId: f.owner.id, artifactId: first.artifactId }))!.manifest).not.toHaveProperty("report");
      const before = storedBundle(f, first.bundleStorageKey).files;
      expect(before.map(file => file.path)).toEqual(sitePaths);
      expect(before.find(file => file.path === "css/empty.css")).toEqual({ path: "css/empty.css", mimeType: "text/css", text: "" });
      // Both copies of the logo share one owner blob; the archive itself is not stored.
      expect(await prisma.artifactBlob.count({ where: { ownerUserId: f.owner.id } })).toBe(4);
      expect(await prisma.artifactVersionBlob.count({ where: { versionId: first.id } })).toBe(5);
      expect(JSON.stringify(first.manifest)).not.toContain(archive.id);
      const rendered = (await f.service.getPrivateBundle({ ownerUserId: f.owner.id, artifactId: first.artifactId }))!.body.toString();
      for (const expected of ["SYNTHETIC_SITE", "h1{color:teal}", `data:image/png;base64,${png.toString("base64")}`]) expect(rendered).toContain(expected);
      // Crash recovery rebuilds the same receipt from the stored version.
      const restored = await f.service.restore({ id: "recovered", name: "create_artifact", arguments: {} },
        { userId: f.owner.id, runId: run.run.id, persistedToolCallId: first.sourceToolCallId!, request: artifactReadRequest(f.chat.id) });
      expect(restored?.content).toEqual(created.content);
      const reference = { artifactId: first.artifactId, versionId: first.id };
      const edited = await run.call({ intent: "update", base_version_id: first.id, edits: [{ path: "about.html", old_string: "About", new_string: "About us" }] }, [], reference);
      expect(edited.status).toBe("complete");
      expect((edited.content[0] as { value: Record<string, unknown> }).value).not.toHaveProperty("unpacked");
      const second = await prisma.artifactVersion.findFirstOrThrow({ where: { artifactId: first.artifactId, versionNumber: 2 } });
      const after = storedBundle(f, second.bundleStorageKey).files;
      expect(after.filter(file => file.path !== "about.html")).toEqual(before.filter(file => file.path !== "about.html"));
      expect(after.find(file => file.path === "about.html")).toMatchObject({ blob: sha(Buffer.from("<p>About us</p>")) });
      expect(before.find(file => file.path === "about.html")).toMatchObject({ blob: sha(Buffer.from("<p>About</p>")) });
      const exported = await f.service.getPrivateZip({ ownerUserId: f.owner.id, artifactId: first.artifactId, versionId: second.id });
      expect((await readZipArchive(exported!.body)).entries.map(entry => entry.path)).toEqual(sitePaths);
    } finally { await cleanupRuns(f); await f.cleanup(); }
  });

  it("refuses an archive of another chat or another owner without writing anything", async () => {
    const f = await fixture();
    const stranger = await prisma.user.create({ data: { id: `artifact-test-${randomUUID()}`, displayName: "Stranger", status: "active" } });
    try {
      const run = await acceptedRun(f);
      const otherChat = await prisma.chat.create({ data: { userId: f.owner.id, title: "Other chat" } });
      const strangerChat = await prisma.chat.create({ data: { userId: stranger.id, title: "Stranger chat" } });
      const elsewhere = await attach(f, { bytes: siteArchive(), mimeType: "application/zip", chatId: otherChat.id });
      const foreign = await attach(f, { bytes: siteArchive(), mimeType: "application/zip", userId: stranger.id, chatId: strangerChat.id });
      for (const [id, allowed] of [[elsewhere.id, [elsewhere.id]], [elsewhere.id, []], [foreign.id, [foreign.id]]] as const) {
        const value = errorOf(await run.call({ intent: "create", kind: "html", title: "Site", files: [unpackFile(id)] }, allowed));
        expect(value).toMatchObject({ error: "artifact_asset_unavailable", path: "site.zip" });
        expect(value.hint).not.toMatch(/zip|site/u);
      }
      expect(await prisma.artifact.count({ where: { ownerUserId: f.owner.id } })).toBe(0);
      expect(await prisma.artifactBlob.count({ where: { ownerUserId: f.owner.id } })).toBe(0);
      expect([...f.objects.keys()].filter(key => key.startsWith("artifact"))).toEqual([]);
    } finally {
      await cleanupRuns(f);
      await prisma.user.deleteMany({ where: { id: stranger.id } });
      await f.cleanup();
    }
  });

  it("unpacks a 500-file site and edits it, binding every file in one transaction each", async () => {
    const f = await fixture();
    try {
      const run = await acceptedRun(f);
      const notes = Object.fromEntries(Array.from({ length: ARTIFACT_LIMITS.maxBundleFiles - 1 }, (_, index) => [`notes/${String(index).padStart(3, "0")}.txt`, `note ${index}`]));
      const archive = await attach(f, { bytes: archiveOf({ "index.html": "<h1>LARGE_SITE</h1>", ...notes }), mimeType: "application/zip" });
      expect((await run.call({ intent: "create", kind: "html", title: "Large", files: [unpackFile(archive.id)] }, [archive.id])).status).toBe("complete");
      const first = await prisma.artifactVersion.findFirstOrThrow({ where: { sourceModelRunId: run.run.id } });
      expect(await prisma.artifactVersionBlob.count({ where: { versionId: first.id } })).toBe(ARTIFACT_LIMITS.maxBundleFiles);
      const edited = await run.call({ intent: "update", base_version_id: first.id, edits: [{ path: "index.html", old_string: "LARGE_SITE", new_string: "LARGER_SITE" }] },
        [], { artifactId: first.artifactId, versionId: first.id });
      expect(edited.status).toBe("complete");
      const second = await prisma.artifactVersion.findFirstOrThrow({ where: { artifactId: first.artifactId, versionNumber: 2 } });
      expect(await prisma.artifactVersionBlob.count({ where: { versionId: second.id } })).toBe(ARTIFACT_LIMITS.maxBundleFiles);
      expect(await prisma.artifactBlob.count({ where: { ownerUserId: f.owner.id } })).toBe(ARTIFACT_LIMITS.maxBundleFiles + 1);
      expect((await f.service.getPrivateBundle({ ownerUserId: f.owner.id, artifactId: first.artifactId, versionId: second.id }))!.body.toString()).toContain("LARGER_SITE");
    } finally { await cleanupRuns(f); await f.cleanup(); }
  }, 120_000);
});
