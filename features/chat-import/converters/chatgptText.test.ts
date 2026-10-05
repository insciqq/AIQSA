// @vitest-environment node
import { describe, expect, it } from "vitest";
import { CITE, ENTITY, message, text } from "./chatgpt.testFixtures";
import { chatGptMessageText, resolveCitations, resolveLegacyCitations, type SkipCounts } from "./chatgptText";

const web = (matched: string, url: string, title = "Site") => ({ items: [{ title, url }], matched_text: matched, type: "grouped_webpages" });

describe("ChatGPT message text", () => {
  it("resolves repeated markers in order and removes markers whose reference is missing or unusable", () => {
    const body = `A ${CITE("turn0search0")}, B ${CITE("turn0search0")}, C ${CITE("turn0search1")} and D ${CITE("turn0search2")}.`;
    expect(resolveCitations(body, [
      web(CITE("turn0search0"), "https://a.example/"),
      web(CITE("turn0search0"), "https://b.example/", "Other"),
      web(CITE("turn0search2"), "javascript:alert(1)")
    ])).toBe("A ([Site](https://a.example/)), B ([Other](https://b.example/)), C and D.");
  });

  it("keeps the name of an entity marker without a reference and strips every private-use character", () => {
    expect(resolveCitations(`Met ${ENTITY("Grace Hopper")} once\ue2ff.\ue200broken`, undefined)).toBe("Met Grace Hopper once.broken");
  });

  it("resolves legacy citations counted in UTF-16 units or in code points", () => {
    const citation = (start: number, end: number) => ({ end_ix: end, metadata: { title: "Paper", url: "https://paper.example/" }, start_ix: start });
    expect(resolveLegacyCitations("See 【3†source】.", [citation(4, 14)])).toBe("See ([Paper](https://paper.example/)).");
    // One astral character before the marker: code-point offsets are one less than UTF-16 offsets.
    expect(resolveLegacyCitations("🙂 See 【3†source】.", [citation(6, 16)])).toBe("🙂 See ([Paper](https://paper.example/)).");
    expect(resolveLegacyCitations("No marker here at all.", [citation(0, 5)])).toBe("No marker here at all.");
  });

  it("skips system, hidden, reasoning and tool traffic, and keeps interpreter code", () => {
    const skipped = [
      message("system", text("System prompt")),
      message("user", text("Hidden"), { metadata: { is_visually_hidden_from_conversation: true } }),
      message("assistant", { content_type: "thoughts", thoughts: [] }),
      message("assistant", { content_type: "reasoning_recap", content: "Thought" }),
      message("assistant", text("User likes tea"), { recipient: "bio" }),
      message("assistant", { content_type: "code", text: "search(\"x\")" }, { recipient: "browser" }),
      message("tool", text("Browsing result"), { name: "browser" }),
      message("tool", { content_type: "tether_quote", text: "Quote", title: "T", url: "https://q.example/" }),
      message("assistant", text("", " ")),
      message("critic", text("Review")),
      null
    ];
    for (const item of skipped) expect(chatGptMessageText(item, {})).toBeNull();
    expect(chatGptMessageText(message("assistant", { content_type: "code", language: "python", text: "1 + 1" }, { recipient: "python" }), {}))
      .toEqual({ role: "assistant", text: "```python\n1 + 1\n```" });
  });

  it("never dumps an object part as JSON: text-bearing parts are joined, anything else is a counted note", () => {
    const counts: SkipCounts = {};
    const converted = chatGptMessageText(message("user", {
      content_type: "multimodal_text",
      parts: ["Before", { content_type: "something_new", text: "Inline text" }, { content_type: "mystery_blob", size: 3 }, "After"]
    }), counts);
    expect(converted).toEqual({ role: "user", text: "Before\n\nInline text\n\nAfter\n\n_[Attachment not imported]_" });
    expect(counts).toEqual({ attachment: 1 });
  });

  it("counts several images in one message once each and escapes file names in notes", () => {
    const counts: SkipCounts = {};
    const image = (id: string) => ({ asset_pointer: `file-service://${id}`, content_type: "image_asset_pointer" });
    expect(chatGptMessageText(message("user", { content_type: "multimodal_text", parts: [image("file-1"), image("file-2")] }, {
      metadata: { attachments: [{ id: "file-1", name: "a.png" }, { id: "file-2", name: "b.png" }, { id: "file-3", name: "data_[1].csv" }] }
    }), counts)).toEqual({ role: "user", text: "_[2 images not imported]_\n\n_[Attachment not imported: data\\_\\[1\\].csv]_" });
    expect(counts).toEqual({ attachment: 1, image: 2 });
  });
});
