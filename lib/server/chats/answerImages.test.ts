import { describe, expect, it } from "vitest";
import { answerGeneratedImages, BACKGROUND_SUBAGENT_IMAGES_SELECT, type AnswerImageRun } from "./answerImages";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 12, minute));
const image = (id: string, minute: number, overrides: Readonly<{ attachmentId?: string; messageId?: string; origin?: string }> = {}) => ({
  createdAt: at(minute), id, messageId: overrides.messageId ?? "answer", origin: overrides.origin ?? "IMAGE_OUTPUT",
  metadata: { image: { attachmentId: overrides.attachmentId ?? id, byteSize: 100, fileName: "image.png", height: 8, mimeType: "image/png",
    sourceAttachmentIds: [], width: 8 } } });
const ids = (run: AnswerImageRun) => answerGeneratedImages(run).map((entry) => entry.attachmentId);

describe("an answer's generated images", () => {
  it("are its own run's alone, as they were, when no background sub-agent drew any", () => {
    const own = [image("own-2", 2), image("own-1", 1), image("export", 3, { origin: "WORKSPACE_OUTPUT" }), image("forged", 4, { attachmentId: "x" })];
    // The run's own rows keep the order they were read in, whatever their messages, as before background images existed.
    expect(ids({ assistantMessageId: "answer", workspaceProducedAttachments: own })).toEqual(["own-2", "own-1"]);
    expect(ids({ assistantMessageId: "answer", subagentTurnsStarted: [], workspaceProducedAttachments: own })).toEqual(["own-2", "own-1"]);
  });

  it("take in what its background sub-agents and their children drew for it, in the order the images were made, each once", () => {
    const run: AnswerImageRun = { assistantMessageId: "answer", workspaceProducedAttachments: [image("own-1", 1), image("own-4", 4)],
      subagentTurnsStarted: [
        { executionRun: { workspaceProducedAttachments: [image("bg-3", 3), image("bg-2", 2)],
          subagentTurnsStarted: [{ executionRun: { workspaceProducedAttachments: [image("child-5", 5)] } }] } },
        // A turn still being admitted has no run yet.
        { executionRun: null },
        { executionRun: { workspaceProducedAttachments: [image("bg-3", 3)] } }
      ] };
    expect(ids(run)).toEqual(["own-1", "bg-2", "bg-3", "own-4", "child-5"]);
  });

  it("never take an image on another message, of another kind, or whose record names another file", () => {
    const run: AnswerImageRun = { assistantMessageId: "answer", workspaceProducedAttachments: [image("own-1", 1)],
      subagentTurnsStarted: [{ executionRun: { workspaceProducedAttachments: [image("elsewhere", 2, { messageId: "other-answer" }),
        image("upload", 3, { origin: "USER_UPLOAD" }), image("forged", 4, { attachmentId: "own-1" }), image("bg", 5)] } }] };
    expect(ids(run)).toEqual(["own-1", "bg"]);
    // Without its answer's message to match, a run takes none of its sub-agents' images.
    expect(ids({ ...run, assistantMessageId: null })).toEqual(["own-1"]);
  });

  it("are reached only through the background turns the answer's run started, and only as image outputs", () => {
    const turns = BACKGROUND_SUBAGENT_IMAGES_SELECT.subagentTurnsStarted;
    expect(turns.where).toEqual({ mode: "background" });
    expect(turns.select.executionRun.select.workspaceProducedAttachments.where).toEqual({ origin: "IMAGE_OUTPUT" });
    const children = turns.select.executionRun.select.subagentTurnsStarted;
    expect(children.where).toEqual({ mode: "background" });
    expect(children.select.executionRun.select.workspaceProducedAttachments.where).toEqual({ origin: "IMAGE_OUTPUT" });
  });
});
