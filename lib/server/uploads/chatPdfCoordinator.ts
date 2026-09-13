import { mergeTokenUsage, normalizeTokenUsage } from "../../domain/usage";
import { bindContext, logEvent, reportSubsystemFailure, reportSubsystemHealthy, runInBackground, runWithContext } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { observedFailure } from "../providers/providerObservability";
import { observeChatPdfPersistence } from "./chatPdfPersistenceObservability";
import type { ParsedDocument } from "../parsing/types";
import { isSharedPdfOcrParserVersion } from "../parsing/pdfOcrPipeline";
import { effectiveProviderResponseTimeoutMs } from "../providers/providerConfiguration";
import { DocumentParserError } from "../parsing/errors";
import { isProviderDeadlineExceededError } from "../providers/network";
import { isRetryableProviderHttpStatus, isRetryableProviderNetworkError } from "../providers/providerRetry";
import type { createAcceptedProviderRequestExecutor } from "../providerRuntime/acceptedRequestExecutor";
import type { ActiveRunControllerRegistry } from "../runs/runExecution";
import { type createChatPdfAttempts } from "./chatPdfAttempts";
import {
  ChatPdfPreparationError, createChatPdfCore, decodeChatPdfArtifact, decodeChatPdfPage,
  encodeChatPdfArtifact, validateChatPdfSource, type ChatPdfLocalExtraction, type ChatPdfWorkPlan
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
      if (!await observeChatPdfPersistence(claim.runId, "publish", () => deps.repository.acceptArtifact(claim, artifact.id))) {
        throw new ChatPdfPreparationError("pdf_preparation_unavailable");
      }
      return artifact.id;
    } catch (error) {
      logEvent("job_attempt", { subsystem: "pdf", stage: "write", outcome: signal.aborted ? "cancelled"
        : error instanceof ChatPdfPreparationError && error.code === "pdf_preparation_unavailable" ? "stale" : "failed",
        code: observedFailure(error, signal).code, action: "release" });
      await observeChatPdfPersistence(claim.runId, "cleanup", () => deps.repository.abandonArtifact(artifact.id, artifact.storageKey)).catch(() => undefined);
      throw error;
    }
  }

  async function prepareAttachment(claim: ChatPdfClaim,
    preparation: ChatPdfLoadedRun["modelRun"]["chatPdfAttachments"][number], signal: AbortSignal): Promise<void> {
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
        acceptedCompatibilityKey: preparation.compatibilityKey,
        onPageCount: (pageCount) => deps.repository.pageCount(claim, preparation.id, pageCount), signal });
      const localArtifactId = await storeArtifact(claim, admission, "local", planned.plan.pageCount,
        planned.local, signal);
      await observeChatPdfPersistence(claim.runId, "prepare", () => deps.repository.savePlan(claim, { localArtifactId, plan: planned.plan, preparationId: preparation.id }));
      return;
    }
    if (!preparation.localArtifactId) throw new ChatPdfPreparationError("pdf_preparation_invalid");
    const plan = preparation.workPlan as unknown as ChatPdfWorkPlan;
    const local = await readArtifact<ChatPdfLocalExtraction>(preparation.localArtifactId, admission.attachmentId, signal);
    const attempts = await deps.attempts.list(preparation.id);
    if (attempts.some((attempt) => attempt.errorCode === "pdf_transcription_failed" &&
      (attempt.state === "settled" || attempt.state === "ambiguous"))) {
      throw new ChatPdfPreparationError("pdf_transcription_failed", true);
    }
    if (attempts.some((attempt) => attempt.state === "dispatched" || attempt.state === "ambiguous")) {
      throw new ChatPdfPreparationError("pdf_preparation_ambiguous", true);
    }
    if (attempts.some((attempt) => attempt.state === "settled" && (!attempt.resultArtifactId || attempt.errorCode))) {
      throw new ChatPdfPreparationError("pdf_preparation_invalid", true);
    }
    const pending = plan.units.find((unit) => unit.route !== "native_only" &&
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
        logEvent("run_recovery", { subsystem: "pdf", stage: "recovery", outcome: "completed", action: "skip" });
        const settled = await readArtifact<{ page: number; text: string }>(reserved.resultArtifactId, admission.attachmentId, signal);
        if (settled.page !== pending.page) throw new ChatPdfPreparationError("pdf_preparation_invalid");
        decodeChatPdfPage(pending.page, settled.text, plan.parserVersion, admission.route);
        await deps.repository.completedPages(claim, preparation.id);
        return;
      }
      if (!admission.snapshot || !await deps.authorize(claim)) {
        throw new ChatPdfPreparationError("pdf_preparation_unavailable");
      }
      signal.throwIfAborted();
      const dispatch = await observeChatPdfPersistence(claim.runId, "dispatch", () => deps.attempts.dispatch(claim, reserved.attemptId));
      logEvent("job_attempt", { subsystem: "pdf", stage: "dispatch", outcome: "started" });
      const responseTimeoutMs = isSharedPdfOcrParserVersion(plan.parserVersion)
        ? effectiveProviderResponseTimeoutMs(admission.snapshot.connection,
          admission.snapshot.model.adapterKind === "fake" ? null : admission.snapshot.model)
        : 120_000;
      const providerSignal = AbortSignal.any([signal, AbortSignal.timeout(responseTimeoutMs)]);
      // Accounting also runs for a late provider resolution after Stop/deadline.
      // Only the live, leased continuation may accept it as a page result.
      let observedUsage = normalizeTokenUsage({});
      const operation = deps.execute(admission.snapshot, prepared.request, {
        onUsage(value) { observedUsage = mergeTokenUsage(observedUsage, value); },
        signal: providerSignal, timeoutMs: responseTimeoutMs
      }).then(async (result) => {
        const usage = mergeTokenUsage(observedUsage, result.usage);
        await observeChatPdfPersistence(claim.runId, "settle", () => deps.attempts.recordUsage(dispatch, usage));
        return { ...result, usage };
      }, async (error: unknown) => {
        const failure = observedFailure(error, providerSignal);
        logEvent("job_attempt", { subsystem: "pdf", stage: "dispatch", outcome: signal.aborted ? "cancelled" : "failed",
          code: failure.code, httpStatus: failure.httpStatus, action: "stop" });
        await observeChatPdfPersistence(claim.runId, "settle", () => deps.attempts.recordUsage(dispatch, normalizeTokenUsage({ ...observedUsage, completeness: "partial" })));
        throw error;
      });
      let result;
      try {
        result = await boundedOperation(operation, providerSignal);
      } catch (error) {
        const status = typeof error === "object" && error !== null && "status" in error
          && typeof error.status === "number" ? error.status : null;
        const transcriptionFailure = !signal.aborted && (providerSignal.aborted ||
          isProviderDeadlineExceededError(error) || isRetryableProviderNetworkError(error) ||
          isRetryableProviderHttpStatus(status));
        const code = transcriptionFailure ? "pdf_transcription_failed" : "pdf_preparation_ambiguous";
        logEvent("job_attempt", { subsystem: "pdf", stage: "process", outcome: signal.aborted ? "cancelled" : "failed", code, action: "stop" });
        await observeChatPdfPersistence(claim.runId, "settle", () => deps.attempts.ambiguous(dispatch, code));
        throw new ChatPdfPreparationError(code, true);
      }
      try {
        decodeChatPdfPage(pending.page, result.finalText, plan.parserVersion, admission.route);
      } catch {
        logEvent("job_attempt", { subsystem: "pdf", stage: "validate", outcome: "failed", code: "pdf_transcription_failed", action: "stop" });
        await observeChatPdfPersistence(claim.runId, "settle", () => deps.attempts.settle(dispatch, { errorCode: "pdf_transcription_failed",
          resultArtifactId: null, usage: result.usage }));
        throw new ChatPdfPreparationError("pdf_transcription_failed", true);
      }
      try {
        providerSignal.throwIfAborted();
        const resultArtifactId = await storeArtifact(claim, admission, "page", plan.pageCount,
          { page: pending.page, text: result.finalText }, signal);
        await observeChatPdfPersistence(claim.runId, "settle", () => deps.attempts.settle(dispatch, { resultArtifactId, usage: result.usage }));
      } catch (error) {
        logEvent("job_attempt", { subsystem: "pdf", stage: "publish", outcome: signal.aborted ? "cancelled"
          : error instanceof ChatPdfPreparationError && error.code === "pdf_preparation_unavailable" ? "stale" : "failed",
          code: observedFailure(error, signal).code, prisma_code: databaseFailureCode(error), action: "stop" });
        await observeChatPdfPersistence(claim.runId, "settle", () => deps.attempts.ambiguous(dispatch)).catch(() => undefined);
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
    await observeChatPdfPersistence(claim.runId, "publish", () => deps.repository.publishDocument(claim, preparation.id, id));
  }

  async function work(claim: ChatPdfClaim, loaded: ChatPdfLoadedRun, signal: AbortSignal): Promise<void> {
    const preparation = loaded.modelRun.chatPdfAttachments.find((item) =>
      item.state !== "ready" && item.state !== "original_only");
    if (!preparation) return;
    try {
      await prepareAttachment(claim, preparation, signal);
    } catch (error) {
      const code = error instanceof ChatPdfPreparationError && error.code === "pdf_local_text_unusable"
        ? error.code : error instanceof ChatPdfPreparationError && error.code === "pdf_transcription_failed" ||
          error instanceof DocumentParserError && ["parser_timeout", "parser_unavailable"].includes(error.code)
          ? "pdf_transcription_failed" : null;
      if (!code || !loaded.modelRun.workspaceRunBinding || signal.aborted) throw error;
      logEvent("job_attempt", { subsystem: "pdf", stage: "process", outcome: "failed", code: observedFailure(error).code, action: "degrade" });
      if (!await deps.authorize(claim)) throw new ChatPdfPreparationError("pdf_preparation_unavailable");
      // Re-read the original before admitting the degraded outcome. Storage,
      // integrity, access and cancellation failures never become OCR failures.
      const admission = chatPdfAdmissionFromRow(preparation);
      const original = await deps.storage.getObject(preparation.attachment.storageKey, {
        maxBytes: admission.byteSize, signal
      });
      validateChatPdfSource(original.body, admission);
      signal.throwIfAborted();
      await observeChatPdfPersistence(claim.runId, "complete", () => deps.repository.useWorkspaceOriginal(claim, preparation.id, code));
      logEvent("job_attempt", { subsystem: "pdf", stage: "process", outcome: "degraded", code, action: "degrade" });
    }
  }

  async function runOne(): Promise<boolean> {
    const claim = await runInBackground(async () => {
      try {
        const value = await deps.repository.claim();
        reportSubsystemHealthy("pdf", "claim");
        return value;
      } catch (error) {
        reportSubsystemFailure({ subsystem: "pdf", stage: "claim", code: observedFailure(error).code,
          prisma_code: databaseFailureCode(error), action: "retry" });
        throw error;
      }
    });
    if (!claim) return false;
    return runInBackground(() => runWithContext({ run_id: claim.runId }, () => processClaim(claim)));
  }

  async function processClaim(claim: ChatPdfClaim): Promise<boolean> {
    const started = performance.now();
    logEvent("job_attempt", { subsystem: "pdf", stage: "claim", outcome: "started" });
    const registration = deps.registry.register(claim.runId);
    if (!registration) {
      logEvent("job_attempt", { subsystem: "pdf", stage: "claim", outcome: "stale", action: "release" });
      await observeChatPdfPersistence(claim.runId, "release", () => deps.repository.release(claim));
      return false;
    }
    const lease = new AbortController();
    const signal = AbortSignal.any([lease.signal, registration.signal]);
    let heartbeatPending = false;
    const timer = setInterval(bindContext(() => {
      if (heartbeatPending) return;
      heartbeatPending = true;
      void deps.repository.heartbeat(claim).then((active) => {
        if (!active) {
          if (!lease.signal.aborted) logEvent("job_attempt", { subsystem: "pdf", stage: "heartbeat", outcome: "lost_lease", action: "stop" });
          lease.abort();
        } else reportSubsystemHealthy("pdf", "heartbeat");
      }, (error: unknown) => {
        reportSubsystemFailure({ subsystem: "pdf", stage: "heartbeat", prisma_code: databaseFailureCode(error), action: "stop" });
        lease.abort();
      }).finally(() => { heartbeatPending = false; });
    }), CHAT_PDF_HEARTBEAT_MS);
    timer.unref?.();
    try {
      const loaded = await deps.repository.load(claim);
      if (loaded.modelRun.chatPdfAttachments.length === 0) throw new ChatPdfPreparationError("pdf_preparation_invalid");
      if (!await deps.authorize(claim)) throw new ChatPdfPreparationError("pdf_preparation_unavailable");
      signal.throwIfAborted();
      if (loaded.modelRun.chatPdfAttachments.every((item) => item.state === "ready" || item.state === "original_only")) {
        logEvent("run_recovery", { subsystem: "pdf", stage: "continuation", outcome: "started" });
        await deps.continueRun({ claim, loaded, releaseRegistry: registration.release, signal });
      } else {
        await work(claim, loaded, signal);
      }
      logEvent("job_attempt", { subsystem: "pdf", stage: "process", outcome: "completed", duration_ms: performance.now() - started });
    } catch (error) {
      logEvent("job_attempt", { subsystem: "pdf", stage: "process", outcome: registration.signal.aborted ? "cancelled" : lease.signal.aborted ? "lost_lease"
        : error instanceof ChatPdfPreparationError && error.code === "pdf_preparation_unavailable" ? "stale" : "failed",
        code: observedFailure(error).code, prisma_code: databaseFailureCode(error), duration_ms: performance.now() - started, action: "stop" });
      try {
        await deps.fail(claim, error instanceof ChatPdfPreparationError ? error
          : new ChatPdfPreparationError("pdf_preparation_failed", true));
      } catch (settlementError) {
        logEvent("job_attempt", { subsystem: "pdf", stage: "fail", outcome: "failed",
          code: observedFailure(settlementError).code, prisma_code: databaseFailureCode(settlementError), action: "wait" });
        throw settlementError;
      }
    } finally {
      clearInterval(timer);
      registration.release();
      await observeChatPdfPersistence(claim.runId, "release", () => deps.repository.release(claim));
    }
    return true;
  }

  return {
    runOne,
    kick(): void {
      if (pumping) return;
      pumping = runInBackground(async () => {
        try {
          await deps.repository.cleanupAbandonedArtifacts();
          reportSubsystemHealthy("pdf", "cleanup");
        } catch (error) {
          reportSubsystemFailure({ subsystem: "pdf", stage: "cleanup", prisma_code: databaseFailureCode(error), action: "retry" });
          throw error;
        }
        while (await runOne()) { /* Each claim rotates to the least recently served run. */ }
      }).catch(() => undefined).finally(() => { pumping = null; });
    }
  };
}
