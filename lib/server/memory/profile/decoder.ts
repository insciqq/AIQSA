import type { ModelToolCall } from "../../tools/types";
import {
  MEMORY_PROFILE_MAX_OUTPUT_FACTS,
  MEMORY_PROFILE_MAX_SUMMARY_LENGTH,
  memoryProfileOutputHash,
  type MemoryProfileInput,
  type MemoryProfilePlan,
  type MemoryProfileSegment
} from "./contract";
import { MEMORY_PROFILE_TOOL_NAME } from "./prompt";

const controlPattern = /[\u0000-\u001f\u007f]/u;

export class MemoryProfileDecodeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MemoryProfileDecodeError";
  }
}
function fail(code = "memory_profile_output_invalid"): never {
  throw new MemoryProfileDecodeError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

export function decodeMemoryProfile(
  calls: readonly ModelToolCall[] | undefined,
  input: MemoryProfileInput
): MemoryProfilePlan {
  if (
    !calls || calls.length !== 1 || calls[0]?.name !== MEMORY_PROFILE_TOOL_NAME ||
    !isRecord(calls[0].arguments) || !exactKeys(calls[0].arguments, ["segments"])
  ) return fail();
  const raw = calls[0].arguments.segments;
  if (
    !Array.isArray(raw) || raw.length < 1 ||
    raw.length > MEMORY_PROFILE_MAX_OUTPUT_FACTS
  ) return fail();
  const seen = new Set<string>();
  const segments: MemoryProfileSegment[] = raw.map((entry) => {
    if (!isRecord(entry) || !exactKeys(entry, ["fact_version_id", "text"])) return fail();
    if (
      typeof entry.fact_version_id !== "string" || !entry.fact_version_id ||
      entry.fact_version_id.length > 256 || controlPattern.test(entry.fact_version_id) ||
      typeof entry.text !== "string" || !entry.text || controlPattern.test(entry.text)
    ) return fail();
    if (seen.has(entry.fact_version_id)) return fail("memory_profile_output_duplicate");
    const candidate = input.candidates.find(({ factVersionId }) =>
      factVersionId === entry.fact_version_id);
    if (!candidate) return fail("memory_profile_output_ungrounded");
    if (entry.text !== candidate.text) return fail("memory_profile_output_unsupported");
    seen.add(entry.fact_version_id);
    return { factVersionId: candidate.factVersionId, text: candidate.text };
  });
  if (segments.map(({ text }) => text).join("\n").length > MEMORY_PROFILE_MAX_SUMMARY_LENGTH) {
    return fail();
  }
  return { outputHash: memoryProfileOutputHash(input, segments), segments };
}
