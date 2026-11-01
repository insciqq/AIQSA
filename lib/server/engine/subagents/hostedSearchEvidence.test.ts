import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../../domain/modelRunEvents";
import { summarizeMessageRunArtifacts } from "../../chats/prismaRepository";
import type { NormalizedSearchPlan } from "../../providers/types";
import { projectSearchEngineActivity } from "../../search/activityProjection";
import { hostedSearchEvidenceUrls } from "../../tools/fetchUrlPlan";
import { createHostedSearchEvidence, HOSTED_SEARCH_EVIDENCE_LIMITS, type HostedSearchEvidenceRow } from "./hostedSearchEvidence";

const hostedPlan = { mode: "all_selected", options: [{ adapterKind: "answer_provider_hosted", modelId: "search-model", optionId: "hosted-option",
  provider: "openai" }] } as unknown as NormalizedSearchPlan;
const citation = (url: string): ModelRunSseEvent =>
  ({ data: { artifactType: "citation", payload: { index: 1, title: "Cited", url } }, type: "artifact" });
const search = (...urls: string[]): ModelRunSseEvent =>
  ({ data: { artifactType: "search", payload: { action: { sources: urls.map((url) => ({ title: "Found", url })) }, type: "web_search_call" } }, type: "artifact" });

function evidence(plan: NormalizedSearchPlan = hostedPlan, record = vi.fn(async (_row: HostedSearchEvidenceRow) => undefined)) {
  return { record, turn: createHostedSearchEvidence({ modelRunId: "run", record, searchPlan: plan }) };
}

afterEach(() => { vi.useRealTimers(); });

describe("hosted Search evidence", () => {
  it("batches one model call's search and citation output into one deduplicated, normalized row", async () => {
    const { record, turn } = evidence();
    const call = turn.modelCall();
    call.add(search("https://found.example/a#:~:text=quote", "not a url"));
    call.add(citation("https://found.example/a"));
    call.add(citation("https://cited.example/b"));
    call.add({ data: { delta: "text" }, type: "token" });
    await call.save();
    expect(record).toHaveBeenCalledTimes(1);
    const row = record.mock.calls[0]![0];
    expect(row).toMatchObject({ modelId: "search-model", modelRunId: "run", provider: "openai", status: "complete", strategyId: "hosted-option" });
    expect(hostedSearchEvidenceUrls(row.artifacts)).toEqual(["https://found.example/a", "https://cited.example/b"]);
  });

  it("is invisible to every reader but the page reader: no source, no executed engine", async () => {
    const { record, turn } = evidence();
    const call = turn.modelCall();
    call.add(citation("https://cited.example/b"));
    await call.save();
    const row = record.mock.calls[0]![0];
    expect(row).not.toHaveProperty("invocationId");
    expect(row).not.toHaveProperty("searchRevisionId");
    expect(row.artifacts).not.toHaveProperty("sources");
    expect(summarizeMessageRunArtifacts({ events: [], searchRuns: [row] })).toBeNull();
    // What the same link would have shown as an engine's source.
    expect(summarizeMessageRunArtifacts({ events: [], searchRuns: [{ ...row, artifacts: { sources: [{ rank: 1, title: "Cited", url: "https://cited.example/b" }] } }] })?.sources)
      .toHaveLength(1);
    // Even an option of the same id as an accepted client engine counts nothing.
    const normalizedRequest = { searchPlan: { mode: "all_selected", options: [{ adapterKind: "provider_model_client", displayName: "Engine", optionId: row.strategyId }] } };
    expect(projectSearchEngineActivity({ normalizedRequest, searchRuns: [row], toolCalls: [] })).toEqual([]);
  });

  it("writes nothing without a hosted option, without a link, or for links this turn already saved", async () => {
    const none = evidence({ mode: "all_selected", options: [] });
    const unhosted = none.turn.modelCall();
    unhosted.add(citation("https://cited.example/b"));
    await unhosted.save();
    expect(none.record).not.toHaveBeenCalled();
    const { record, turn } = evidence();
    await turn.modelCall().save();
    expect(record).not.toHaveBeenCalled();
    const first = turn.modelCall();
    first.add(citation("https://cited.example/b"));
    await first.save();
    const again = turn.modelCall();
    again.add(citation("https://cited.example/b"));
    await again.save();
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("forgets a discarded attempt's output", async () => {
    const { record, turn } = evidence();
    const call = turn.modelCall();
    call.add(citation("https://discarded.example/"));
    call.discard();
    call.add(citation("https://kept.example/"));
    await call.save();
    expect(hostedSearchEvidenceUrls(record.mock.calls[0]![0].artifacts)).toEqual(["https://kept.example/"]);
  });

  it("bounds the links of a row and the rows of a turn", async () => {
    const { record, turn } = evidence();
    const call = turn.modelCall();
    for (let index = 0; index < HOSTED_SEARCH_EVIDENCE_LIMITS.urlsPerRow + 5; index += 1) call.add(citation(`https://site${index}.example/`));
    await call.save();
    expect(hostedSearchEvidenceUrls(record.mock.calls[0]![0].artifacts)).toHaveLength(HOSTED_SEARCH_EVIDENCE_LIMITS.urlsPerRow);
    for (let index = 0; index < HOSTED_SEARCH_EVIDENCE_LIMITS.rowsPerTurn + 5; index += 1) {
      const next = turn.modelCall();
      next.add(citation(`https://later${index}.example/`));
      await next.save();
    }
    expect(record).toHaveBeenCalledTimes(HOSTED_SEARCH_EVIDENCE_LIMITS.rowsPerTurn);
  });

  it("never rejects when the write fails, and offers the link again on a later call", async () => {
    const record = vi.fn(async (_row: HostedSearchEvidenceRow) => undefined);
    record.mockRejectedValueOnce(new Error("database down"));
    const { turn } = evidence(hostedPlan, record);
    const failed = turn.modelCall();
    failed.add(citation("https://cited.example/b"));
    await expect(failed.save()).resolves.toBeUndefined();
    const retried = turn.modelCall();
    retried.add(citation("https://cited.example/b"));
    await retried.save();
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("goes on when the write hangs", async () => {
    vi.useFakeTimers();
    const record = vi.fn((_row: HostedSearchEvidenceRow) => new Promise<undefined>(() => undefined));
    const { turn } = evidence(hostedPlan, record);
    const call = turn.modelCall();
    call.add(citation("https://cited.example/b"));
    const saved = call.save();
    await vi.advanceTimersByTimeAsync(HOSTED_SEARCH_EVIDENCE_LIMITS.writeWaitMs);
    await expect(saved).resolves.toBeUndefined();
  });
});
