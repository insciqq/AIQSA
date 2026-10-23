// @vitest-environment node
import { describe, expect, it } from "vitest";
import { aiqsaGuideText } from "../engine/prompts/selfService";
import { READ_AIQSA_GUIDE_TOOL_NAME, executeReadAiqsaGuide, readAiqsaGuideTool } from "./aiqsaGuide";
import { invalidProviderToolArguments } from "./types";

const call = (args: Record<string, unknown>) => ({ arguments: args, id: "call_guide", name: READ_AIQSA_GUIDE_TOOL_NAME });

describe("read_aiqsa_guide", () => {
  it("declares no effects and needs neither approval nor the VM", () => {
    expect(readAiqsaGuideTool).toMatchObject({ effects: "none", name: "read_aiqsa_guide", needsApproval: false, requiresVm: false });
    expect(readAiqsaGuideTool.tool).toMatchObject({ capability: "session", name: "read_aiqsa_guide" });
  });

  it("returns the topic asked for, and the overview by default", () => {
    expect(executeReadAiqsaGuide(call({ topic: "secrets" }))).toEqual({ callId: "call_guide",
      content: [{ text: aiqsaGuideText("secrets"), type: "text" }], name: "read_aiqsa_guide", status: "complete" });
    expect(executeReadAiqsaGuide(call({})).content).toEqual([{ text: aiqsaGuideText("overview"), type: "text" }]);
    expect(executeReadAiqsaGuide(call({ topic: null })).content).toEqual([{ text: aiqsaGuideText("overview"), type: "text" }]);
  });

  it.each([
    [{ topic: "knowledge" }],
    [{ topic: 3 }],
    [{ topic: "skills", extra: true }],
    [invalidProviderToolArguments()]
  ])("refuses %j and names the topics", (args) => {
    const result = executeReadAiqsaGuide(call(args));
    expect(result.status).toBe("error");
    expect(result.content[0]).toMatchObject({ type: "json", value: { code: "aiqsa_guide_invalid" } });
    expect(JSON.stringify(result.content)).toContain("overview, chats, studio, secrets");
  });
});
