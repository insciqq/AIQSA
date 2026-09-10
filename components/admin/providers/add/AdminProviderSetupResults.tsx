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
  malformed_tool_output: "the model returned an invalid tool call",
  not_checked: "not checked", run_deadline: "overall checking deadline reached"
};

export function capabilityAttemptDescription(attempt: AdminProviderCapabilityAttempt | undefined): string {
  if (!attempt) return "";
  const status = Number.isInteger(attempt.httpStatus) && Number(attempt.httpStatus) >= 400 && Number(attempt.httpStatus) <= 599 ? ` · HTTP ${attempt.httpStatus}` : "";
  const count = Number.isInteger(attempt.attempts) && attempt.attempts >= 1 && attempt.attempts <= 3 ? ` · ${attempt.attempts} ${attempt.attempts === 1 ? "attempt" : "attempts"}` : "";
  return `${reasonLabels[attempt.reason] ?? "check inconclusive"}${status}${count}`;
}

/** A settled optional limitation is not unfinished setup. Unknown failures stay recoverable. */
export function providerSetupNeedsRecovery(run: AdminProviderCheckRun | null | undefined): boolean {
  if (!run) return true;
  if (run.state === "running") return false;
  if (run.state !== "completed" || run.total === 0 || run.done < run.total ||
    run.setup?.state === "partial" || run.setup?.state === "running" || run.skipped?.length) return true;
  const settled = (result: NonNullable<AdminProviderCheckRun["results"]>[number]) =>
    result.state === "saved" || result.state === "partial" ||
    result.state === "unavailable" && result.checks?.modelAccess === "unsupported";
  return Boolean(run.results?.some((result) => !settled(result))) ||
    run.failed.some((modelId) => !run.results?.some((result) => result.providerModelId === modelId && settled(result)));
}

/** Receipts describe persisted results; a passed check alone is never called saved. */
export function AdminProviderSetupResults({ run, models }: Readonly<{
  run: AdminProviderCheckRun;
  models: ReadonlyArray<{ id: string; displayName: string }>;
}>) {
  if (!run.results?.length || run.state === "running") return null;
  const saved = run.results.filter((result) => result.state === "saved" || result.state === "partial").length;
  const unavailable = run.results.filter((result) => result.state === "unavailable").length;
  const unsaved = run.results.filter((result) => result.state === "save_failed");
  const names = unsaved.slice(0, 3).map((result) => models.find((model) => model.id === result.providerModelId)?.displayName ?? "a model").join(", ");
  return (
    <div aria-label="Model setup summary" className="mt-2 min-w-0 text-xs leading-5 text-ink-secondary" role="group">
      <p>{saved} of {run.total} model results saved. Open a capability in the model list for its check result.</p>
      {unavailable > 0 ? <p className="text-critical">{unavailable} {unavailable === 1 ? "model is" : "models are"} unavailable to this key. Review model and key access.</p> : null}
      {unsaved.length > 0 ? <p className="break-words text-critical">Could not save checked settings for {names}{unsaved.length > 3 ? ` and ${unsaved.length - 3} more` : ""}. Earlier saved capabilities are kept.</p> : null}
    </div>
  );
}
