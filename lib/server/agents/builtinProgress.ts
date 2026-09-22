import { createArtifactGeneration } from "../artifacts/generation";
import { ARTIFACT_TOOL_NAME } from "../tools/artifact";
import { runOutputArtifactEvents, type RunOutputArtifactEvent } from "../runs/runOutputEvents";
import type { ModelRunSseEvent } from "@/lib/domain/modelRunEvents";
import type { createAgentRunStore } from "./store";

/** Only receipt metadata crosses the process boundary. Source previews stay
 * transient in the ordinary tool loop; Agent source remains in Workspace. */
export function createAgentBuiltinProgress(input: {
  runId: string; store: Pick<ReturnType<typeof createAgentRunStore>, "builtinProgress">;
  onEvent(event: ModelRunSseEvent): Promise<void>;
  onPersistedEvent(event: RunOutputArtifactEvent): Promise<void>;
}) {
  const generation = createArtifactGeneration(input.runId, data => input.onEvent({ type: "artifact_generation", data }));
  const pending = new Set<string>();
  let ordinal = -1;
  let refreshing: Promise<void> | null = null;
  const refresh = async () => {
    for (;;) {
      const before = ordinal;
      const calls = await input.store.builtinProgress(ordinal, [...pending]);
      for (const call of calls) {
        const first = call.ordinal > ordinal;
        if (first && call.name === ARTIFACT_TOOL_NAME) {
          const args = call.arguments as { metadata?: Record<string, unknown> };
          await generation.observe(0, { callIndex: call.ordinal, callId: call.callId, name: call.name,
            snapshot: args.metadata ?? {} });
        }
        ordinal = Math.max(ordinal, call.ordinal);
        if (call.pending) pending.add(call.id);
        else {
          pending.delete(call.id);
          if (call.result) {
            for (const event of runOutputArtifactEvents(call.result.artifacts ?? [])) await input.onPersistedEvent(event);
            await generation.settled(call.callId, call.result);
          }
        }
      }
      if (calls.length < 16 || ordinal === before) break;
    }
  };
  return {
    refresh() {
      refreshing ??= refresh().finally(() => { refreshing = null; });
      return refreshing;
    },
    stop: generation.stop
  };
}
