import { describe, expect, it } from "vitest";
import { longMemEvalQualificationRevisionPathIncluded } from
  "./qualificationRevision";

describe("LongMemEval qualification revision", () => {
  it("covers executable worktree state while excluding mutable evidence", () => {
    expect(longMemEvalQualificationRevisionPathIncluded("lib/server/memory/a.ts"))
      .toBe(true);
    expect(longMemEvalQualificationRevisionPathIncluded(
      "benchmarks/longmemeval/run.ts"
    )).toBe(true);
    expect(longMemEvalQualificationRevisionPathIncluded(
      "benchmarks/longmemeval/qualifications/frozen.json"
    )).toBe(false);
    expect(longMemEvalQualificationRevisionPathIncluded(
      "benchmarks/longmemeval/results/run/checkpoint.json"
    )).toBe(false);
    expect(longMemEvalQualificationRevisionPathIncluded(
      "agent_docs/tasks/queue/task.md"
    )).toBe(false);
  });
});
