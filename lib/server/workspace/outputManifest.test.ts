import { describe, expect, it } from "vitest";
import { outputIdentities, parseWorkspaceFileSelection, selectedCaptureRequest } from "./outputManifest";

const operation = { generation: 3, owner: "run:producer" };
const selection = { files: [{ root: "project" as const, relativePath: "绘图 🧪.png" }], producerOperation: operation };
const input = { capture: { id: "a".repeat(32), create: true }, selection, operation,
  modelRunId: "run", outputDirectory: "/workspace/output/run" };

describe("selected Workspace capture boundary", () => {
  it("normalizes exact sources without merging the same name across roots", () => {
    expect(parseWorkspaceFileSelection({ producerOperation: operation, files: [
      { root: "project", relativePath: "report.txt" }, { root: "output", relativePath: "report.txt" },
      { root: "inbox", relativePath: "messages/message/attachment--report.txt" }
    ] }).files.map(file => file.root)).toEqual(["inbox", "output", "project"]);
    expect(selectedCaptureRequest(input)).toEqual(selection);
  });

  it.each([
    { root: "secrets", relativePath: "credential" }, { root: "project", relativePath: "../secrets/key" },
    { root: "project", relativePath: "/etc/passwd" }, { root: "project", relativePath: "x//y" },
    { root: "project", relativePath: "x\\y" }, { root: "project", relativePath: "x\0y" },
    { root: "project", relativePath: "file/./x" }, { root: "inbox", relativePath: "index.json" },
    { root: "inbox", relativePath: "messages/message/manifest.json" },
    { root: "inbox", relativePath: "messages/message/nested/attachment--x" }
  ])("rejects traversal, managed files and unsupported source %j", (file) => {
    expect(() => parseWorkspaceFileSelection({ ...selection, files: [file] })).toThrow();
  });

  it("bounds counts and rejects aliases for one source", () => {
    expect(() => parseWorkspaceFileSelection({ ...selection, files: [] })).toThrow();
    expect(() => parseWorkspaceFileSelection({ ...selection, files: [...selection.files, ...selection.files] })).toThrow();
    expect(() => parseWorkspaceFileSelection(selection, 0)).toThrow();
    expect(() => parseWorkspaceFileSelection({ ...selection, files: [{ root: "project", relativePath: "a/".repeat(256) + "x" }] })).toThrow();
  });

  it("requires exact creation authority and current-run output root", () => {
    expect(() => selectedCaptureRequest({ ...input, capture: undefined })).toThrow();
    expect(() => selectedCaptureRequest({ ...input, operation: undefined })).toThrow();
    expect(() => selectedCaptureRequest({ ...input, outputDirectory: "/workspace/output/other" })).toThrow();
    expect(() => selectedCaptureRequest({ ...input, operation: { generation: 4, owner: "run:recovery" } })).toThrow();
    expect(selectedCaptureRequest({ ...input, capture: { ...input.capture, create: false },
      operation: { generation: 4, owner: "run:recovery" } })).toEqual(selection);
  });

  it("admits an empty selected regular file without changing final-export manifests", () => {
    const empty = [{ relativePath: "project/empty.txt", byteSize: 0, checksum: "a".repeat(64), mimeType: "text/plain" }];
    expect(outputIdentities(empty, undefined, true)).toEqual(empty);
    expect(() => outputIdentities(empty)).toThrow();
  });
});
