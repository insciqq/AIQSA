import { describe, expect, it } from "vitest";
import {
  MEMORY_SHADOW_CUTOVER_BLOCKING_JOB_KINDS,
  memoryJobBlocksShadowCutover
} from "./wake";

describe("memory shadow rebuild wake contract", () => {
  it("uses batched embedding settlement as a cutover wake handshake", () => {
    expect(MEMORY_SHADOW_CUTOVER_BLOCKING_JOB_KINDS).toContain("EMBED_ITEMS");
    expect(memoryJobBlocksShadowCutover("EMBED_ITEMS")).toBe(true);
  });
});
