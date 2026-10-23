import { encodeSseEvent, RUN_STREAM_KEEPALIVE, RUN_STREAM_KEEPALIVE_MS, type ModelRunSseEvent } from "../../domain/modelRunEvents";
import { logEvent } from "../observability";
import { projectRunOutputArtifactEvent } from "../runs/runOutputEvents";
import type { RunRepository } from "../runs/runRepositoryContract";

/**
 * The events of one native run, on the existing run stream contract the chat
 * renders: live-only events (text, reasoning headings, running steps,
 * phases) go to the open response, and every output the answer keeps
 * (reasoning, sources, images, cards, Workspace activity) is first saved as
 * a `ModelRunEvent` through the shared projection, so a reload or another
 * device shows it. Saving is bookkeeping: a failed save still shows the
 * event live and never stops the run.
 */
export type RunEventSink = Readonly<{
  /** Saves the event's kept projection, then sends it live. */
  publish(event: ModelRunSseEvent): Promise<void>;
  /** Sends a live-only event. */
  send(event: ModelRunSseEvent): void;
  startKeepalive(): () => void;
}>;

export function createRunEventSink(input: Readonly<{
  controller: ReadableStreamDefaultController<Uint8Array>;
  repository: Pick<RunRepository, "appendRunOutputEvent">;
  runId: string;
}>): RunEventSink {
  const encoder = new TextEncoder();
  const enqueue = (text: string) => {
    try {
      input.controller.enqueue(encoder.encode(text));
    } catch {
      // The browser left: the run continues and saves its outputs.
    }
  };
  const send = (event: ModelRunSseEvent) => enqueue(encodeSseEvent(event));
  return {
    async publish(event) {
      const kept = projectRunOutputArtifactEvent(event);
      let live: ModelRunSseEvent = event;
      if (kept) {
        try {
          const saved = await input.repository.appendRunOutputEvent(input.runId, kept);
          if (saved.type === "artifact" && saved.data.artifactType === "workspace_activity") live = saved;
        } catch (error) {
          logEvent("service_operation", { action: "degrade", code: "run_output_unsaved", error, outcome: "degraded",
            run_id: input.runId, stage: "write", subsystem: "database" });
        }
      }
      // A grounding display crosses only as its kept projection.
      if (event.type === "grounding_display") {
        if (!kept) return;
        live = kept;
      }
      send(live);
    },
    send,
    startKeepalive() {
      // Quiet phases (reasoning, tools) still prove the stream is alive.
      const timer = setInterval(() => enqueue(RUN_STREAM_KEEPALIVE), RUN_STREAM_KEEPALIVE_MS);
      timer.unref?.();
      return () => clearInterval(timer);
    }
  };
}
