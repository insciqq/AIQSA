import { describe, expect, it } from "vitest";
import { resolveWorkspaceOutputLink } from "./workspaceLinks";

const files = [
  { attachmentId: "att-1", byteSize: 10, fileName: "report.md", mimeType: "text/markdown", relativePath: "report.md" },
  { attachmentId: "att-2", byteSize: 10, fileName: "report.md", mimeType: "text/markdown", relativePath: "nested/report.md" }
];

describe("resolveWorkspaceOutputLink", () => {
  it("resolves only an exact run output path of the same run", () => {
    expect(resolveWorkspaceOutputLink({ generatedFiles: files, href: "sandbox:/workspace/output/run-1/report.md", runId: "run-1" }))
      .toEqual({ file: files[0], kind: "download" });
    expect(resolveWorkspaceOutputLink({ generatedFiles: files, href: "sandbox:///workspace/output/run-1/nested/report.md", runId: "run-1" }))
      .toEqual({ file: files[1], kind: "download" });
    expect(resolveWorkspaceOutputLink({ generatedFiles: files, href: "sandbox:/workspace/output/run-1/nested%2Freport.md?x=1", runId: "run-1" }))
      .toEqual({ file: files[1], kind: "download" });
  });

  it("renders every other sandbox link as inert text and ignores ordinary links", () => {
    const unresolved = { kind: "unresolved" };
    expect(resolveWorkspaceOutputLink({ generatedFiles: files, href: "sandbox:/workspace/output/run-2/report.md", runId: "run-1" })).toEqual(unresolved);
    expect(resolveWorkspaceOutputLink({ generatedFiles: files, href: "sandbox:/workspace/output/run-1/../run-2/report.md", runId: "run-1" })).toEqual(unresolved);
    expect(resolveWorkspaceOutputLink({ generatedFiles: files, href: "sandbox:/workspace/output/run-1/other/report.md", runId: "run-1" })).toEqual(unresolved);
    expect(resolveWorkspaceOutputLink({ generatedFiles: files, href: "sandbox:/workspace/project/report.md", runId: "run-1" })).toEqual(unresolved);
    expect(resolveWorkspaceOutputLink({ generatedFiles: files, href: "sandbox:/workspace/output/run-1/report.md", runId: null })).toEqual(unresolved);
    expect(resolveWorkspaceOutputLink({ generatedFiles: [], href: "sandbox:/workspace/output/run-1/report.md", runId: "run-1" })).toEqual(unresolved);
    expect(resolveWorkspaceOutputLink({ generatedFiles: files, href: "https://example.com/report.md", runId: "run-1" })).toBeNull();
    expect(resolveWorkspaceOutputLink({ generatedFiles: files, href: "file:///workspace/output/run-1/report.md", runId: "run-1" })).toBeNull();
  });
});
