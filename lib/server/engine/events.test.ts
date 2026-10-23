// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { contextCompactionArtifact } from "../runs/contextCompactionEvents";
import type { RunOutputArtifactEvent } from "../runs/runOutputEvents";
import { createRunEventSink } from "./events";

function sink(append: (runId: string, event: RunOutputArtifactEvent) => Promise<RunOutputArtifactEvent>) {
  const sent: string[] = [];
  const decoder = new TextDecoder();
  const controller = { enqueue: (bytes: Uint8Array) => { sent.push(decoder.decode(bytes)); } } as unknown as ReadableStreamDefaultController<Uint8Array>;
  const repository = { appendRunOutputEvent: vi.fn(append) };
  const live = () => sent.map((text) => JSON.parse(/^data: (.+)$/mu.exec(text)![1]!) as Record<string, unknown>);
  return { live, repository, sink: createRunEventSink({ controller, repository, runId: "run-1" }) };
}

const status = { cycle: 1, outcome: "summary_applied", state: "complete" } as const;

describe("native run event sink", () => {
  it("saves what the answer keeps and relays a Workspace entry with its durable sequence", async () => {
    const { live, repository, sink: events } = sink(async (_runId, event) => event.type === "artifact" &&
      event.data.artifactType === "workspace_activity" ? { ...event, data: { ...event.data, payload: { ...event.data.payload, sequence: 7 } } } : event);
    await events.publish({ data: { artifactType: "workspace_activity", payload: { id: "workspace_start:x", kind: "workspace_start",
      phase: "succeeded" } }, type: "artifact" });
    await events.publish({ data: { artifactType: "summary", payload: { reasoningHeading: "Checking" } }, type: "artifact" } as ModelRunSseEvent);
    expect(repository.appendRunOutputEvent).toHaveBeenCalledTimes(1);
    expect(live()).toEqual([{ artifactType: "workspace_activity", payload: { id: "workspace_start:x", kind: "workspace_start", phase: "succeeded",
      sequence: 7 } }, { artifactType: "summary", payload: { reasoningHeading: "Checking" } }]);
  });

  it("records a server-minted compaction status, which a provider's own status never becomes", async () => {
    const { live, repository, sink: events } = sink(async (_runId, event) => event);
    const event = contextCompactionArtifact(status as never);
    await events.publish(event);
    expect(repository.appendRunOutputEvent).not.toHaveBeenCalled();
    await events.record(event);
    expect(repository.appendRunOutputEvent).toHaveBeenCalledWith("run-1", event);
    expect(live()).toEqual([event.data, event.data]);
  });

  it("still shows an output whose save failed", async () => {
    const { live, sink: events } = sink(async () => { throw new Error("database unavailable"); });
    await events.record(contextCompactionArtifact(status as never));
    await events.publish({ data: { artifactType: "workspace_activity", payload: { id: "call:1", kind: "file_read", phase: "running",
      file: { displayPath: "project/a.txt" } } }, type: "artifact" });
    expect(live()).toHaveLength(2);
  });
});
