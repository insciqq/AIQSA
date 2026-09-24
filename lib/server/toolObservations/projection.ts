import type { ToolExecutionResult } from "../tools/types";
import { decodeToolObservationDescriptor } from "./contract";

/** Keep canonical checkpoints separate from their provider representation. */
export function projectObservationForProvider(result: ToolExecutionResult): ToolExecutionResult {
  if (!result.observation || result.content.some(part => {
    if (part.type !== "json" || !part.value || typeof part.value !== "object" || !("observation" in part.value)) return false;
    const current = decodeToolObservationDescriptor(part.value.observation);
    return current?.handle === result.observation!.handle && current.checksum === result.observation!.checksum;
  })) return result;
  return { ...result, content: [...result.content, { type: "json", value: {
    observation: result.observation, reader: "read_tool_result"
  } }] };
}

/** Estimate only; this reference is never persisted or sent to a provider.
 * Skill admission precedes its SOURCE publication, so reserve the descriptor's
 * largest representation before accepting instructions into the context. */
export function projectSkillObservationForBudget(result: ToolExecutionResult): ToolExecutionResult {
  return projectObservationForProvider(result.observation ? result : { ...result, observation: {
    version: 1, source: "skill", handle: `tor1_${"0".repeat(32)}`, encoding: "json-utf8-v1",
    byteSize: 33554432, checksum: "0".repeat(64), maskable: false, sourceTruncated: false
  } });
}
