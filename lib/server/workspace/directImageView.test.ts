import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { createWorkspaceImageViewer, supportsWorkspaceImageView } from "./directImageView";
import { snapshotToolExecutionResult, parsePersistedToolExecutionResult } from "../runs/toolExecutionPersistence";
import { openAIResponsesToolBridge, openRouterChatToolBridge, anthropicMessagesToolBridge, geminiInteractionsToolBridge } from "../tools/bridges";
import type { ProviderRunRequest } from "../providers/types";
import type { createWorkspaceSelectedCaptures } from "./selectedCapture";
import { workspaceImageInput, workspaceImageInputForRun } from "./imageInputs";

const request = { workspaceImageView: true, workspace: {}, params: { maxOutputTokens: 2048 },
  modelCapabilities: { contextWindow: 128000 } } as unknown as ProviderRunRequest;
const call = { id: "view-1", name: "view_workspace_image", arguments: { path: "/workspace/project/preview.png" } };
const context = { request, runId: "run-1", userId: "user-1", persistedToolCallId: "tool-1" };
async function fixture() {
  const bytes = await sharp({ create: { width: 24, height: 16, channels: 3, background: "#3ba47c" } }).png().toBuffer();
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const access = vi.fn(async () => {});
  const captures = { create: vi.fn(async () => ({ id: "a".repeat(32) })), release: vi.fn(async () => {}),
    retain: vi.fn(async () => ({})), lookup: vi.fn(async () => ({})),
    imageSource: vi.fn(async () => ({ captureId: "a".repeat(32), relativePath: "project/preview.png", byteSize: bytes.length, checksum,
      assertAccess: access, open: async () => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }) })) };
  return { bytes, captures, access, viewer: createWorkspaceImageViewer(captures as unknown as ReturnType<typeof createWorkspaceSelectedCaptures>) };
}
describe("Workspace direct image delivery", () => {
  it("maps exact output paths to capture's run-scoped output root without double prefixing", () => {
    expect(workspaceImageInputForRun({ path: "/workspace/output/run-1/a.png" }, "/workspace/output/run-1").file)
      .toEqual({ root: "output", relativePath: "a.png" });
    expect(workspaceImageInputForRun({ path: "output/a.png" }, "/workspace/output/run-1").file.relativePath).toBe("a.png");
    expect(() => workspaceImageInputForRun({ path: "/workspace/output/other/a.png" }, "/workspace/output/run-1")).toThrow("workspace_image_invalid");
  });
  it("retains exact evidence, persists no pixels and materializes actual correlated Responses image output", async () => {
    const f = await fixture();
    const result = await f.viewer.execute(call, context);
    expect(f.captures.retain).toHaveBeenCalledOnce();
    for (const bridge of [openRouterChatToolBridge, anthropicMessagesToolBridge, geminiInteractionsToolBridge]) {
      expect(() => bridge.appendToolResult(undefined, result)).toThrow("workspace_image_unavailable");
    }
    const stored = snapshotToolExecutionResult(result, 32768);
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored)).not.toContain("base64");
    const jsonb = JSON.parse(JSON.stringify(stored));
    // PostgreSQL JSONB may reorder object keys; identity is canonical, not insertion order.
    jsonb.content[1].value.descriptor = Object.fromEntries(Object.entries(jsonb.content[1].value.descriptor).reverse());
    const recovered = parsePersistedToolExecutionResult(call, jsonb)!;
    const durable = { ...request, providerToolMessages: [openAIResponsesToolBridge.appendToolResult(undefined, recovered)] };
    const wire = await f.viewer.materialize(durable, "run-1", "user-1");
    const output = wire.providerToolMessages![0] as { call_id: string; output: Array<{ type: string; image_url?: string }> };
    expect(output.call_id).toBe(call.id);
    expect(output.output[1]!.type).toBe("input_image");
    const image = Buffer.from(output.output[1]!.image_url!.split(",")[1]!, "base64");
    expect(await sharp(image).metadata()).toMatchObject({ width: 24, height: 16, format: "png" });
    expect(JSON.stringify(durable)).not.toContain("base64");
    expect(f.captures.create).toHaveBeenCalledOnce();
    expect(f.captures.lookup).toHaveBeenCalled();
  });
  it("refuses forged descriptors, revoked references, unsupported main capability and payload overflow", async () => {
    const f = await fixture();
    const result = await f.viewer.execute(call, context);
    const durable = { ...request, providerToolMessages: [openAIResponsesToolBridge.appendToolResult(undefined, result)] };
    await expect(f.viewer.materialize({ ...durable, workspaceImageView: undefined }, "run-1", "user-1")).rejects.toMatchObject({ code: "workspace_image_unavailable" });
    await expect(f.viewer.materialize({ ...durable, modelCapabilities: { ...request.modelCapabilities,
      imageInputLimits: { imageBytes: 1, imageCount: 1, imagePixels: 1, payloadBytes: 1 } } }, "run-1", "user-1")).rejects.toMatchObject({ code: "workspace_image_limit_exceeded" });
    const forged = structuredClone(durable);
    (forged.providerToolMessages![0] as { output: Array<{ value: { descriptor: { checksum: string } } }> }).output[1]!.value.descriptor.checksum = "b".repeat(64);
    await expect(f.viewer.materialize(forged, "run-1", "user-1")).rejects.toThrow("unavailable");
    f.access.mockRejectedValue(new Error("revoked"));
    await expect(f.viewer.materialize(durable, "run-1", "user-1")).rejects.toThrow("revoked");
    expect(f.captures.create).toHaveBeenCalledOnce();
  });
  it("releases an unpublished capture after failed durable retention", async () => {
    const f = await fixture(); f.captures.retain.mockRejectedValue(new Error("storage_failed"));
    await expect(f.viewer.execute(call, context)).rejects.toThrow("storage_failed");
    expect(f.captures.release).toHaveBeenCalledOnce();
  });
  it("admits verified supported routes only", () => {
    expect(supportsWorkspaceImageView("openai_responses_compatible", true)).toBe(true);
    for (const [adapter, verified] of [["openai_responses_native", false], ["openrouter_chat_completions", true], ["fake", true]] as const) {
      expect(supportsWorkspaceImageView(adapter, verified)).toBe(false);
    }
  });
  it.each(["/etc/passwd", "/workspace/secrets/file.png", "https://image.invalid/a.png", "project/../secrets/a.png", "inbox/index.json"])("rejects nonselected authority %s", path => {
    expect(() => workspaceImageInput({ path })).toThrow();
  });
});
