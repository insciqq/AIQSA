// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileSystemStorageAdapter, getStoredObjectStream } from "./storage";
import { joinedUploadParts, meteredUploadBody } from "./workspaceUploadStreams";
import { validateUploadInspection } from "./validation";

const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const bytes = (text: string) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(text)); controller.close(); } });

describe("Workspace upload streaming boundaries", () => {
  it.each([
    ["abc", 2, digest("abc"), "upload_size_mismatch"],
    ["ab", 3, digest("ab"), "upload_size_mismatch"],
    ["abc", 3, digest("wrong"), "upload_checksum_mismatch"]
  ] as const)("rejects actual byte/checksum mismatch without publishing", async (text, byteSize, checksum, code) => {
    const root = await mkdtemp(join(tmpdir(), "aiqsa-upload-unit-")); roots.push(root);
    const storage = createFileSystemStorageAdapter(root);
    const metered = meteredUploadBody(bytes(text), { byteSize, checksum, controller: new AbortController() });
    await expect(storage.putObjectStream!({ body: metered.body, byteSize, checksum, contentType: "application/octet-stream", storageKey: "original" })).rejects.toThrow(code);
    expect(metered.verified()).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });
  it("does not read ahead while the consumer is idle and interrupts a stalled producer", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ pull() { reads += 1; }, cancel }, { highWaterMark: 0 });
    const abort = new AbortController();
    const metered = meteredUploadBody(source, { byteSize: 3, checksum: digest("abc"), controller: abort, idleMs: 50 });
    await Promise.resolve(); expect(reads).toBe(0);
    const result = metered.body.getReader().read().catch(error => error);
    await vi.advanceTimersByTimeAsync(51);
    expect(abort.signal.aborted).toBe(true); expect(cancel).toHaveBeenCalledTimes(1);
    expect(await result).toMatchObject({ message: "upload_timeout" });
  });
  it("joins one verified part at a time, preserves bytes and cleans crash leftovers by exact key", async () => {
    const root = await mkdtemp(join(tmpdir(), "aiqsa-upload-unit-")); roots.push(root);
    const storage = createFileSystemStorageAdapter(root);
    await storage.putObject({ body: Buffer.from("first"), contentType: "text/plain", storageKey: "1" });
    await storage.putObject({ body: Buffer.from("second"), contentType: "text/plain", storageKey: "2" });
    const get = vi.spyOn(storage, "getObjectStream");
    const joined = joinedUploadParts(storage, [
      { byteSize: 5, checksum: digest("first"), storageKey: "1" },
      { byteSize: 6, checksum: digest("second"), storageKey: "2" }
    ], new AbortController().signal);
    expect(get).not.toHaveBeenCalled();
    await storage.putObjectStream!({ body: joined, byteSize: 11, checksum: digest("firstsecond"), contentType: "text/plain", storageKey: "final" });
    expect(await readFile(join(root, "final"), "utf8")).toBe("firstsecond");
    await writeFile(join(root, `final.upload-${randomUUID()}`), "abandoned");
    await writeFile(join(root, `other.upload-${randomUUID()}`), "unrelated");
    await storage.deleteObject("final");
    expect((await readdir(root)).filter(name => name.startsWith("final"))).toEqual([]);
    expect((await readdir(root)).some(name => name.startsWith("other.upload-"))).toBe(true);
  });
  it("refuses a buffered adapter before reading a large original", async () => {
    const getObject = vi.fn();
    await expect(getStoredObjectStream({ getObject, putObject: vi.fn(), deleteObject: vi.fn() }, "object", { requireStreaming: true })).rejects.toThrow("stored_object_streaming_unavailable");
    expect(getObject).not.toHaveBeenCalled();
  });
  it("accepts UTF-8 characters split by the inspection boundary while rejecting invalid text", () => {
    const sample = Buffer.concat([Buffer.from("a".repeat(65535)), Buffer.from([0xd0])]);
    const input = { byteSize: sample.length + 1, fileName: "data.csv", maxBytes: 100000, mimeType: "text/csv", scope: "workspace" as const, foundNeedles: [] };
    expect(validateUploadInspection({ ...input, sample }).ok).toBe(true);
    expect(validateUploadInspection({ ...input, sample: Buffer.from([0xff, 0xff]) }).ok).toBe(false);
  });
});
