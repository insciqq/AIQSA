import { describe, expect, it } from "vitest";
import { responsesHistoryFromOutput, type ProviderHistoryItem } from "../../providers/history";
import { projectTranscript } from "../transcript";
import { CODEX, transcriptBuilder } from "./compaction.testFixtures";
import { nativeCompactionFrom, responsesCompactionInput } from "./native";

describe("native compaction request and response", () => {
  it("renders the replayed span as Responses input, own reasoning and an earlier compaction included, then the trigger", () => {
    const chat = transcriptBuilder();
    chat.compaction({ native: { fields: { encrypted_content: "ENC-OLD", id: "cmp_0", type: "compaction" }, format: "openai_responses" },
      retained: "Recorded state" });
    chat.user("Run the export");
    chat.reasoning();
    chat.tool("run_pipeline", { stage: "export" }, "done");
    const input = responsesCompactionInput(projectTranscript(chat.items, CODEX));
    expect(input).toEqual([
      { encrypted_content: "ENC-OLD", id: "cmp_0", type: "compaction" },
      { content: [{ text: "Recorded state", type: "input_text" }], role: "user" },
      { content: [{ text: "Run the export", type: "input_text" }], role: "user" },
      { encrypted_content: "ENC-i3", id: "rs_i3", summary: [], type: "reasoning" },
      { arguments: "{\"stage\":\"export\"}", call_id: "call_1", name: "run_pipeline", type: "function_call" },
      { call_id: "call_1", output: "done", type: "function_call_output" },
      { type: "compaction_trigger" }
    ]);
  });

  it("takes the last compaction item with encrypted content and nothing else", () => {
    const output = responsesHistoryFromOutput([
      { encrypted_content: "ENC-R", id: "rs_1", summary: [], type: "reasoning" },
      { encrypted_content: "ENC-1", id: "cmp_1", type: "compaction" },
      { encrypted_content: "ENC-2", id: "cmp_2", type: "compaction" },
      { encrypted_content: "", id: "cmp_3", type: "compaction" }
    ]);
    expect(nativeCompactionFrom(output)).toEqual({ fields: { encrypted_content: "ENC-2", id: "cmp_2", type: "compaction" },
      format: "openai_responses" });
    const foreign: ProviderHistoryItem[] = [{ native: { fields: { type: "compaction", encrypted_content: "X" }, format: "gemini_interactions" },
      type: "compaction" }];
    expect(nativeCompactionFrom(foreign)).toBeNull();
    expect(nativeCompactionFrom([{ text: "I will compact later.", type: "assistant_text" }])).toBeNull();
    expect(nativeCompactionFrom(undefined)).toBeNull();
  });
});
