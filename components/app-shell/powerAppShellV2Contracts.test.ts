import { describe, expect, it } from "vitest";
import { powerAppShellViewFeatureKeys } from "./powerAppShellV2Contracts";

describe("PowerAppShellV2 root view contract", () => {
  it("keeps exactly seven semantic feature owners with standalone Branches", () => {
    expect(powerAppShellViewFeatureKeys).toEqual([
      "session",
      "workspace",
      "thread",
      "composer",
      "branches",
      "settings",
      "overlays"
    ]);
  });
});
