import type { AdminProviderCapabilityCheck, AdminProviderCheckRun } from "@/lib/contracts/adminProviders";

export const CAPABILITY_LABELS: Record<AdminProviderCapabilityCheck, string> = {
  modelAccess: "Text access", structuredOutput: "Strict JSON", toolCalling: "Tools",
  forcedToolCall: "Forced tool calls", parallelToolCalls: "Parallel tool calls", vision: "Image input",
  directPdf: "Direct PDF", streaming: "Streaming", embedding: "Embeddings", reranking: "Reranking", imageGeneration: "Image generation", imageEditing: "Image editing"
};

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
            <span className="font-normal text-ink-secondary"> · {stateLabels[result.state]}</span>
          </p>
          {result.state === "save_failed" ? <p className="text-caution">The checked settings are not published. Retry to finish saving.</p> : null}
          {result.checks ? <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-ink-muted">
            {Object.entries(result.checks).map(([capability, status]) => (
              <li key={capability}>
                {CAPABILITY_LABELS[capability as AdminProviderCapabilityCheck]}: {status === "verified" ? "verified"
                  : status === "unsupported" ? "unsupported on this route"
                  : status === "rejected" ? "check rejected"
                  : status === "incomplete" ? "check incomplete" : "not checked"}
              </li>
            ))}
          </ul> : null}
        </li>
      ))}
    </ul>
  );
}
