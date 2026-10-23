import type { ToolExecutionResult } from "../tools/types";
import { decodeToolObservationDescriptor } from "./contract";
import { READ_TOOL_RESULT_NAME, readToolResultError } from "../tools/readToolResult";

/** Keep canonical checkpoints separate from their provider representation. */
export function projectObservationForProvider(result: ToolExecutionResult): ToolExecutionResult {
  if (!result.observation) return result;
  const projected = result.content.findIndex(part => {
    if (part.type !== "json" || !part.value || typeof part.value !== "object" || !("observation" in part.value)) return false;
    const current = decodeToolObservationDescriptor(part.value.observation);
    return current?.handle === result.observation!.handle && current.checksum === result.observation!.checksum;
  });
  if (projected >= 0) {
    if (result.status !== "error") return result;
    return { ...result, content: result.content.map((part, index) => index === projected && part.type === "json"
      ? { ...part, value: { ...(part.value as Record<string, unknown>), is_error: true } } : part) };
  }
  return { ...result, content: [...result.content, { type: "json", value: {
    observation: result.observation,
    reader: "read_tool_result",
    ...(result.status === "error" ? { is_error: true } : {})
  } }] };
}

/** The descriptor of largest representation, for estimates that must not
 * fall below a real one. */
const LARGEST_DESCRIPTOR = Object.freeze({
  version: 1, source: "workspace", handle: `tor1_${"0".repeat(32)}`, encoding: "json-utf8-v1",
  byteSize: 33554432, checksum: "0".repeat(64), maskable: false, sourceTruncated: false
} as const);

/** The retained result as its reference alone: the descriptor naming the
 * reader, exactly the form masking leaves. */
export function observationReference(result: ToolExecutionResult): ToolExecutionResult {
  return { callId: result.callId, name: result.name, status: result.status, ...(result.observation ? { observation: result.observation } : {}),
    content: [{ type: "json", value: { observation: result.observation, reader: READ_TOOL_RESULT_NAME } }] };
}

/** Estimate only: the smallest form a call of a tool batch reaches the model
 * in, at its largest — a deferred read, or any other result as an error's
 * reference. A batch's delivery allowance is what remains beside these. */
export function observationBatchFloor(call: Readonly<{ id: string; name: string }>): ToolExecutionResult {
  return call.name === READ_TOOL_RESULT_NAME ? readToolResultError(call, "tool_observation_read_deferred")
    : projectObservationForProvider(observationReference({ callId: call.id, name: call.name, status: "error",
      observation: LARGEST_DESCRIPTOR, content: [] }));
}

/** What a delivered result adds beyond its batch floor: its reference, or a
 * read's deferral. Other results have no floor here. */
export function observationFloorOf(result: ToolExecutionResult): ToolExecutionResult | null {
  if (result.observation) return projectObservationForProvider(observationReference(result));
  return result.name === READ_TOOL_RESULT_NAME ? readToolResultError({ id: result.callId, name: result.name }, "tool_observation_read_deferred")
    : null;
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
