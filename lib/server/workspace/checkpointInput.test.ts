import { describe, expect, it } from "vitest";
import { parseWorkspaceCheckpointInput } from "./checkpointInput";

describe("Workspace checkpoint publication input", () => {
  it("normalizes selected deliverables against the exact run output root", () => {
    expect(parseWorkspaceCheckpointInput({ files: ["/workspace/output/run-1/preview.png", "/workspace/project/art/source.psd"],
      description: " Prepared layers ", capture_id: "a".repeat(32) }, "run-1")).toEqual({
      files: [{ root: "output", relativePath: "preview.png" }, { root: "project", relativePath: "art/source.psd" }],
      description: "Prepared layers", captureId: "a".repeat(32)
    });
  });
  it.each(["/workspace/inbox/messages/m/a--source.png", "/workspace/output/other/preview.png", "/workspace/SECRETS.md",
    "project/.credentials", "project/tmp/result.png", "project/../SECRETS.md", "project/a\\b", "project/node_modules/a.png"])(
    "rejects non-deliverable authority %s", path => {
      expect(() => parseWorkspaceCheckpointInput({ files: [path], description: "Draft" }, "run-1")).toThrow("workspace_checkpoint_invalid");
    });
  it("bounds and de-duplicates canonical selections before capture", () => {
    for (const files of [[], Array.from({ length: 9 }, (_, i) => `project/${i}.png`), ["project/a.png", "/workspace/project/a.png"]]) {
      expect(() => parseWorkspaceCheckpointInput({ files, description: "Draft" }, "run-1")).toThrow("workspace_checkpoint_invalid");
    }
    expect(() => parseWorkspaceCheckpointInput({ files: ["project/a.png"], description: "Draft", storageKey: "foreign" }, "run-1")).toThrow();
    expect(() => parseWorkspaceCheckpointInput({ files: ["project/a.png"], description: " ", capture_id: "not-a-capture" }, "run-1")).toThrow();
  });
});
