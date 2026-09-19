import type { PrismaClient } from "@prisma/client";
import { JEV_MODEL_ID, JEV_SERVED_MODEL_ID } from "../../domain/decisionModels";
import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { DecisionAdapterError, type DecisionAnswer, type DecisionReceipt, type DecisionRequest, type DecisionResult } from "../providers/decisions";
import { ProviderAdmissionError } from "./admission";
import { createAcceptedDecisionRuntime, type AcceptedDecisionRuntimeBinding, type AcceptedDecisionRuntimeEvidence } from "./decisionRuntime";
import { createOptionalDecisionRepository, optionalDecisionInputHash, type OptionalDecisionOwner, type OptionalDecisionRepository, type OptionalDecisionSettlement } from "./optionalDecisionRepository";

// Optional interactive assistance has its own wait bound. Expiry preserves
// ordinary selection, while a late receipt may still settle the same charge.
export const OPTIONAL_DECISION_TIMEOUT_MS = 4_000;
export type OptionalDecisionAdmission = (snapshot: ProviderExecutionSnapshot) => Promise<Readonly<{
  settle(result: OptionalDecisionSettlement): Promise<void>;
}>>;
export type OptionalDecisionInput = Readonly<{
  owner: OptionalDecisionOwner;
  evidence: AcceptedDecisionRuntimeEvidence;
  policy: string;
  request: DecisionRequest;
  authorize(): Promise<void>;
  signal?: AbortSignal;
  admit?: OptionalDecisionAdmission;
  timeoutMs?: number;
}>;
export type OptionalDecisionExecutor = (input: OptionalDecisionInput) => Promise<Readonly<Record<string, DecisionAnswer>> | null>;

export function qualifiedInteractiveDecisionModel(snapshot: ProviderExecutionSnapshot): boolean {
  return snapshot.providerFamily === "openrouter" && snapshot.model.adapterKind === "openrouter_decisions" &&
    snapshot.model.modelClass === "decision" && snapshot.model.upstreamModelId === JEV_MODEL_ID &&
    snapshot.decisionVerification?.servedModelId === JEV_SERVED_MODEL_ID &&
    snapshot.decisionVerification.provider.toLowerCase() === "typesafe";
}

function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createOptionalDecisionService(deps: Readonly<{
  repository: OptionalDecisionRepository;
  runtime(evidence: AcceptedDecisionRuntimeEvidence): Promise<AcceptedDecisionRuntimeBinding>;
  timeoutMs?: number;
}>): OptionalDecisionExecutor {
  return async input => {
    input.signal?.throwIfAborted();
    await input.authorize();
    let runtime: AcceptedDecisionRuntimeBinding;
    try { runtime = await deps.runtime(input.evidence); }
    catch (error) { if (error instanceof ProviderAdmissionError) return null; throw error; }
    // Qualification covers this exact served family; unqualified deployments
    // remain available for future explicit consumers without enabling this one.
    if (!qualifiedInteractiveDecisionModel(runtime.executionSnapshot)) return null;
    const hash = optionalDecisionInputHash({ policy: input.policy, request: { state: input.request.state, questions: input.request.questions },
      snapshot: runtime.executionSnapshot });
    const claim = await deps.repository.start(input.owner, hash, runtime.executionSnapshot);
    if (claim.kind === "replay") {
      await input.authorize();
      input.signal?.throwIfAborted();
      return claim.answers;
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("optional_decision_timeout")),
      Math.min(input.timeoutMs ?? Infinity, deps.timeoutMs ?? OPTIONAL_DECISION_TIMEOUT_MS));
    const signal = AbortSignal.any([timeout.signal, ...(input.signal ? [input.signal] : [])]);
    let pending: Promise<DecisionResult> | null = null;
    let receipt: DecisionReceipt | null = null;
    let answers: Readonly<Record<string, DecisionAnswer>> | null = null;
    let failureCode: string | null = null;
    let dispatched = false;
    let admission: Awaited<ReturnType<OptionalDecisionAdmission>> | null = null;
    let admissionFailure: unknown = null;
    try {
      await input.authorize();
      signal.throwIfAborted();
      if (input.admit) {
        try { admission = await input.admit(runtime.executionSnapshot); }
        catch (error) { admissionFailure = error; throw error; }
      }
      signal.throwIfAborted();
      dispatched = true;
      pending = runtime.adapter.decide({ ...input.request, signal });
      const result = await untilAborted(pending, signal);
      receipt = result;
      signal.throwIfAborted();
      await input.authorize();
      answers = result.answers;
    } catch (error) {
      if (error instanceof DecisionAdapterError) receipt = error.receipt ?? receipt;
      if (!receipt && (error instanceof ProviderAdmissionError || error instanceof DecisionAdapterError &&
        ["decision_input_invalid", "decision_request_too_large"].includes(error.code))) dispatched = false;
      failureCode = signal.aborted ? "optional_decision_cancelled" :
        error instanceof DecisionAdapterError || error instanceof ProviderAdmissionError ? error.code : "optional_decision_unavailable";
    } finally { clearTimeout(timer); }
    const settle = async (result: OptionalDecisionSettlement) => {
      await deps.repository.settle(input.owner, claim.id, result);
      await admission?.settle(result);
    };
    await settle({ receipt, answers, failureCode, dispatched });
    if (!receipt && pending) {
      void pending.then(value => value as DecisionReceipt, (error: unknown) => error instanceof DecisionAdapterError ? error.receipt : null)
        .then(async late => { if (late) await settle({
          receipt: late, answers: null, failureCode: failureCode ?? "optional_decision_cancelled", dispatched: true
        }); }).catch(() => undefined);
    }
    if (admissionFailure) throw admissionFailure;
    input.signal?.throwIfAborted();
    await input.authorize();
    return answers;
  };
}

export function createPrismaOptionalDecisionService(db: PrismaClient): OptionalDecisionExecutor {
  const runtime = createAcceptedDecisionRuntime(db);
  return createOptionalDecisionService({ repository: createOptionalDecisionRepository(db), runtime: evidence => runtime.resolve(evidence) });
}
