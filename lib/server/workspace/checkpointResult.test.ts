import { describe, expect, it } from "vitest";
import { workspaceCheckpointResult } from "./checkpointResult";

describe("checkpoint_outputs result", () => {
  it("lists each saved file's attachment_id and MIME type and says a saved file is not an artifact", () => {
    const checkpoint = { id: "checkpoint-1", description: "Converted report", createdAt: "2026-10-09T00:00:00.000Z" };
    const result = workspaceCheckpointResult({ id: "call-1", name: "checkpoint_outputs", arguments: {} }, checkpoint, "a".repeat(32), [{
      attachmentId: "attachment-1", byteSize: 2048, fileName: "report.html", mimeType: "text/html", relativePath: "output/run/report.html", checkpoint
    }]);
    const value = (result.content[0] as { type: "json"; value: Record<string, unknown> }).value;
    expect(value.files).toEqual([{ attachment_id: "attachment-1", path: "output/run/report.html", file_name: "report.html", mime_type: "text/html", byte_size: 2048 }]);
    expect(value.meaning).toContain("not an artifact");
    expect(value.meaning).toContain("call create_artifact with asset_ref = attachment_id and mimeType = mime_type");
  });
});
