// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isWorkspaceBrowserSessionFilename, WORKSPACE_BROWSER_SESSION_MAX_BYTES, WORKSPACE_BROWSER_SESSION_MAX_COUNT,
  WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES, WORKSPACE_SECRET_VALUE_MAX_BYTES
} from "@/lib/contracts/workspaceSecrets";
import { parseWorkspaceSecretValue } from "./validation";
import { workspaceBrowserSessionChecksum, workspaceBrowserSessionError } from "./browserSession";
import { readWorkspaceBrowserCollection, type WorkspaceBrowserSaveItem } from "./browserCollection";
import type { WorkspaceBrowserCollection } from "../runtime";

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

  it("admits states between the former 512 KiB cap and the exact raw byte limit, and skips the next byte", () => {
    for (const size of [512 * 1024 + 1, WORKSPACE_BROWSER_SESSION_MAX_BYTES]) {
      const padded = Buffer.concat([bytes, Buffer.alloc(size - bytes.length, 32)]);
      expect(workspaceBrowserSessionError("shop.json", padded)).toBeNull();
      const value = { kind: "browser_session", originalName: "shop.json", base64: padded.toString("base64") };
      // The serialized browser value may exceed the ordinary 768 KiB value cap.
      expect(parseWorkspaceSecretValue(value)).toEqual(value);
      if (size === WORKSPACE_BROWSER_SESSION_MAX_BYTES) expect(JSON.stringify(value).length).toBeGreaterThan(WORKSPACE_SECRET_VALUE_MAX_BYTES);
    }
    const over = Buffer.concat([bytes, Buffer.alloc(WORKSPACE_BROWSER_SESSION_MAX_BYTES + 1 - bytes.length, 32)]);
    expect(workspaceBrowserSessionError("shop.json", over)).toBe("browser_session_too_large");
    expect(() => parseWorkspaceSecretValue({ kind: "browser_session", originalName: "shop.json", base64: over.toString("base64") }))
      .toThrow("workspace_browser_session_invalid");
    // Ordinary files keep their own limit.
    expect(() => parseWorkspaceSecretValue({ kind: "file", originalName: "shop.json", base64: Buffer.alloc(512 * 1024 + 1).toString("base64") }))
      .toThrow("workspace_secret_invalid");
  });

  async function items(collection: WorkspaceBrowserCollection, signal = AbortSignal.timeout(5_000)) {
    const result: WorkspaceBrowserSaveItem[] = [];
    for await (const item of readWorkspaceBrowserCollection(collection, signal)) result.push(item);
    return result;
  }

  it("reads only bounded, checksum-verified originals while preserving valid siblings", async () => {
    const badChecksum = { ...file(), checksum: "b".repeat(64) };
    const overflow = { ...file(), byteSize: bytes.byteLength - 1 };
    const unsafe = file(bytes, "../private-cookie.json");
    const tooLarge = { ...file(bytes, "large.json"), byteSize: WORKSPACE_BROWSER_SESSION_MAX_BYTES + 1 };
    const result = await items({ files: [badChecksum, overflow, unsafe, tooLarge, file()], skipped: ["browser_session_too_large"] });
    expect(result).toEqual([{ skipped: "browser_session_read_failed" }, { skipped: "browser_session_read_failed" },
      { skipped: "browser_session_invalid" }, { skipped: "browser_session_too_large" }, { fileName: "shop.example.json", bytes }]);
    expect(JSON.stringify(result.filter((item) => "skipped" in item))).not.toContain("synthetic-cookie");
  });

  it("pulls each state only when the consumer asks, so one save holds one state", async () => {
    const pulled: string[] = [];
    const lazy = (name: string) => ({ ...file(bytes, name),
      body: new ReadableStream<Uint8Array>({ pull(controller) { pulled.push(name); controller.enqueue(bytes); controller.close(); } }, { highWaterMark: 0 }) });
    const iterator = readWorkspaceBrowserCollection({ files: [lazy("a.json"), lazy("b.json"), lazy("c.json")], skipped: [] }, AbortSignal.timeout(5_000));
    expect(pulled).toEqual([]);
    expect((await iterator.next()).value).toEqual({ fileName: "a.json", bytes });
    expect(pulled).toEqual(["a.json"]);
    expect((await iterator.next()).value).toEqual({ fileName: "b.json", bytes });
    expect(pulled).toEqual(["a.json", "b.json"]);
    await iterator.return(undefined);
    expect(pulled).toEqual(["a.json", "b.json"]);
  });

  it("does not read past the per-save count and aggregate budgets", async () => {
    const pulled: string[] = [];
    const sized = (name: string, byteSize: number) => ({ ...file(bytes, name), byteSize,
      // Closing early fails the size check without allocating synthetic megabytes.
      body: new ReadableStream<Uint8Array>({ pull(controller) { pulled.push(name); controller.close(); } }, { highWaterMark: 0 }) });
    const perFile = WORKSPACE_BROWSER_SESSION_MAX_BYTES;
    const fit = WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES / perFile;
    const budget = await items({ skipped: [], files: [
      ...Array.from({ length: fit }, (_, index) => sized(`fit-${index}.json`, perFile)), sized("over.json", 1)
    ] });
    expect(budget.at(-1)).toEqual({ skipped: "browser_session_total_limit" });
    expect(pulled).not.toContain("over.json");
    pulled.length = 0;
    const count = await items({ skipped: [], files: Array.from({ length: WORKSPACE_BROWSER_SESSION_MAX_COUNT + 1 }, (_, index) => sized(`n-${index}.json`, 1)) });
    expect(count.at(-1)).toEqual({ skipped: "browser_session_limit" });
    expect(pulled).toHaveLength(WORKSPACE_BROWSER_SESSION_MAX_COUNT);
  });

  it("cancels a stalled byte source when the settlement deadline expires", async () => {
    let cancelled = false;
    const stalled = { ...file(), body: new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }) };
    const controller = new AbortController();
    const result = items({ files: [stalled], skipped: [] }, controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});
