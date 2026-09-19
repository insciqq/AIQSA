import { decisionResponseModelMatches } from "../../domain/decisionModels";
import { parseRetryAfterMs } from "../retryAfter";
import {
  ProviderResponseTooLargeError, isProviderDeadlineExceededError,
  providerResponseMaxBytes, readBoundedResponseText, withTimeoutSignal
} from "./network";
import {
  effectiveProviderResponseTimeoutMs, normalizeProviderConnectionConfiguration,
  normalizeProviderModelConfiguration, providerAuthenticationMode, providerRequestEndpoint,
  type ProviderConnectionConfiguration, type ProviderModelConfiguration
} from "./providerConfiguration";
import {
  assertProviderCredentialSource, resolveProviderCredentialSource, type ProviderCredentialSource
} from "./providerCredentialSource";
import { observeJsonParse, observeProviderDeadline, observeProviderFetch, observeProviderOperation } from "./providerObservability";
import { createProviderSafeFetch } from "./providerSafeFetch";
import type { ProviderStreamSafetyIdentity } from "./streamSafetyObservability";

// Transport allocation bounds, matching the existing rerank envelope. They
// neither estimate model tokens nor truncate input to fit a semantic budget.
export const MAX_DECISION_REQUEST_BYTES = 512 * 1024;
export const MAX_DECISION_RESPONSE_BYTES = 2 * 1024 * 1024;

export type DecisionQuestion = Readonly<{
  type: "noul";
  instructions: string;
  criteria?: Readonly<{ true: string; false: string }>;
}> | Readonly<{
  type: "choice";
  instructions: string;
  criteria: Readonly<Record<string, string>>;
}>;

export type DecisionAnswer = Readonly<{ type: "noul"; noul: number }> | Readonly<{
  type: "choice";
  choice: string;
  confidence: number | null;
  probabilities: Readonly<Record<string, number>> | null;
}>;

export type DecisionUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}>;
export type DecisionReceipt = Readonly<{
  model: string;
  provider: string;
  requestId: string | null;
  usage: DecisionUsage;
}>;
export type DecisionResult = DecisionReceipt & Readonly<{
  answers: Readonly<Record<string, DecisionAnswer>>;
}>;
export type DecisionRequest = Readonly<{
  state: string | Readonly<Record<string, unknown>> | readonly unknown[];
  questions: Readonly<Record<string, DecisionQuestion>>;
  signal?: AbortSignal;
}>;
export type DecisionAdapter = Readonly<{
  decide(request: DecisionRequest): Promise<DecisionResult>;
}>;
export type DecisionErrorCode =
  | "decision_input_invalid" | "decision_request_too_large"
  | "decision_provider_http_error" | "decision_provider_request_failed"
  | "decision_request_timed_out" | "decision_response_too_large"
  | "decision_response_invalid" | "decision_response_model_mismatch"
  | "decision_response_provider_mismatch";

export class DecisionAdapterError extends Error {
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;
  /** Accounting survives an unusable decision. Never apply its answers. */
  readonly receipt: DecisionReceipt | null;

  constructor(readonly code: DecisionErrorCode, options: Readonly<{
    httpStatus?: number; retryAfterMs?: number | null; receipt?: DecisionReceipt;
  }> = {}) {
    super(code);
    this.name = "DecisionAdapterError";
    this.httpStatus = options.httpStatus ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.receipt = options.receipt ?? null;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\u0000");
}
function identifier(value: unknown): value is string {
  return text(value) && value.length <= 512 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}
function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function sameKeys(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((key) => Object.hasOwn(right, key));
}

function requestQuestions(value: unknown): Record<string, DecisionQuestion> {
  if (!record(value) || Object.keys(value).length === 0) throw new DecisionAdapterError("decision_input_invalid");
  return Object.fromEntries(Object.entries(value).map(([id, question]) => {
    if (!identifier(id) || !record(question) || !text(question.instructions)) {
      throw new DecisionAdapterError("decision_input_invalid");
    }
    const { instructions, criteria } = question;
    if (question.type === "noul") {
      if (criteria !== undefined && (!record(criteria) || !sameKeys(criteria, { true: true, false: true }) ||
        !text(criteria.true) || !text(criteria.false))) throw new DecisionAdapterError("decision_input_invalid");
      return [id, { type: "noul", instructions,
        ...(criteria === undefined ? {} : { criteria: { true: criteria.true as string, false: criteria.false as string } }) }];
    }
    if (question.type !== "choice" || !record(criteria) || Object.keys(criteria).length < 2 ||
      Object.entries(criteria).some(([key, description]) => !identifier(key) || !text(description))) {
      throw new DecisionAdapterError("decision_input_invalid");
    }
    return [id, { type: "choice", instructions, criteria: { ...criteria } as Record<string, string> }];
  }));
}

function parseReceipt(body: Record<string, unknown>, headerId: string | null): DecisionReceipt {
  const usage = body.usage;
  if (!identifier(body.model) || !identifier(body.provider) || !record(usage) ||
    !Number.isSafeInteger(usage.input_tokens) || Number(usage.input_tokens) < 0 ||
    !Number.isSafeInteger(usage.output_tokens) || Number(usage.output_tokens) < 0 ||
    usage.cost !== undefined && (typeof usage.cost !== "number" || !Number.isFinite(usage.cost) || usage.cost < 0)) {
    throw new DecisionAdapterError("decision_response_invalid");
  }
  return {
    model: body.model, provider: body.provider,
    requestId: identifier(body.id) ? body.id : identifier(headerId) ? headerId : null,
    usage: { inputTokens: Number(usage.input_tokens), outputTokens: Number(usage.output_tokens),
      costUsd: typeof usage.cost === "number" ? usage.cost : null }
  };
}

function parseResult(body: unknown, questions: Record<string, DecisionQuestion>, model: ProviderModelConfiguration,
  headerId: string | null, verifiedIdentity?: Readonly<{ servedModelId: string; provider: string }>): DecisionResult {
  if (!record(body)) throw new DecisionAdapterError("decision_response_invalid");
  const receipt = parseReceipt(body, headerId);
  const fail = (code: DecisionErrorCode): never => { throw new DecisionAdapterError(code, { receipt }); };
  if (!decisionResponseModelMatches(model.upstreamModelId, receipt.model)) fail("decision_response_model_mismatch");
  if (verifiedIdentity && receipt.model !== verifiedIdentity.servedModelId) fail("decision_response_model_mismatch");
  const routing = model.openRouterRouting!;
  if (routing.mode === "only_selected" && !routing.providers.some((provider) =>
    provider.toLocaleLowerCase("und") === receipt.provider.toLocaleLowerCase("und"))) {
    fail("decision_response_provider_mismatch");
  }
  if (verifiedIdentity && receipt.provider !== verifiedIdentity.provider) fail("decision_response_provider_mismatch");
  const answers = body.answers;
  if (!record(answers) || !sameKeys(answers, questions)) return fail("decision_response_invalid");
  const entries = Object.entries(questions).map(([id, question]): [string, DecisionAnswer] => {
    const answer = answers[id];
    if (!record(answer) || answer.type !== question.type) return fail("decision_response_invalid");
    if (question.type === "noul") {
      if (!probability(answer.noul)) return fail("decision_response_invalid");
      return [id, { type: "noul", noul: answer.noul }];
    }
    if (typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice) ||
      answer.confidence !== undefined && !probability(answer.confidence)) return fail("decision_response_invalid");
    const probabilities = answer.probabilities;
    if (probabilities !== undefined && (!record(probabilities) || !sameKeys(probabilities, question.criteria) ||
      Object.values(probabilities).some((entry) => !probability(entry)))) return fail("decision_response_invalid");
    return [id, { type: "choice", choice: answer.choice,
      confidence: typeof answer.confidence === "number" ? answer.confidence : null,
      probabilities: probabilities === undefined ? null : { ...probabilities } as Record<string, number> }];
  });
  return { ...receipt, answers: Object.fromEntries(entries) };
}

export function createOpenRouterDecisionAdapter(input: Readonly<{
  connection: ProviderConnectionConfiguration;
  model: ProviderModelConfiguration;
  network?: Readonly<{ fetchFn?: typeof fetch; responseMaxBytes?: number }>;
  observationIdentity?: ProviderStreamSafetyIdentity;
  secret: ProviderCredentialSource;
  verifiedIdentity?: Readonly<{ servedModelId: string; provider: string }>;
}>): DecisionAdapter {
  const connection = normalizeProviderConnectionConfiguration(input.connection);
  const model = normalizeProviderModelConfiguration(input.model);
  if (model.modelClass !== "decision" || model.adapterKind !== "openrouter_decisions" ||
    !model.openRouterRouting || providerAuthenticationMode(connection) !== "bearer") {
    throw new DecisionAdapterError("decision_input_invalid");
  }
  assertProviderCredentialSource(input.secret, "decision_provider_request_failed");
  const endpoint = providerRequestEndpoint(connection, model.adapterKind);
  const identity = input.observationIdentity ?? { adapterKind: model.adapterKind, providerFamily: "openrouter" };
  const fetchFn = observeProviderFetch(input.network?.fetchFn ?? createProviderSafeFetch({ configuration: connection }));
  const maxBytes = Math.min(input.network?.responseMaxBytes ?? providerResponseMaxBytes(), MAX_DECISION_RESPONSE_BYTES);
  return Object.freeze({
    decide(request: DecisionRequest) {
      const timeoutMs = effectiveProviderResponseTimeoutMs(connection, model);
      observeProviderDeadline({ ...identity, stage: "decisions", provider_timeout_ms: timeoutMs, effective_timeout_ms: timeoutMs });
      return observeProviderOperation(identity, "decisions", async () => {
        request.signal?.throwIfAborted();
        const questions = requestQuestions(request.questions);
        if (typeof request.state !== "string" && (!request.state || typeof request.state !== "object")) {
          throw new DecisionAdapterError("decision_input_invalid");
        }
        const routing = model.openRouterRouting!;
        let serialized: string;
        try {
          serialized = JSON.stringify({ model: model.upstreamModelId, state: request.state, questions,
            provider: { allow_fallbacks: routing.mode === "automatic", data_collection: "deny",
              ...(routing.mode === "only_selected" ? { only: [...routing.providers], order: [...routing.providers] } : {}) }
          }, (_key, value: unknown) => {
            if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" ||
              typeof value === "number" && !Number.isFinite(value)) throw new DecisionAdapterError("decision_input_invalid");
            return value;
          });
        } catch { throw new DecisionAdapterError("decision_input_invalid"); }
        if (Buffer.byteLength(serialized, "utf8") > MAX_DECISION_REQUEST_BYTES) {
          throw new DecisionAdapterError("decision_request_too_large");
        }
        const timeout = withTimeoutSignal(request.signal, timeoutMs);
        try {
          // Resolve outside the transport catch: revoked authority is never
          // relabelled as an optional provider outage by this adapter.
          const secret = await resolveProviderCredentialSource(input.secret, "decision_provider_request_failed");
          timeout.signal.throwIfAborted();
          try {
            // Exactly one dispatch. The durable caller owns retries and must
            // never replay an already paid or crash-ambiguous decision.
            const response = await fetchFn(endpoint, { body: serialized, method: "POST", redirect: "error",
              headers: { accept: "application/json", authorization: `Bearer ${secret}`, "content-type": "application/json" },
              signal: timeout.signal });
            if (!response.ok) {
              await response.body?.cancel().catch(() => undefined);
              throw new DecisionAdapterError("decision_provider_http_error", {
                httpStatus: response.status, retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after"))
              });
            }
            const raw = await readBoundedResponseText(response, { maxBytes, signal: timeout.signal });
            let parsed: unknown;
            try { parsed = observeJsonParse(response, () => JSON.parse(raw) as unknown); }
            catch { throw new DecisionAdapterError("decision_response_invalid"); }
            return parseResult(parsed, questions, model, response.headers.get("x-request-id"), input.verifiedIdentity);
          } catch (error) {
            request.signal?.throwIfAborted();
            if (error instanceof DecisionAdapterError) throw error;
            if (error instanceof ProviderResponseTooLargeError) throw new DecisionAdapterError("decision_response_too_large");
            if (isProviderDeadlineExceededError(error) || timeout.signal.aborted && isProviderDeadlineExceededError(timeout.signal.reason)) {
              throw new DecisionAdapterError("decision_request_timed_out");
            }
            throw new DecisionAdapterError("decision_provider_request_failed");
          }
        } finally { timeout.clear(); }
      }, { signal: request.signal, timeoutMs });
    }
  });
}
