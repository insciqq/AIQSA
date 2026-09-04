import { describe, expect, it } from "vitest";
import {
  decodeChatWorkspaceState,
  decodeThreadGeneratedFile,
  decodeWorkspacePolicyResponse,
  isWorkspaceErrorCode
} from "./workspace";

describe("workspace browser contracts", () => {
  it("decodes the bounded chat projection without leaking additive runtime data", () => {
    expect(decodeChatWorkspaceState({
      available: true,
      enabled: true,
      internetEnabled: true,
      runtimeSandboxId: "must-not-leak",
      sessionState: "ready"
    })).toEqual({
      available: true,
      enabled: true,
      internetEnabled: true,
      sessionState: "ready"
    });
    expect(decodeChatWorkspaceState({
      available: false,
      enabled: false,
      internetEnabled: null,
      sessionState: null,
      unavailableReason: "runtime_unavailable"
    })).not.toBeNull();
    expect(decodeChatWorkspaceState({
      available: true,
      enabled: false,
      internetEnabled: null,
      sessionState: null,
      unavailableReason: "runtime_unavailable"
    })).toBeNull();
  });

  it("decodes only client-safe generated file metadata", () => {
    expect(decodeThreadGeneratedFile({
      attachmentId: "attachment-1",
      byteSize: 42,
      checksum: "private",
      fileName: "result.bin",
      mimeType: "application/octet-stream",
      relativePath: "nested/result.bin",
      storageKey: "private"
    })).toEqual({
      attachmentId: "attachment-1",
      byteSize: 42,
      fileName: "result.bin",
      mimeType: "application/octet-stream",
      relativePath: "nested/result.bin"
    });
    expect(decodeThreadGeneratedFile({
      attachmentId: "attachment-1",
      byteSize: -1,
      fileName: "bad.bin",
      mimeType: "application/octet-stream",
      relativePath: "bad.bin"
    })).toBeNull();
  });

  it("recognizes only stable workspace error codes", () => {
    expect(isWorkspaceErrorCode("workspace_tool_timeout")).toBe(true);
    expect(isWorkspaceErrorCode("raw_microsandbox_failure")).toBe(false);
  });

  it("decodes the client-safe administrator policy projection", () => {
    expect(decodeWorkspacePolicyResponse({
      workspace: {
        enabled: true,
        internetEnabled: false,
        runtime: {
          imageReady: true,
          mcpVersion: "0.6.16",
          runtimeVersion: "0.6.16",
          state: "ready",
          token: "must-not-leak",
          virtualizationReady: true
        },
        version: 4
      }
    })).toEqual({
      enabled: true,
      internetEnabled: false,
      runtime: {
        imageReady: true,
        mcpVersion: "0.6.16",
        runtimeVersion: "0.6.16",
        state: "ready",
        virtualizationReady: true
      },
      version: 4
    });
    expect(decodeWorkspacePolicyResponse({
      workspace: { enabled: true, internetEnabled: true, runtime: { state: "broken" }, version: 1 }
    })).toBeNull();
  });
});
