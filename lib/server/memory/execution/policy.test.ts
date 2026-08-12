import { describe, expect, it } from "vitest";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import { applySystemModelReasoningEffort } from "./policy";

function snapshot(defaultParams: Record<string, unknown>): ProviderExecutionSnapshot {
  return {
    model: { defaultParams }
  } as unknown as ProviderExecutionSnapshot;
}

describe("Memory system-model execution policy", () => {
  it("adds the selected reasoning effort without mutating the admitted snapshot", () => {
    const admitted = snapshot({
      reasoning: { summary: "auto" },
      temperature: 0.2
    });

    const execution = applySystemModelReasoningEffort(admitted, "xhigh");

    expect(execution).not.toBe(admitted);
    expect(execution.model.defaultParams).toEqual({
      reasoning: { effort: "xhigh", summary: "auto" },
      temperature: 0.2
    });
    expect(admitted.model.defaultParams).toEqual({
      reasoning: { summary: "auto" },
      temperature: 0.2
    });
  });

  it("preserves the exact admitted snapshot for provider-default reasoning", () => {
    const admitted = snapshot({ temperature: 0.2 });
    expect(applySystemModelReasoningEffort(admitted, null)).toBe(admitted);
  });
});
