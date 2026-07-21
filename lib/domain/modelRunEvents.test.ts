import { describe, expect, it } from "vitest";
import { encodeSseEvent, textFromContentBlocks } from "./modelRunEvents";

describe("model run events", () => {
  it("encodes typed SSE events", () => {
    expect(
      encodeSseEvent({
        data: {
          delta: "hello"
        },
        type: "token"
      })
    ).toBe('event: token\ndata: {"delta":"hello"}\n\n');
  });

  it("extracts text from normalized content blocks", () => {
    expect(
      textFromContentBlocks({
        blocks: [
          { text: "Question", type: "text" },
          { attachmentId: "file-1", type: "file" }
        ]
      })
    ).toBe("Question");
  });
});
