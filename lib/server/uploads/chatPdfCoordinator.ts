import type { ParsedDocument } from "../parsing/types";
import type { createAcceptedProviderRequestExecutor } from "../providerRuntime/acceptedRequestExecutor";
import type { ActiveRunControllerRegistry } from "../runs/runExecution";
import { type createChatPdfAttempts } from "./chatPdfAttempts";
import {
  ChatPdfPreparationError, createChatPdfCore, decodeChatPdfArtifact, decodeChatPdfPage,
  encodeChatPdfArtifact, type ChatPdfLocalExtraction, type ChatPdfWorkPlan
} from "./chatPdfCore";
import {
  CHAT_PDF_HEARTBEAT_MS, chatPdfAdmissionFromRow,
  type ChatPdfClaim, type createChatPdfRepository
} from "./chatPdfPersistence";
import type { ChatPdfAttachmentAdmission } from "./chatPdfAdmission";
import type { StorageAdapter } from "./storage";

type Repository = ReturnType<typeof createChatPdfRepository>;
type Attempts = ReturnType<typeof createChatPdfAttempts>;
type Core = ReturnType<typeof createChatPdfCore>;
export type ChatPdfLoadedRun = Awaited<ReturnType<Repository["load"]>>;

export type ChatPdfCoordinatorDependencies = Readonly<{
  attempts: Attempts;
  authorize(claim: ChatPdfClaim): Promise<boolean>;
  continueRun(input: Readonly<{
    claim: ChatPdfClaim; loaded: ChatPdfLoadedRun; releaseRegistry(): void; signal: AbortSignal;
  }>): Promise<void>;
  core?: Core;
  execute: ReturnType<typeof createAcceptedProviderRequestExecutor>;
  fail(claim: ChatPdfClaim, error: ChatPdfPreparationError): Promise<void>;
  registry: ActiveRunControllerRegistry;
  repository: Repository;
  storage: StorageAdapter;
}>;

function boundedOperation<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<Value>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** A single bounded unit per run claim provides backpressure and lets the
 * existing recovery scheduler resume work after restart. It adds no service
 * or global queue: the next claim orders runs by their last durable turn. */
export function createChatPdfCoordinator(deps: ChatPdfCoordinatorDependencies) {
  const core = deps.core ?? createChatPdfCore();
  let pumping: Promise<void> | null = null;

  async function readArtifact<Value>(id: string, attachmentId: string, signal: AbortSignal): Promise<Value> {
    const record = await deps.repository.readArtifact(id, attachmentId);
    const object = await deps.storage.getObject(record.storageKey, { maxBytes: record.byteSize, signal });
    return decodeChatPdfArtifact(object.body, record) as Value;
  }

  async function storeArtifact(claim: ChatPdfClaim, admission: ChatPdfAttachmentAdmission,
    kind: "local" | "page" | "document", pageCount: number, value: unknown, signal: AbortSignal): Promise<string> {
    if (!deps.storage.putObjectStream) throw new ChatPdfPreparationError("pdf_preparation_unavailable");
    const encoded = encodeChatPdfArtifact(value);
    const artifact = await deps.repository.reserveArtifact(claim, {
      admission, byteSize: encoded.body.length, checksum: encoded.checksum, kind, pageCount
    });
    try {
      const writeSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
      await deps.storage.putObjectStream({
        body: new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(encoded.body); controller.close();
        } }), byteSize: encoded.body.length, contentType: "application/json",
        signal: writeSignal, storageKey: artifact.storageKey
      });
      signal.throwIfAborted();
      if (!await deps.repository.acceptArtifact(claim, artifact.id)) {
        throw new ChatPdfPreparationError("pdf_preparation_unavailable");
      }
      return artifact.id;
    } catch (error) {
      await deps.repository.abandonArtifact(artifact.id, artifact.storageKey).catch(() => undefined);
      throw error;
    }
  }

  async function work(claim: ChatPdfClaim, loaded: ChatPdfLoadedRun, signal: AbortSignal): Promise<void> {
    if (!await deps.authorize(claim)) throw new ChatPdfPreparationError("pdf_preparation_unavailable");
    signal.throwIfAborted();
    const preparation = loaded.modelRun.chatPdfAttachments.find((item) => item.state !== "ready");
    if (!preparation) return;
    if (preparation.state === "failed" || preparation.state === "cancelled") {
      throw new ChatPdfPreparationError("pdf_preparation_failed", preparation.retryable);
    }
    const admission = chatPdfAdmissionFromRow(preparation);
    if (admission.route === "direct_pdf") throw new ChatPdfPreparationError("pdf_preparation_invalid");
    if (!preparation.workPlan) {
      const object = await deps.storage.getObject(preparation.attachment.storageKey, {
        maxBytes: admission.byteSize, signal
      });
      const planned = await core.plan({ admission, bytes: object.body,
        onPageCount: (pageCount) => deps.repository.pageCount(claim, preparation.id, pageCount), signal });
      const localArtifactId = await storeArtifact(claim, admission, "local", planned.plan.pageCount,
        planned.local, signal);
      await deps.repository.savePlan(claim, { localArtifactId, plan: planned.plan, preparationId: preparation.id });
      return;
    }
    if (!preparation.localArtifactId) throw new ChatPdfPreparationError("pdf_preparation_invalid");
    const plan = preparation.workPlan as unknown as ChatPdfWorkPlan;
    const local = await readArtifact<ChatPdfLocalExtraction>(preparation.localArtifactId, admission.attachmentId, signal);
    const attempts = await deps.attempts.list(preparation.id);
    if (attempts.some((attempt) => attempt.state === "dispatched" || attempt.state === "ambiguous")) {
      throw new ChatPdfPreparationError("pdf_preparation_ambiguous", true);
    }
    if (attempts.some((attempt) => attempt.state === "settled" && (!attempt.resultArtifactId || attempt.errorCode))) {
      throw new ChatPdfPreparationError("pdf_preparation_invalid", true);
    }
    const pending = plan.units.find((unit) => unit.route === "vision_required" &&
      !attempts.some((attempt) => attempt.page === unit.page && attempt.state === "settled"));
    if (pending) {
      const object = await deps.storage.getObject(preparation.attachment.storageKey, {
        maxBytes: admission.byteSize, signal
      });
      const prepared = await core.page({ admission, bytes: object.body, local, plan, page: pending.page, signal });
      const reserved = await deps.attempts.reserve(claim, {
        page: pending.page, preparationId: preparation.id, requestDigest: prepared.requestDigest, workKey: pending.key
      });
      if (reserved.kind === "ambiguous") throw new ChatPdfPreparationError("pdf_preparation_ambiguous", true);
      if (reserved.kind === "settled") {
        const settled = await readArtifact<{ page: number; text: string }>(reserved.resultArtifactId, admission.attachmentId, signal);
        if (settled.page !== pending.page) throw new ChatPdfPreparationError("pdf_preparation_invalid");
        decodeChatPdfPage(pending.page, settled.text);
        await deps.repository.completedPages(claim, preparation.id);
        return;
      }
      if (!admission.snapshot || !await deps.authorize(claim)) {
        throw new ChatPdfPreparationError("pdf_preparation_unavailable");
      }
      signal.throwIfAborted();
      const dispatch = await deps.attempts.dispatch(claim, reserved.attemptId);
      const providerSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      // Accounting also runs for a late provider resolution after Stop/deadline.
      // Only the live, leased continuation may accept it as a page result.
      const operation = deps.execute(admission.snapshot, prepared.request, {
        signal: providerSignal, timeoutMs: 120_000
      }).then(async (result) => {
        await deps.attempts.recordUsage(dispatch, result.usage);
        return result;
      });
      let result;
      try {
        result = await boundedOperation(operation, providerSignal);
      } catch {
        await deps.attempts.ambiguous(dispatch).catch(() => undefined);
        throw new ChatPdfPreparationError("pdf_preparation_ambiguous", true);
      }
      try {
        decodeChatPdfPage(pending.page, result.finalText);
      } catch {
        await deps.attempts.settle(dispatch, { errorCode: "pdf_preparation_invalid",
          resultArtifactId: null, usage: result.usage });
        throw new ChatPdfPreparationError("pdf_preparation_invalid", true);
      }
      try {
        providerSignal.throwIfAborted();
        const resultArtifactId = await storeArtifact(claim, admission, "page", plan.pageCount,
          { page: pending.page, text: result.finalText }, signal);
        await deps.attempts.settle(dispatch, { resultArtifactId, usage: result.usage });
      } catch {
        await deps.attempts.ambiguous(dispatch).catch(() => undefined);
        throw new ChatPdfPreparationError("pdf_preparation_ambiguous", true);
      }
      await deps.repository.completedPages(claim, preparation.id);
      return;
    }
    // Recompute after a crash between page settlement and progress publication.
    if (admission.route !== "local_text") await deps.repository.completedPages(claim, preparation.id);
    const accepted = await deps.repository.beginAssembly(claim, preparation.id);
    const results: Array<{ page: number; text: string }> = [];
    for (const attempt of accepted) {
      const result = await readArtifact<{ page: number; text: string }>(attempt.resultArtifactId!, admission.attachmentId, signal);
      if (result.page !== attempt.page) throw new ChatPdfPreparationError("pdf_preparation_invalid");
      results.push(result);
    }
    const document: ParsedDocument = core.assemble({ admission, local, plan, results });
    signal.throwIfAborted();
    const id = await storeArtifact(claim, admission, "document", plan.pageCount, document, signal);
    await deps.repository.publishDocument(claim, preparation.id, id);
  }

  async function runOne(): Promise<boolean> {
    const claim = await deps.repository.claim();
    if (!claim) return false;
    const registration = deps.registry.register(claim.runId);
    if (!registration) {
      await deps.repository.release(claim);
      return false;
    }
    const lease = new AbortController();
    const signal = AbortSignal.any([lease.signal, registration.signal]);
    let heartbeatPending = false;
    const timer = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = true;
      void deps.repository.heartbeat(claim).then((active) => {
        if (!active) lease.abort();
      }, () => lease.abort()).finally(() => { heartbeatPending = false; });
    }, CHAT_PDF_HEARTBEAT_MS);
    timer.unref?.();
    try {
      const loaded = await deps.repository.load(claim);
      if (loaded.modelRun.chatPdfAttachments.length === 0) throw new ChatPdfPreparationError("pdf_preparation_invalid");
      if (loaded.modelRun.chatPdfAttachments.every((item) => item.state === "ready")) {
        if (!await deps.authorize(claim)) throw new ChatPdfPreparationError("pdf_preparation_unavailable");
        await deps.continueRun({ claim, loaded, releaseRegistry: registration.release, signal });
      } else {
        await work(claim, loaded, signal);
      }
    } catch (error) {
      await deps.fail(claim, error instanceof ChatPdfPreparationError ? error
        : new ChatPdfPreparationError("pdf_preparation_failed", true));
    } finally {
      clearInterval(timer);
      registration.release();
      await deps.repository.release(claim);
    }
    return true;
  }

  return {
    runOne,
    kick(): void {
      if (pumping) return;
      pumping = (async () => {
        await deps.repository.cleanupAbandonedArtifacts();
        while (await runOne()) { /* Each claim rotates to the least recently served run. */ }
      })().catch(() => undefined).finally(() => { pumping = null; });
    }
  };
}
