import { describe, expect, it } from "vitest";
import {
  MEMORY_QUERY_RESOLUTION_JSON_SCHEMA,
  decodeMemoryQueryResolution
} from "./memoryQueryResolution";

const constraint = Object.freeze({
  basisOccurrenceIndex: 0,
  basisQuote: "I want to branch out beyond true crime.",
  kind: "AVOID" as const,
  sourceHandle: "R2",
  sourceTextIndex: 0,
  targetOccurrenceIndex: 0,
  targetQuote: "true crime"
});

describe("MemoryQueryResolution contract", () => {
  it("accepts the two exact wire states", () => {
    expect(decodeMemoryQueryResolution({ constraints: [], status: "NONE" }))
      .toMatchObject({ ok: true, value: { status: "NONE" } });
    expect(decodeMemoryQueryResolution({
      constraints: [constraint],
      status: "RESOLVED"
    })).toMatchObject({
      ok: true,
      value: { constraints: [constraint], status: "RESOLVED" }
    });
    expect(MEMORY_QUERY_RESOLUTION_JSON_SCHEMA).toMatchObject({
      additionalProperties: false,
      properties: {
        constraints: { maxItems: 6 },
        status: { enum: ["NONE", "RESOLVED"] }
      }
    });
  });

  it.each([
    { constraints: [constraint], status: "NONE" },
    { constraints: [], status: "RESOLVED" },
    { constraints: [constraint, constraint], status: "RESOLVED" },
    { constraints: [{ ...constraint, extra: true }], status: "RESOLVED" },
    { constraints: [{ ...constraint, sourceHandle: "source-2" }], status: "RESOLVED" },
    { constraints: [{ ...constraint, targetQuote: " true crime" }], status: "RESOLVED" }
  ])("rejects an invalid or ambiguous wire value", (value) => {
    expect(decodeMemoryQueryResolution(value)).toEqual({
      code: "memory_query_resolution_invalid",
      ok: false
    });
  });
});
