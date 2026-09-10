import type { AdminProviderCapabilityAttempt, AdminProviderCapabilityCheck, AdminProviderCheckRun } from "@/lib/contracts/adminProviders";

export const CAPABILITY_LABELS: Record<AdminProviderCapabilityCheck, string> = {
  modelAccess: "Model access", structuredOutput: "Strict JSON", toolCalling: "Tools",
  forcedToolCall: "Forced tool calls", parallelToolCalls: "Parallel tool calls", vision: "Image input",
  directPdf: "Direct PDF", streaming: "Streaming", embedding: "Embeddings", reranking: "Reranking", imageGeneration: "Image generation", imageEditing: "Image editing"
};

const reasonLabels: Record<AdminProviderCapabilityAttempt["reason"], string> = {
  verified: "verified", adapter_unsupported: "adapter does not implement this capability", route_unsupported: "no supporting endpoint on this route",
  refusal: "provider refused the request", budget_exhausted: "output budget exhausted", invalid_input: "provider rejected the input",
  http_error: "provider request failed", timeout: "check timed out", network: "network connection failed", rate_limit: "provider rate limit",
  authorization: "key or account authorization failed", semantic_inconclusive: "response did not prove the capability",
  not_checked: "not checked", run_deadline: "overall checking deadline reached"
};

export function capabilityAttemptDescription(attempt: AdminProviderCapabilityAttempt | undefined): string {
  if (!attempt) return "";
  const status = Number.isInteger(attempt.httpStatus) && Number(attempt.httpStatus) >= 400 && Number(attempt.httpStatus) <= 599 ? ` · HTTP ${attempt.httpStatus}` : "";
  const count = Number.isInteger(attempt.attempts) && attempt.attempts >= 1 && attempt.attempts <= 3 ? ` · ${attempt.attempts} ${attempt.attempts === 1 ? "attempt" : "attempts"}` : "";
  return `${reasonLabels[attempt.reason] ?? "check inconclusive"}${status}${count}`;
}

const stateLabels: Record<NonNullable<AdminProviderCheckRun["results"]>[number]["state"], string> = {
  saved: "Saved", partial: "Saved · some capabilities need attention", unavailable: "Model unavailable",
  save_failed: "Could not save checked settings", check_failed: "Check failed",
  cancelled: "Stopped before completion", stale: "Settings changed · check again"
};

/** Receipts describe persisted results; a passed check alone is never called saved. */
export function AdminProviderSetupResults({ run, models }: Readonly<{
  run: AdminProviderCheckRun;
  models: ReadonlyArray<{ id: string; displayName: string }>;
}>) {
  if (!run.results?.length) return null;
  return (
    <ul aria-label="Model setup results" className="mt-3 grid min-w-0 gap-2">
      {run.results.map((result) => (
        <li className="min-w-0 border-t border-trace-subtle pt-2 text-xs leading-5" key={result.providerModelId}>
          <p className="break-words font-medium text-ink">
            {models.find((model) => model.id === result.providerModelId)?.displayName ?? result.providerModelId}
            <span className={result.state === "saved" ? "font-normal text-ink-secondary" : "font-semibold text-critical"}> · {stateLabels[result.state]}</span>
          </p>
          {result.state === "save_failed" ? <p className="font-semibold text-critical">The latest checked settings were not saved. Earlier saved capabilities are kept.</p> : null}
          {result.checks ? <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-ink-muted">
            {Object.entries(result.checks).map(([capability, status]) => {
              const attempt = result.attempts?.[capability as AdminProviderCapabilityCheck];
              const failedRefresh = status === "verified" && attempt?.status === "incomplete";
              const needsAttention = failedRefresh || status === "rejected" || status === "incomplete" || status === "unsupported";
              return <li className={needsAttention ? "font-semibold text-critical" : undefined} key={capability}>
                {CAPABILITY_LABELS[capability as AdminProviderCapabilityCheck]}: {status === "verified" ? "verified"
                  : status === "unsupported" ? "unsupported on this route"
                  : status === "rejected" || status === "incomplete" ? "inconclusive" : "not checked"}
                {failedRefresh ? " previously; latest check inconclusive" : ""}
                {attempt && attempt.status !== "verified" ? ` — ${capabilityAttemptDescription(attempt)}` : ""}
              </li>;
            })}
          </ul> : null}
        </li>
      ))}
    </ul>
  );
}
