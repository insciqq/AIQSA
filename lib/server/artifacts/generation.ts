import { ARTIFACT_GENERATION_LIMITS, decodeArtifactGenerationEvent, type ArtifactGenerationEvent } from "@/lib/contracts/artifactGeneration";
import { decodeThreadGeneratedArtifact } from "@/lib/contracts/chats";
import type { ProviderToolArgumentEvent } from "../providers/types";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { ARTIFACT_TOOL_NAME } from "../tools/artifact";
import { ArtifactArgumentPreview } from "./argumentPreview";

export function createArtifactGeneration(runId: string, send: (event: ArtifactGenerationEvent) => Promise<void>) {
  const drafts = new Map<string, { draftId: string; extractor: ArtifactArgumentPreview; settled: boolean; callId?: string }>();
  const calls = new Map<string, string>();
  let previewBytes = 0;
  let previewFull = false;
  async function start(round: number, index: number, callId?: string) {
    const key = `${round}:${index}`;
    let draft = drafts.get(key);
    if (!draft && drafts.size < ARTIFACT_GENERATION_LIMITS.maxDrafts) {
      const draftId = `${runId}:r${round}:c${index}`;
      draft = { draftId, extractor: new ArtifactArgumentPreview(draftId), settled: false };
      drafts.set(key, draft);
      await send({ draftId, phase: "started" });
    }
    if (draft && callId && draft.callId !== callId) {
      if (draft.callId) calls.delete(draft.callId);
      draft.callId = callId;
      calls.set(callId, key);
    }
    return draft;
  }
  return {
    async observe(round: number, event: ProviderToolArgumentEvent) {
      if (event.name !== ARTIFACT_TOOL_NAME) return;
      const draft = await start(round, event.callIndex, event.callId);
      if (!draft || draft.settled || previewFull) return;
      if (event.snapshot !== undefined) {
        await send({ draftId: draft.draftId, phase: "reset" });
        draft.extractor = new ArtifactArgumentPreview(draft.draftId);
      }
      const delta = event.snapshot !== undefined ? typeof event.snapshot === "string" ? event.snapshot : JSON.stringify(event.snapshot) : event.delta;
      if (delta) for (const output of draft.extractor.feed(delta)) {
        if (output.phase === "file") {
          previewBytes += Buffer.byteLength(output.text);
          if (previewBytes > ARTIFACT_GENERATION_LIMITS.maxPreviewBytes) { previewFull = true; break; }
        }
        await send(output);
      }
    },
    async requested(round: number, toolCalls: readonly ModelToolCall[]) {
      for (const [index, call] of toolCalls.entries()) {
        if (call.name !== ARTIFACT_TOOL_NAME) continue;
        const known = calls.get(call.id);
        const draft = known ? drafts.get(known) : await start(round, index, call.id);
        if (!draft) continue;
        const metadata = decodeArtifactGenerationEvent({ draftId: draft.draftId, phase: "metadata", title: call.arguments.title, kind: call.arguments.kind });
        if (metadata) await send(metadata);
      }
    },
    async settled(callId: string, result: ToolExecutionResult) {
      const key = calls.get(callId);
      const draft = key ? drafts.get(key) : undefined;
      if (!draft || draft.settled) return;
      draft.settled = true;
      const generated = result.artifacts?.find(event => event.type === "artifact" && event.data.artifactType === "generated_artifact");
      const artifact = generated?.type === "artifact" ? decodeThreadGeneratedArtifact(generated.data.payload) : null;
      if (result.status === "complete" && artifact) await send({ draftId: draft.draftId, phase: "settled", status: "ready", artifact });
      else await send({ draftId: draft.draftId, phase: "settled", status: "failed", code: "artifact_creation_failed" });
    },
    async stop(status: "cancelled" | "failed") {
      for (const draft of drafts.values()) if (!draft.settled) {
        draft.settled = true;
        await send({ draftId: draft.draftId, phase: "settled", status, code: status === "cancelled" ? "model_run_cancelled" : "artifact_creation_failed" });
      }
    }
  };
}
