// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkspaceConfig } from "./config";
import { WorkspaceOutputCaptureStore } from "./outputCapture";
import type { WorkspaceOutputStream } from "./runtime";

const config = getWorkspaceConfig({});
const input = { capture: { create: true, id: "a".repeat(32) }, modelRunId: "run", outputDirectory: "/workspace/output/run",
  runtimeSandboxId: "disk", sessionId: "session" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function output(text: string, relativePath = "report.txt"): WorkspaceOutputStream {
  return { body: new Blob([text]).stream(), byteSize: Buffer.byteLength(text), checksum: hash(text),
    mimeType: "text/plain", opaqueFileId: relativePath, relativePath };
}
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aiqsa-capture-test-"));
  roots.push(root);
  return { root, store: new WorkspaceOutputCaptureStore(root, config) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Workspace private output capture", () => {
  it.each(["delete", "replace", "rename", "extra"])("reads original bytes across a receiver restart and later guest %s", async (change) => {
    const { store, root } = await fixture();
    const guest = new Map([["report.txt", "original"]]);
    const collect = vi.fn(async () => [...guest].map(([path, text]) => output(text, path)));
    const first = await store.collect(input, collect);
    await first[0]!.body.cancel();
    if (change === "delete" || change === "rename") guest.delete("report.txt");
    if (change === "replace") guest.set("report.txt", "replaced");
    if (change === "rename" || change === "extra") guest.set("later.txt", "later");
    const recovered = await new WorkspaceOutputCaptureStore(root, config).collect({ ...input, capture: { ...input.capture, create: false } }, collect);
    expect(recovered.map((entry) => entry.relativePath)).toEqual(["report.txt"]);
    expect(await new Response(recovered[0]!.body).text()).toBe("original");
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it("distinguishes captured empty from an absent or interrupted capture", async () => {
    const { store, root } = await fixture();
    const current = vi.fn(async () => []);
    await expect(store.collect(input, current)).resolves.toEqual([]);
    const restart = new WorkspaceOutputCaptureStore(root, config);
    await expect(restart.collect({ ...input, capture: { ...input.capture, create: false } }, current)).resolves.toEqual([]);
    const absent = { ...input, capture: { create: false, id: "b".repeat(32) } };
    await expect(restart.collect(absent, current)).rejects.toMatchObject({ code: "workspace_output_export_failed" });
    const interrupted = { ...input, capture: { create: true, id: "c".repeat(32) } };
    await expect(store.collect(interrupted, async () => { throw new Error("source_unavailable"); })).rejects.toThrow();
    await expect(restart.collect({ ...interrupted, capture: { ...interrupted.capture, create: false } }, current)).rejects.toMatchObject({ code: "workspace_output_export_failed" });
    expect(current).toHaveBeenCalledTimes(1);
  });

  it("refuses a mismatched transfer and never recaptures replacement bytes", async () => {
    const { store } = await fixture();
    await expect(store.collect(input, async () => [{ ...output("original"), body: new Blob(["replaced"]).stream() }])).rejects.toMatchObject({ code: "workspace_output_export_failed" });
    const replacement = vi.fn(async () => [output("replaced")]);
    await expect(store.collect({ ...input, capture: { ...input.capture, create: false } }, replacement)).rejects.toMatchObject({ code: "workspace_output_export_failed" });
    expect(replacement).not.toHaveBeenCalled();
  });

  it("cancels a blocked source without certifying an empty capture", async () => {
    const { store } = await fixture();
    const controller = new AbortController();
    let opened!: () => void;
    const opening = new Promise<void>((resolve) => { opened = resolve; });
    const cancel = vi.fn();
    const blocked = new ReadableStream<Uint8Array>({ pull() { opened(); return new Promise<void>(() => undefined); }, cancel }, { highWaterMark: 0 });
    const attempt = store.collect({ ...input, signal: controller.signal }, async () => [{ ...output("original"), body: blocked }]);
    const rejected = expect(attempt).rejects.toThrow();
    await opening;
    controller.abort();
    await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
    const noEnumeration = vi.fn(async () => []);
    await expect(store.collect({ ...input, capture: { ...input.capture, create: false } }, noEnumeration)).rejects.toMatchObject({ code: "workspace_output_export_failed" });
    expect(noEnumeration).not.toHaveBeenCalled();
  });

  it.each(["short", "long", "interrupted"])("does not seal a %s source stream", async (fault) => {
    const { store } = await fixture();
    const source = fault === "interrupted" ? new ReadableStream<Uint8Array>({ pull(controller) {
      controller.error(new Error("synthetic_source_failure"));
    } }, { highWaterMark: 0 }) : new Blob([fault === "short" ? "short" : "longer than original"]).stream();
    await expect(store.collect(input, async () => [{ ...output("original"), body: source }])).rejects.toThrow();
    const noEnumeration = vi.fn(async () => []);
    await expect(store.collect({ ...input, capture: { ...input.capture, create: false } }, noEnumeration)).rejects.toMatchObject({ code: "workspace_output_export_failed" });
    expect(noEnumeration).not.toHaveBeenCalled();
  });

  it("rejects excess private spool reservations without evicting an earlier answer", async () => {
    const { root } = await fixture();
    const store = new WorkspaceOutputCaptureStore(root, { ...config, diskMiB: 3, outputTotalMaxBytes: 1024 * 1024 });
    const first = await store.collect(input, async () => [output("original")]);
    await first[0]!.body.cancel();
    const source = vi.fn(async () => [output("later")]);
    await expect(store.collect({ ...input, modelRunId: "later" }, source)).rejects.toMatchObject({ code: "workspace_output_limit_exceeded" });
    const recovered = await store.collect({ ...input, capture: { ...input.capture, create: false } }, source);
    expect(await new Response(recovered[0]!.body).text()).toBe("original");
    expect(source).not.toHaveBeenCalled();
  });

  it("serializes competing captures and preserves all files for separate partial-upload attempts", async () => {
    const { store, root } = await fixture();
    const source = vi.fn(async () => [output("one", "one.txt"), output("two", "two.txt")]);
    const [first, second] = await Promise.all([store.collect(input, source), store.collect(input, source)]);
    expect(source).toHaveBeenCalledTimes(1);
    expect(await new Response(first[0]!.body).text()).toBe("one");
    await first[1]!.body.cancel();
    await Promise.all(second.map((file) => file.body.cancel()));
    const recovered = await new WorkspaceOutputCaptureStore(root, config).collect({ ...input, capture: { ...input.capture, create: false } }, source);
    expect(await Promise.all(recovered.map((file) => new Response(file.body).text()))).toEqual(["one", "two"]);
  });

  it("does not substitute another disk and removes only the requested capture/session", async () => {
    const { store, root } = await fixture();
    await store.collect(input, async () => []);
    const second = { ...input, modelRunId: "second" };
    await store.collect(second, async () => []);
    const noEnumeration = vi.fn(async () => []);
    await expect(store.collect({ ...input, runtimeSandboxId: "replacement", capture: { ...input.capture, create: false } }, noEnumeration)).rejects.toMatchObject({ code: "workspace_output_export_failed" });
    await store.release({ ...input, captureId: input.capture.id });
    await expect(store.collect({ ...input, capture: { ...input.capture, create: false } }, noEnumeration)).rejects.toThrow();
    await expect(store.collect({ ...second, capture: { ...input.capture, create: false } }, noEnumeration)).resolves.toEqual([]);
    await store.removeSession(input);
    expect(await readdir(root)).toEqual([]);
    expect(noEnumeration).not.toHaveBeenCalled();
  });

  it("cleans private bytes after disk loss erased the runtime identity", async () => {
    const { store, root } = await fixture();
    const files = await store.collect(input, async () => [output("original")]);
    await files[0]!.body.cancel();
    await store.removeSession({ sessionId: input.sessionId, runtimeSandboxId: null });
    expect(await readdir(root)).toEqual([]);
  });
});
