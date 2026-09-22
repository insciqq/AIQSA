import { describe, expect, it, vi } from "vitest";
import { createAgentBuiltinProgress } from "./builtinProgress";
import { artifactToolResult } from "../artifacts/toolResult";
import type { createAgentRunStore } from "./store";

describe("Agent built-in output across processes", () => {
  it("forwards settled receipts once, keeps separate drafts and closes a pending draft on Stop", async () => {
    const make = (ordinal: number, pending: boolean) => ({ id: `row-${ordinal}`, callId: `call-${ordinal}`,
      name: "create_artifact", ordinal, arguments: { metadata: { title: "Synthetic page", kind: "html" } }, pending,
      result: pending ? null : artifactToolResult({ id: `call-${ordinal}`, name: "create_artifact" }, {
        id: `version-${ordinal}`, artifactId: "artifact", title: "Synthetic page", kind: "html", versionNumber: ordinal + 1,
        entrypoint: "index.html", manifest: { files: [{ byteSize: 42 }] }
      }) });
    let rows = [make(0, true), make(1, true)];
    const builtinProgress = vi.fn(async (after: number, pending: readonly string[]) =>
      rows.filter(row => row.ordinal > after || pending.includes(row.id)));
    const onEvent = vi.fn(), onPersistedEvent = vi.fn();
    const progress = createAgentBuiltinProgress({ runId: "run", store: { builtinProgress } as Pick<ReturnType<typeof createAgentRunStore>, "builtinProgress">,
      onEvent, onPersistedEvent });
    await Promise.all([progress.refresh(), progress.refresh()]);
    expect(builtinProgress).toHaveBeenCalledOnce();
    expect(onEvent.mock.calls.filter(([event]) => event.data.phase === "started").map(([event]) => event.data.draftId))
      .toEqual(["run:r0:c0", "run:r0:c1"]);
    rows = [make(0, false), make(1, true)];
    await progress.refresh(); await progress.refresh();
    expect(onPersistedEvent).toHaveBeenCalledOnce();
    expect(onPersistedEvent).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      artifactType: "generated_artifact", payload: expect.objectContaining({ versionId: "version-0" })
    }) }));
    await progress.stop("cancelled");
    expect(onEvent).toHaveBeenCalledWith({ type: "artifact_generation", data: {
      draftId: "run:r0:c1", phase: "settled", status: "cancelled", code: "model_run_cancelled"
    } });
    expect(onEvent.mock.calls.filter(([event]) => event.data.phase === "file")).toHaveLength(0);
  });
});
