import type { ModelRunSseEvent } from "../../../domain/modelRunEvents";
import { logEvent } from "../../observability";
import type { NormalizedSearchPlan } from "../../providers/types";
import { projectRunOutputArtifactEvent } from "../../runs/runOutputEvents";
import { hostedSearchEvidenceArtifacts } from "../../tools/fetchUrlPlan";
import { normalizeFetchUrl } from "../../webFetch/urls";

/**
 * What a sub-agent's hosted Search found, kept as `fetch_url` link authority. The main agent keeps this output as run
 * events, which also show in its answer; a sub-agent's outputs stay its own, so it is written as one `SearchRun` row per
 * model call that found new links. The row is evidence, not an executed engine: no invocation id, so search activity
 * skips it, and no `sources`, so the answer's Sources do not list it even under the main run a foreground turn shares
 * (`hostedSearchEvidenceArtifacts`). No revision either, since it must not hold a Search integration against deletion.
 * Usage stays what the provider reported for the model call.
 */
export const HOSTED_SEARCH_EVIDENCE_LIMITS = Object.freeze({
  /** A longer turn's later links are refused, visibly: this many rows already outrun what the reader looks at. */
  rowsPerTurn: 100,
  urlsPerRow: 200,
  /** The row must exist before the model's next call can read a link, so the turn waits for it, but only this long. */
  writeWaitMs: 5_000
});

export type HostedSearchEvidenceRow = Readonly<{
  artifacts: unknown;
  modelId: string | null;
  modelRunId: string;
  provider: string;
  status: "complete";
  strategyId: string;
}>;

function foundUrls(event: ModelRunSseEvent): readonly string[] {
  if (event.type !== "artifact" || (event.data.artifactType !== "search" && event.data.artifactType !== "citation")) return [];
  const output = projectRunOutputArtifactEvent(event);
  if (output?.type !== "artifact") return [];
  if (output.data.artifactType === "citation") return [output.data.payload.url];
  return output.data.artifactType === "search" ? output.data.payload.action.sources.map((source) => source.url) : [];
}

/** One turn's evidence; `modelCall()` for each model call, which the turn makes one at a time. */
export function createHostedSearchEvidence(input: Readonly<{
  modelRunId: string;
  record(row: HostedSearchEvidenceRow): Promise<void>;
  searchPlan: NormalizedSearchPlan;
}>) {
  // The frozen hosted option names the row, as it names the main agent's output. Without one nothing here searched.
  const option = input.searchPlan.options.find((candidate) => candidate.adapterKind === "answer_provider_hosted");
  const saved = new Set<string>();
  let rows = 0;

  async function write(urls: readonly string[]): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), HOSTED_SEARCH_EVIDENCE_LIMITS.writeWaitMs);
    });
    const written = input.record({ artifacts: hostedSearchEvidenceArtifacts(urls), modelId: option!.modelId, modelRunId: input.modelRunId,
      provider: option!.provider, status: "complete", strategyId: option!.optionId }).then(() => true);
    // A write that loses the race may still fail later: this keeps that from being an unhandled rejection.
    const settled = written.catch((error: unknown) => {
      logEvent("service_operation", { action: "degrade", code: "subagent_search_evidence_unsaved", error, outcome: "degraded",
        run_id: input.modelRunId, stage: "write", subsystem: "database" });
      return false;
    });
    try {
      return await Promise.race([settled, waited]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    modelCall() {
      const found = new Set<string>();
      return {
        add(event: ModelRunSseEvent): void {
          if (!option) return;
          for (const url of foundUrls(event)) {
            const link = normalizeFetchUrl(url);
            if (link && !saved.has(link) && found.size < HOSTED_SEARCH_EVIDENCE_LIMITS.urlsPerRow) found.add(link);
          }
        },
        /** The model call's attempt was discarded, and what it found with it. */
        discard(): void {
          found.clear();
        },
        /** Never rejects: a lost row costs only the reads it would have allowed, which are refused visibly. */
        async save(): Promise<void> {
          if (found.size === 0 || rows >= HOSTED_SEARCH_EVIDENCE_LIMITS.rowsPerTurn) return;
          rows += 1;
          const urls = [...found];
          found.clear();
          if (await write(urls)) for (const url of urls) saved.add(url);
        }
      };
    }
  };
}
