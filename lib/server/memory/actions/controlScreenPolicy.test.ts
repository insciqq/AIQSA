import { describe, expect, it } from "vitest";
import { jevModelConfiguration, JEV_SERVED_MODEL_ID } from "../../../domain/decisionModels";
import type { ProviderExecutionSnapshot } from "../../providers/runtimeFactory";
import {
  MEMORY_CONTROL_SCREEN_BYPASS_THRESHOLD,
  qualifiedMemoryControlScreenModel,
  screenOutMemoryControl
} from "./controlScreenPolicy";

describe("Memory control screen policy", () => {
  it("bypasses only a valid probability strictly below the frozen threshold", () => {
    expect(MEMORY_CONTROL_SCREEN_BYPASS_THRESHOLD).toBe(0.05);
    expect(screenOutMemoryControl(0)).toBe(true);
    expect(screenOutMemoryControl(0.049)).toBe(true);
    for (const value of [0.05, 1, -0.1, 1.1, NaN, Infinity]) {
      expect(screenOutMemoryControl(value)).toBe(false);
    }
  });

  it("requires exact checked Jev capability and served revision", () => {
    const snapshot = {
      providerFamily: "openrouter",
      model: jevModelConfiguration(),
      decisionVerification: {
        servedModelId: JEV_SERVED_MODEL_ID,
        provider: "TypeSafe",
        noul: true
      }
    } as ProviderExecutionSnapshot;
    expect(qualifiedMemoryControlScreenModel(snapshot)).toBe(true);
    expect(qualifiedMemoryControlScreenModel({ ...snapshot,
      decisionVerification: { ...snapshot.decisionVerification!, servedModelId: "future" }
    })).toBe(false);
    expect(qualifiedMemoryControlScreenModel({ ...snapshot,
      decisionVerification: { ...snapshot.decisionVerification!, noul: false }
    } as unknown as ProviderExecutionSnapshot)).toBe(false);
  });
});
