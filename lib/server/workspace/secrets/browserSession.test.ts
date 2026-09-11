// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isWorkspaceBrowserSessionFilename, WORKSPACE_BROWSER_SESSION_MAX_BYTES } from "@/lib/contracts/workspaceSecrets";
import { parseWorkspaceSecretValue } from "./validation";
import { workspaceBrowserSessionChecksum, workspaceBrowserSessionError } from "./browserSession";
import { readWorkspaceBrowserCollection } from "./browserCollection";

const state = { cookies: [{ name: "session", value: "synthetic-cookie", domain: "shop.example", path: "/", expires: -1,
  httpOnly: true, secure: true, sameSite: "Lax" }], origins: [{ origin: "https://shop.example", localStorage: [{ name: "cart", value: "Привет" }] }] };
const bytes = Buffer.from(JSON.stringify(state, null, 2).replaceAll("\n", "\r\n") + "\r\n");

function file(content = bytes, name = "shop.example.json") {
  return { relativePath: name, byteSize: content.byteLength, checksum: workspaceBrowserSessionChecksum(content),
    mimeType: "application/json", opaqueFileId: "a".repeat(64),
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(content); controller.close(); } }) };
}

describe("portable browser sessions", () => {
  it("preserves original UTF-8/CRLF storage_state bytes and supports ordinary browser fields", () => {
    const value = { kind: "browser_session", originalName: "shop.example.json", base64: bytes.toString("base64") };
    expect(parseWorkspaceSecretValue(value)).toEqual(value);
    expect(workspaceBrowserSessionError(value.originalName, bytes)).toBeNull();
    expect(workspaceBrowserSessionError("shop.example.json", Buffer.from(JSON.stringify({ ...state,
      cookies: state.cookies.map((cookie) => ({ ...cookie, partitionKey: "https://shop.example" })) })))).toBeNull();
  });

  it("rejects malformed states, nonportable origins and unsafe file names", () => {
    for (const name of ["../shop.json", "/shop.json", ".hidden.json", "shop/other.json", "shop\\other.json", "shop.json\n", "x".repeat(256) + ".json", "shop.JSON"]) {
      expect(isWorkspaceBrowserSessionFilename(name)).toBe(false);
      expect(workspaceBrowserSessionError(name, bytes)).toBe("browser_session_invalid");
    }
    for (const value of [null, [], {}, { cookies: [], origins: {} }, { cookies: [{}], origins: [] },
      { cookies: [], origins: [{ origin: "file:///etc/passwd", localStorage: [] }] },
      { cookies: [], origins: [{ origin: "https://shop.example/path", localStorage: [] }] }]) {
      expect(workspaceBrowserSessionError("shop.json", Buffer.from(JSON.stringify(value)))).toBe("browser_session_invalid");
    }
    expect(workspaceBrowserSessionError("shop.json", Buffer.from([0xff, 0xfe]))).toBe("browser_session_invalid");
    expect(() => parseWorkspaceSecretValue({ kind: "browser_session", originalName: "shop.json", base64: Buffer.from("{}").toString("base64") }))
      .toThrow("workspace_browser_session_invalid");
  });

  it("admits the exact raw byte limit and skips the next byte", () => {
    const maximum = Buffer.concat([bytes, Buffer.alloc(WORKSPACE_BROWSER_SESSION_MAX_BYTES - bytes.length, 32)]);
    expect(workspaceBrowserSessionError("shop.json", maximum)).toBeNull();
    expect(workspaceBrowserSessionError("shop.json", Buffer.concat([maximum, Buffer.from(" ")]))).toBe("browser_session_too_large");
  });

  it("reads only bounded, checksum-verified originals while preserving valid siblings", async () => {
    const badChecksum = { ...file(), checksum: "b".repeat(64) };
    const overflow = { ...file(), byteSize: bytes.byteLength - 1 };
    const unsafe = file(bytes, "../private-cookie.json");
    const result = await readWorkspaceBrowserCollection({ files: [badChecksum, overflow, unsafe, file()], skipped: ["browser_session_too_large"] }, AbortSignal.timeout(1_000));
    expect(result.files).toEqual([{ fileName: "shop.example.json", bytes }]);
    expect(result.skipped).toEqual(["browser_session_too_large", "browser_session_read_failed", "browser_session_read_failed", "browser_session_invalid"]);
    expect(JSON.stringify(result.skipped)).not.toContain("synthetic-cookie");
  });

  it("cancels a stalled byte source when the settlement deadline expires", async () => {
    let cancelled = false;
    const stalled = { ...file(), body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }) };
    const controller = new AbortController();
    const result = readWorkspaceBrowserCollection({ files: [stalled], skipped: [] }, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});
