import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type WorkspaceSelectedCapture } from "@prisma/client";
import { isSafeWorkspaceRelativePath, isWorkspaceOpaqueId, workspaceRunOutputDirectory } from "@/lib/domain/workspace";
import { readStreamWithAbort } from "../http/byteStream";
import { resolveChatAccess } from "../projects/access";
import { getStoredObjectStream, type StorageAdapter } from "../uploads/storage";
import type { WorkspaceConfig } from "./config";
import type { WorkspaceImageSource } from "./imageCapture";
import { outputIdentities, parseWorkspaceFileSelection, type WorkspaceSelectedFile } from "./outputManifest";
import { lockWorkspaceSession, workspaceRunOperationOwner } from "./sessionOperation";
import type { WorkspaceRuntime, WorkspaceOutputStream } from "./runtime";

const LEASE_MS = 120_000;
const MAX_CAPTURES_PER_RUN = 100;
const MAX_REFERENCES_PER_CAPTURE = 100;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const identifier = () => randomUUID().replaceAll("-", "");

export class WorkspaceCaptureError extends Error {
  constructor(readonly code: "workspace_capture_invalid" | "workspace_capture_unavailable" | "workspace_capture_busy" |
    "workspace_capture_stale" | "workspace_capture_limit_exceeded") {
    super(code);
    this.name = "WorkspaceCaptureError";
  }
}
const unavailable = () => new WorkspaceCaptureError("workspace_capture_unavailable");
const stale = () => new WorkspaceCaptureError("workspace_capture_stale");
const invalid = () => new WorkspaceCaptureError("workspace_capture_invalid");
const limit = () => new WorkspaceCaptureError("workspace_capture_limit_exceeded");

/** Current accepted consumer identity; no runtime, storage or producer authority comes from its caller. */
export type WorkspaceCaptureConsumer = Readonly<{ runId: string; userId: string; consumerKey: string }>;
export type WorkspaceCaptureReference = WorkspaceCaptureConsumer & Readonly<{ captureId: string }>;
export type WorkspaceCaptureDescriptor = Readonly<{
  id: string;
  readiness: "captured" | "durable";
  files: readonly Readonly<{
    relativePath: string; byteSize: number; checksum: string; mimeType: string; readiness: "captured" | "durable";
  }>[];
}>;

function consumer(input: WorkspaceCaptureConsumer): void {
  if (!isWorkspaceOpaqueId(input.runId) || !isWorkspaceOpaqueId(input.userId) || !isWorkspaceOpaqueId(input.consumerKey)) throw invalid();
}
function reference(input: WorkspaceCaptureReference): void {
  consumer(input);
  if (!/^[a-f0-9]{32}$/u.test(input.captureId)) throw invalid();
}

/** Application owner for selected capture authority, immutable metadata and shared private retention. */
export function createWorkspaceSelectedCaptures(deps: Readonly<{
  prisma: PrismaClient;
  runtime: WorkspaceRuntime;
  storage: StorageAdapter;
  config: WorkspaceConfig;
}>) {
  const { prisma, runtime, storage, config } = deps;

  async function authority(tx: Prisma.TransactionClient, input: WorkspaceCaptureConsumer, active = true) {
    consumer(input);
    const observed = await tx.modelRun.findUnique({ where: { id: input.runId }, select: {
      chatId: true, chat: { select: { projectId: true } }, workspaceRunBinding: { select: { workspaceSessionId: true } }
    } });
    if (!observed?.workspaceRunBinding) throw stale();
    // Match settlement locks from the outset: concurrent readers must not
    // acquire shared authority and then deadlock upgrading Chat or its owner.
    if (observed.chat.projectId) await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${observed.chat.projectId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${observed.chatId} FOR UPDATE`;
    const session = await lockWorkspaceSession(tx, observed.workspaceRunBinding.workspaceSessionId);
    const run = await tx.modelRun.findUnique({ where: { id: input.runId }, select: {
      id: true, userId: true, chatId: true, status: true, workspaceRunBinding: { select: { modelRunId: true } },
      chat: { select: { permanentDeletionAt: true, archived: true } }
    } });
    if (!run || run.userId !== input.userId || !run.workspaceRunBinding || !session || run.chatId !== session.chatId ||
      run.chat.permanentDeletionAt || run.chat.archived ||
      !await tx.user.findFirst({ where: { id: input.userId, status: "active" }, select: { id: true } }) ||
      !await resolveChatAccess(tx, { chatId: run.chatId, userId: input.userId, requireMutable: true, minimumProjectRole: "CONTRIBUTOR" })) throw stale();
    // Run ownership has no timed lease; export workers use operationExpiresAt.
    if (active && (!["in_progress", "streaming"].includes(run.status) || session.operationOwner !== workspaceRunOperationOwner(run.id) ||
      session.state === "DELETING" || session.state === "FAILED")) throw stale();
    return { run, session, operation: { generation: session.version, owner: session.operationOwner ?? "" } };
  }

  async function lockedCapture(tx: Prisma.TransactionClient, input: WorkspaceCaptureReference, active = true) {
    reference(input);
    const current = await authority(tx, input, active);
    await tx.$queryRaw`SELECT "id" FROM "WorkspaceSelectedCapture" WHERE "id" = ${input.captureId} FOR UPDATE`;
    const capture = await tx.workspaceSelectedCapture.findUnique({ where: { id: input.captureId }, include: {
      binding: { select: { modelRun: { select: { chatId: true } } } }
    } });
    if (!capture || capture.binding.modelRun.chatId !== current.run.chatId) throw unavailable();
    return { ...current, capture };
  }

  const key = (input: WorkspaceCaptureReference) => ({ captureId: input.captureId, consumerRunId: input.runId, consumerKey: input.consumerKey });
  async function referenced(tx: Prisma.TransactionClient, input: WorkspaceCaptureReference, active = true) {
    const current = await lockedCapture(tx, input, active);
    const retained = await tx.workspaceCaptureReference.findUnique({ where: { captureId_consumerRunId_consumerKey: key(input) } });
    if (current.capture.state === "RELEASED" || !retained || retained.releasedAt) throw unavailable();
    return current;
  }

  async function descriptor(tx: Prisma.TransactionClient, capture: WorkspaceSelectedCapture): Promise<WorkspaceCaptureDescriptor> {
    if (capture.state !== "CAPTURED") throw unavailable();
    const files = await tx.workspaceCapturedFile.findMany({ where: { captureId: capture.id }, orderBy: { relativePath: "asc" }, take: config.outputMaxFiles + 1 });
    if (!files.length || files.length > config.outputMaxFiles) throw unavailable();
    return { id: capture.id, readiness: files.every(file => file.storageState === "READY") ? "durable" : "captured",
      files: files.map(file => ({ relativePath: file.relativePath, byteSize: file.byteSize, checksum: file.checksum,
        mimeType: file.mimeType, readiness: file.storageState === "READY" ? "durable" : "captured" })) };
  }

  const runtimeInput = (capture: WorkspaceSelectedCapture, current: Awaited<ReturnType<typeof authority>>, signal?: AbortSignal) => {
    if (capture.workspaceSessionId !== current.session.id || capture.runtimeSandboxId !== current.session.runtimeSandboxId) throw unavailable();
    return { capture: { id: capture.id, create: false }, modelRunId: capture.modelRunId,
      outputDirectory: workspaceRunOutputDirectory(capture.modelRunId),
      runtimeSandboxId: capture.runtimeSandboxId, sessionId: capture.workspaceSessionId, operation: current.operation,
      selection: parseWorkspaceFileSelection(capture.selection, config.outputMaxFiles), signal };
  };

  async function releaseBatch(outputs: readonly WorkspaceOutputStream[], input: { runtimeSandboxId: string; sessionId: string; operation: { generation: number; owner: string } }) {
    await Promise.allSettled(outputs.map(output => output.body.cancel()));
    const ids = [...new Set(outputs.flatMap(output => output.batchId ? [output.batchId] : []))];
    await Promise.allSettled(ids.map(batchId => runtime.releaseOutputs?.({ ...input, batchId })));
  }

  async function lookup(input: WorkspaceCaptureReference): Promise<WorkspaceCaptureDescriptor> {
    return prisma.$transaction(async tx => descriptor(tx, (await referenced(tx, input)).capture));
  }

  async function create(input: WorkspaceCaptureConsumer & Readonly<{
    requestKey: string; files: readonly WorkspaceSelectedFile[]; signal?: AbortSignal;
  }>): Promise<WorkspaceCaptureDescriptor> {
    if (!isWorkspaceOpaqueId(input.requestKey)) throw invalid();
    const reserved = await prisma.$transaction(async tx => {
      const current = await authority(tx, input);
      if (!current.session.runtimeSandboxId) throw unavailable();
      const selection = parseWorkspaceFileSelection({ files: input.files, producerOperation: current.operation }, config.outputMaxFiles);
      const requestHash = digest(JSON.stringify(selection));
      let capture = await tx.workspaceSelectedCapture.findUnique({ where: { modelRunId_requestKey: { modelRunId: input.runId, requestKey: input.requestKey } } });
      const created = !capture;
      if (capture) {
        if (capture.requestHash !== requestHash || capture.state === "RELEASED") throw unavailable();
        const retained = await tx.workspaceCaptureReference.findUnique({ where: { captureId_consumerRunId_consumerKey: {
          captureId: capture.id, consumerRunId: input.runId, consumerKey: input.consumerKey
        } } });
        if (!retained || retained.releasedAt) throw unavailable();
      } else {
        if (await tx.workspaceSelectedCapture.count({ where: { modelRunId: input.runId } }) >= MAX_CAPTURES_PER_RUN) throw limit();
        capture = await tx.workspaceSelectedCapture.create({ data: {
          id: identifier(), modelRunId: input.runId, workspaceSessionId: current.session.id, runtimeSandboxId: current.session.runtimeSandboxId,
          requestKey: input.requestKey, requestHash, producerGeneration: current.operation.generation, producerOwner: current.operation.owner,
          selection: JSON.parse(JSON.stringify(selection)) as Prisma.InputJsonValue,
          references: { create: { consumerRunId: input.runId, consumerKey: input.consumerKey } }
        } });
      }
      return { current, capture, created };
    });
    if (reserved.capture.state === "CAPTURED") return lookup({ ...input, captureId: reserved.capture.id });
    const args = { ...runtimeInput(reserved.capture, reserved.current, input.signal), capture: { id: reserved.capture.id, create: reserved.created } };
    // A replay has create:false even when the first attempt never reached the
    // runner. It can recover committed bytes, never re-read a mutable path.
    const outputs = await runtime.collectOutputs(args);
    try {
      const identities = outputIdentities(outputs, config, true);
      const selected = args.selection.files.map(file => `${file.root}/${file.relativePath}`).sort();
      if (JSON.stringify(identities.map(file => file.relativePath)) !== JSON.stringify(selected)) throw unavailable();
      input.signal?.throwIfAborted();
      return await prisma.$transaction(async tx => {
        const { capture } = await referenced(tx, { ...input, captureId: reserved.capture.id });
        input.signal?.throwIfAborted();
        if (capture.state === "CAPTURED") return descriptor(tx, capture);
        await tx.workspaceCapturedFile.createMany({ data: identities.map(identity => ({ ...identity, captureId: capture.id })) });
        const sealed = await tx.workspaceSelectedCapture.update({ where: { id: capture.id }, data: { state: "CAPTURED", sealedAt: new Date() } });
        return descriptor(tx, sealed);
      });
    } finally { await releaseBatch(outputs, args); }
  }

  async function acquire(input: WorkspaceCaptureReference): Promise<WorkspaceCaptureDescriptor> {
    return prisma.$transaction(async tx => {
      const { capture } = await lockedCapture(tx, input);
      if (capture.state !== "CAPTURED") throw unavailable();
      const existing = await tx.workspaceCaptureReference.findUnique({ where: { captureId_consumerRunId_consumerKey: key(input) } });
      if (existing?.releasedAt) throw unavailable();
      if (!existing) {
        const live = await tx.workspaceCaptureReference.count({ where: { captureId: capture.id, releasedAt: null } });
        if (!live) throw unavailable();
        if (await tx.workspaceCaptureReference.count({ where: { captureId: capture.id } }) >= MAX_REFERENCES_PER_CAPTURE) throw limit();
        await tx.workspaceCaptureReference.create({ data: key(input) });
      }
      return descriptor(tx, capture);
    });
  }

  async function releaseSpool(input: WorkspaceCaptureReference): Promise<void> {
    const eligible = await prisma.$transaction(async tx => {
      const current = await lockedCapture(tx, input, false);
      if (current.capture.state !== "RELEASED" || await tx.workspaceCaptureReadLease.count({
        where: { captureId: input.captureId, expiresAt: { gt: new Date() } }
      }) || !current.session.operationOwner || current.session.runtimeSandboxId !== current.capture.runtimeSandboxId) return null;
      return current;
    });
    if (eligible) await runtime.releaseOutputCapture?.({ captureId: input.captureId, modelRunId: eligible.capture.modelRunId,
      sessionId: eligible.capture.workspaceSessionId, runtimeSandboxId: eligible.capture.runtimeSandboxId, operation: eligible.operation });
  }

  async function release(input: WorkspaceCaptureReference): Promise<void> {
    await prisma.$transaction(async tx => {
      const { capture } = await lockedCapture(tx, input, false);
      await tx.workspaceCaptureReference.updateMany({ where: { ...key(input), releasedAt: null }, data: { releasedAt: new Date() } });
      if (capture.state !== "RELEASED" && !await tx.workspaceCaptureReference.count({ where: { captureId: capture.id, releasedAt: null } })) {
        await tx.workspaceSelectedCapture.update({ where: { id: capture.id }, data: { state: "RELEASED", releasedAt: new Date() } });
      }
    });
    // Failure leaves the durable release tombstone for a retry and exact-session
    // cleanup; it cannot revoke another reference or resurrect the capture.
    await releaseSpool(input);
  }

  async function openFile(input: WorkspaceCaptureReference & Readonly<{ relativePath: string; signal?: AbortSignal }>): Promise<ReadableStream<Uint8Array>> {
    if (!isSafeWorkspaceRelativePath(input.relativePath)) throw invalid();
    const lease = await prisma.$transaction(async tx => {
      const current = await referenced(tx, input);
      if (current.capture.state !== "CAPTURED") throw unavailable();
      const file = await tx.workspaceCapturedFile.findUnique({ where: { captureId_relativePath: { captureId: input.captureId, relativePath: input.relativePath } } });
      if (!file) throw unavailable();
      if (await tx.workspaceCaptureReadLease.count({ where: { captureId: input.captureId, expiresAt: { gt: new Date() } } }) >= 16) throw limit();
      const token = randomUUID();
      await tx.workspaceCaptureReadLease.create({ data: { token, captureId: input.captureId, expiresAt: new Date(Date.now() + LEASE_MS) } });
      return { ...current, file, token };
    });
    const deadline = AbortSignal.timeout(LEASE_MS);
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
    const validateRead = () => prisma.$transaction(async tx => {
      await authority(tx, input);
      // A release cannot revoke a reader already admitted under its lease.
      // Stop, access loss, parent deletion and expiry still fence delivery.
      if (!await tx.workspaceCaptureReadLease.findFirst({ where: {
        token: lease.token, captureId: input.captureId, expiresAt: { gt: new Date() }
      }, select: { token: true } })) throw unavailable();
      signal.throwIfAborted();
    });
    let outputs: readonly WorkspaceOutputStream[] = [];
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let closed = false;
    let didOpen!: () => void;
    const opened = new Promise<void>(resolve => { didOpen = resolve; });
    let finishing: Promise<void> | undefined;
    const finish = () => finishing ??= (async () => {
      closed = true;
      signal.removeEventListener("abort", abort);
      // An abort during the asynchronous open must still cancel a late stream
      // before releasing its durable read lease.
      await opened;
      if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (outputs.length) await releaseBatch(outputs, { runtimeSandboxId: lease.capture.runtimeSandboxId, sessionId: lease.capture.workspaceSessionId, operation: lease.operation });
      await prisma.workspaceCaptureReadLease.deleteMany({ where: { token: lease.token } });
      await releaseSpool(input).catch(() => undefined);
    })();
    const abort = () => { void finish().catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      if (lease.file.storageState === "READY" && lease.file.storageKey) {
        const object = await getStoredObjectStream(storage, lease.file.storageKey, { maxBytes: Math.max(1, lease.file.byteSize), requireStreaming: true, signal });
        reader = object.body.getReader();
        if (object.byteSize !== lease.file.byteSize) throw unavailable();
      } else {
        outputs = await runtime.collectOutputs(runtimeInput(lease.capture, lease, signal));
        const output = outputs.find(item => item.relativePath === input.relativePath);
        if (!output || output.byteSize !== lease.file.byteSize || output.checksum !== lease.file.checksum) throw unavailable();
        reader = output.body.getReader();
      }
      signal.throwIfAborted();
      await validateRead();
      didOpen();
      const hash = createHash("sha256");
      let total = 0;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            signal.throwIfAborted();
            if (closed) throw unavailable();
            await validateRead();
            const next = await readStreamWithAbort(() => reader!.read(), signal);
            await validateRead();
            if (next.done) {
              if (total !== lease.file.byteSize || hash.digest("hex") !== lease.file.checksum) throw unavailable();
              await finish(); controller.close(); return;
            }
            total += next.value.byteLength;
            if (total > lease.file.byteSize) throw unavailable();
            hash.update(next.value); controller.enqueue(next.value);
          } catch (error) { await finish().catch(() => undefined); controller.error(error); }
        },
        cancel: finish
      }, { highWaterMark: 0 });
    } catch (error) { didOpen(); await finish().catch(() => undefined); throw error; }
  }

  async function retain(input: WorkspaceCaptureReference & Readonly<{ signal?: AbortSignal }>): Promise<WorkspaceCaptureDescriptor> {
    if (!storage.putObjectStream || !storage.inspectObject) throw unavailable();
    const manifest = await lookup(input);
    // The shared streaming adapter requires positive lengths. Empty files are
    // valid captured evidence, but cannot claim durable readiness through an
    // unbounded, non-cancellable putObject fallback.
    if (manifest.files.some(file => file.byteSize === 0)) throw unavailable();
    for (const file of manifest.files) {
      input.signal?.throwIfAborted();
      const attempt = await prisma.$transaction(async tx => {
        await referenced(tx, input);
        const row = await tx.workspaceCapturedFile.findUniqueOrThrow({ where: { captureId_relativePath: { captureId: input.captureId, relativePath: file.relativePath } } });
        if (row.storageState === "READY") return null;
        if (row.storageState === "STORING" && row.storageLeaseExpiresAt && row.storageLeaseExpiresAt.getTime() > Date.now()) {
          throw new WorkspaceCaptureError("workspace_capture_busy");
        }
        const token = randomUUID();
        const storageKey = `workspace-captures/${input.captureId}/${row.id}/${identifier()}`;
        // Each attempt owns a different writable key. An unknown prior upload
        // retains its deletion obligation and can never overwrite canonical bytes.
        await tx.attachmentDeletionJob.create({ data: { storageKey, claimToken: token, claimedAt: new Date() } });
        await tx.workspaceCapturedFile.update({ where: { id: row.id }, data: {
          storageKey, storageState: "STORING", storageToken: token, storageLeaseExpiresAt: new Date(Date.now() + LEASE_MS)
        } });
        return { token, storageKey, id: row.id };
      });
      if (!attempt) continue;
      const timeout = AbortSignal.timeout(LEASE_MS);
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      try {
        const body = await openFile({ ...input, relativePath: file.relativePath, signal });
        try {
          await storage.putObjectStream!({ body, byteSize: file.byteSize, checksum: file.checksum,
            contentType: file.mimeType, storageKey: attempt.storageKey, signal });
        } finally { await body.cancel().catch(() => undefined); }
        const inspected = await storage.inspectObject!(attempt.storageKey, { maxBytes: Math.max(1, file.byteSize), requireStreaming: true, signal });
        if (inspected.byteSize !== file.byteSize || inspected.checksum !== file.checksum) throw unavailable();
        signal.throwIfAborted();
        await prisma.$transaction(async tx => {
          await referenced(tx, input);
          const jobs = await tx.$queryRaw<Array<{ claimToken: string | null }>>`
            SELECT "claimToken" FROM "AttachmentDeletionJob" WHERE "storageKey" = ${attempt.storageKey} FOR UPDATE`;
          if (jobs[0]?.claimToken !== attempt.token) throw stale();
          signal.throwIfAborted();
          const settled = await tx.workspaceCapturedFile.updateMany({ where: {
            id: attempt.id, storageKey: attempt.storageKey, storageToken: attempt.token, storageState: "STORING",
            storageLeaseExpiresAt: { gt: new Date() }
          }, data: { storageState: "READY", storageToken: null, storageLeaseExpiresAt: null } });
          if (settled.count !== 1) throw stale();
          // Keep the obligation; reference-aware retention activates it after
          // release/deletion, including a cascade with no application process.
          await tx.attachmentDeletionJob.update({ where: { storageKey: attempt.storageKey }, data: { claimedAt: null, claimToken: null } });
        });
      } catch (error) {
        // Leave the bounded upload lease and obligation intact. A timeout can
        // leave an uncertain storage outcome; it never authorizes a ready result.
        throw error instanceof WorkspaceCaptureError ? error : unavailable();
      }
    }
    return lookup(input);
  }

  async function imageSource(input: WorkspaceCaptureReference & Readonly<{ relativePath: string }>): Promise<WorkspaceImageSource> {
    const file = (await lookup(input)).files.find(item => item.relativePath === input.relativePath);
    if (!file) throw unavailable();
    return { captureId: input.captureId, relativePath: file.relativePath, byteSize: file.byteSize, checksum: file.checksum,
      async assertAccess() { await lookup(input); }, open: signal => openFile({ ...input, signal }) };
  }

  /** Consumer-owned publication can atomically link these already retained
   * objects. No storage I/O, model dispatch or guest work belongs in commit. */
  async function settleRetained<T>(input: WorkspaceCaptureReference, commit: (tx: Prisma.TransactionClient, files: readonly Readonly<{
    relativePath: string; byteSize: number; checksum: string; mimeType: string; storageKey: string;
  }>[]) => Promise<T>, options: { allowEndedRun?: boolean } = {}): Promise<T> {
    return prisma.$transaction(async tx => {
      const { capture } = await referenced(tx, input, !options.allowEndedRun);
      if (capture.state !== "CAPTURED") throw unavailable();
      const files = await tx.workspaceCapturedFile.findMany({ where: { captureId: capture.id }, orderBy: { relativePath: "asc" } });
      if (!files.length || files.some(file => file.storageState !== "READY" || !file.storageKey)) throw unavailable();
      return commit(tx, files.map(file => ({ relativePath: file.relativePath, byteSize: file.byteSize,
        checksum: file.checksum, mimeType: file.mimeType, storageKey: file.storageKey! })));
    });
  }

  return { create, acquire, lookup, openFile, retain, release, imageSource, settleRetained };
}
