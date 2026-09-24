import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { WorkspaceConfig } from "./config";
import { outputIdentities, parseOutputCaptureRequest, selectedCaptureRequest, type WorkspaceFileSelection } from "./outputManifest";
import { WorkspaceRuntimeError, type WorkspaceOutputStream, type WorkspaceRuntime } from "./runtime";

type CaptureInput = Parameters<WorkspaceRuntime["collectOutputs"]>[0];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const failed = () => new WorkspaceRuntimeError("workspace_output_export_failed");

/** Runner-private bytes on the existing VM volume. Never mounted into a guest. */
export class WorkspaceOutputCaptureStore {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly selectedReaders = new Map<string, number>();
  private readonly releasedSelections = new Set<string>();

  constructor(private readonly directory: string, private readonly config: WorkspaceConfig) {}

  private sessionKey(input: { sessionId: string }) {
    return digest(input.sessionId);
  }

  private captureKey(input: { sessionId: string; runtimeSandboxId: string; modelRunId: string }, id: string) {
    return `${this.sessionKey(input)}/${digest(input.runtimeSandboxId + "\0" + input.modelRunId + "\0" + id)}`;
  }

  private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    this.tails.set(key, result);
    try { return await result; } finally { if (this.tails.get(key) === result) this.tails.delete(key); }
  }

  private async sync(path: string): Promise<void> {
    const handle = await open(path, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async readManifest(key: string, selection?: WorkspaceFileSelection) {
    const path = join(this.directory, key, "manifest.json");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw failed();
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (!selection) return outputIdentities(manifest, this.config);
    if (!manifest || JSON.stringify(manifest.selection) !== JSON.stringify(selection)) throw failed();
    return this.identities(manifest.outputs, selection);
  }

  private identities(outputs: unknown, selection?: WorkspaceFileSelection) {
    const identities = outputIdentities(outputs, this.config, selection !== undefined);
    if (selection && JSON.stringify(identities.map((file) => file.relativePath)) !==
      JSON.stringify(selection.files.map((file) => `${file.root}/${file.relativePath}`))) throw failed();
    return identities;
  }

  private async copy(path: string, output: WorkspaceOutputStream, signal?: AbortSignal): Promise<void> {
    let written = 0;
    await pipeline(
      Readable.fromWeb(output.body as Parameters<typeof Readable.fromWeb>[0]),
      new Transform({ transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        callback(written > output.byteSize ? failed() : null, chunk);
      } }),
      createWriteStream(path, { flags: "wx", mode: 0o600 }), { signal }
    );
    if (written !== output.byteSize) throw failed();
    // Verify the actual private file, including sources that reuse mutable
    // buffers. The manifest is the only commit and is written after all files.
    let inspected = 0;
    const hash = createHash("sha256");
    await pipeline(createReadStream(path, { highWaterMark: 64 * 1024 }), new Writable({ write(chunk: Buffer, _encoding, callback) {
      inspected += chunk.length;
      if (inspected > output.byteSize) { callback(failed()); return; }
      hash.update(chunk); callback();
    } }), { signal });
    if (inspected !== output.byteSize || hash.digest("hex") !== output.checksum) throw failed();
    await this.sync(path);
  }

  private body(key: string, byteSize: number, signal?: AbortSignal, onClose?: () => Promise<void>): ReadableStream<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let opening: Promise<void> | undefined;
    let cancelled = false;
    let closed = false;
    const close = async () => { if (!closed) { closed = true; await onClose?.(); } };
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          opening ??= (async () => {
            const path = join(this.directory, key);
            const stat = await lstat(path);
            if (!stat.isFile() || stat.size !== byteSize) throw failed();
            signal?.throwIfAborted();
            reader = (Readable.toWeb(createReadStream(path, { end: byteSize, highWaterMark: 64 * 1024, signal })) as ReadableStream<Uint8Array>).getReader();
            if (cancelled) await reader.cancel();
          })();
          await opening;
          if (cancelled) return;
          const next = await reader!.read();
          if (cancelled) return;
          if (next.done) { reader!.releaseLock(); await close(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) {
          await reader?.cancel(error).catch(() => undefined);
          await close();
          if (!cancelled) controller.error(error);
        }
      },
      cancel: async (reason) => {
        cancelled = true;
        await opening?.catch(() => undefined);
        await reader?.cancel(reason).catch(() => undefined);
        await close();
      }
    }, { highWaterMark: 0 });
  }

  private async removeReleasedBytes(key: string): Promise<void> {
    const path = join(this.directory, key);
    for (const name of await readdir(path)) {
      if (name !== "manifest.json") await rm(join(path, name), { force: true });
    }
    await this.sync(path);
    this.releasedSelections.delete(key);
  }

  private async available(sessionKey: string, needed: number, selected: boolean): Promise<void> {
    const path = join(this.directory, sessionKey);
    const captures = await readdir(path, { withFileTypes: true });
    // Failed/incomplete captures count too. A full private spool must fail an
    // export, never evict another answer's bytes or prevent later chat turns.
    if (captures.length > 1_200) throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
    let used = 0, active = 0, released = 0;
    for (const capture of captures) {
      if (!capture.isDirectory() || !/^[a-f0-9]{64}$/u.test(capture.name)) throw failed();
      const files = await readdir(join(path, capture.name), { withFileTypes: true });
      if (files.length > 102) throw failed();
      let tombstone = false;
      for (const file of files) {
        if (!file.isFile()) throw failed();
        const filePath = join(path, capture.name, file.name);
        const size = (await lstat(filePath)).size;
        used += size;
        if (files.length === 1 && file.name === "manifest.json" && size < 64) {
          tombstone = (await readFile(filePath, "utf8")) === '{"released":true}';
        }
      }
      if (tombstone) released += 1; else active += 1;
    }
    // Bounded idempotency history cannot consume the final-export slots.
    if (active >= 100 || selected && released >= 1_000) throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
    if (used + needed > this.config.diskMiB * 1024 * 1024) throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
  }

  async collect(input: CaptureInput, collectCurrent: () => Promise<readonly WorkspaceOutputStream[]>,
    validateSource?: () => Promise<void>, readSignal: AbortSignal | null = input.signal ?? null): Promise<readonly WorkspaceOutputStream[]> {
    const capture = parseOutputCaptureRequest(input.capture);
    const selection = selectedCaptureRequest(input, this.config.outputMaxFiles);
    const sessionKey = this.sessionKey(input);
    const key = this.captureKey(input, capture.id);
    return this.serial(sessionKey, async () => {
      input.signal?.throwIfAborted();
      const path = join(this.directory, key);
      const exists = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (exists && !exists.isDirectory()) throw failed();
      if (!exists) {
        // A DB reservation is never renewed. A missing capture after restart
        // cannot authorize a new enumeration of the mutable guest directory.
        if (!capture.create) throw failed();
        await mkdir(join(this.directory, sessionKey), { recursive: true, mode: 0o700 });
        await this.available(sessionKey, this.config.outputTotalMaxBytes + 2 * 1024 * 1024, selection !== undefined);
        await mkdir(path, { mode: 0o700 });
        if (selection) {
          // Record the selected identity before guest dispatch. A failed or
          // crash-ambiguous attempt is also permanently non-recreatable.
          const handle = await open(join(path, "request.json"), "wx", 0o600);
          try { await handle.writeFile(JSON.stringify(selection)); await handle.sync(); } finally { await handle.close(); }
          await this.sync(path);
        }
        await this.sync(join(this.directory, sessionKey));
        const outputs = await collectCurrent();
        try {
          const identities = this.identities(outputs, selection);
          for (let index = 0; index < identities.length; index += 1) {
            const identity = identities[index]!;
            const output = outputs.find((entry) => entry.relativePath === identity.relativePath)!;
            const storageKey = `${key}/${index}`;
            input.signal?.throwIfAborted();
            // Captured bytes belong to the runtime volume, not the build tree.
            await this.copy(join(/* turbopackIgnore: true */ this.directory, storageKey), output, input.signal);
          }
          // Selected sources must prove their read lease survived the entire
          // copy before the only durable commit can become visible.
          await validateSource?.();
          input.signal?.throwIfAborted();
          const temporary = join(path, `manifest-${randomUUID()}`);
          const handle = await open(temporary, "wx", 0o600);
          try { await handle.writeFile(JSON.stringify(selection ? { selection, outputs: identities } : identities)); await handle.sync(); } finally { await handle.close(); }
          input.signal?.throwIfAborted();
          await rename(temporary, join(path, "manifest.json"));
          await this.sync(path);
        } finally {
          await Promise.allSettled(outputs.map((output) => output.body.cancel()));
        }
      }
      // No manifest means capture never finished, including a genuinely empty
      // directory whose capture was interrupted before its durable commit.
      const identities = await this.readManifest(key, selection).catch(() => { throw failed(); });
      input.signal?.throwIfAborted();
      if (selection) this.selectedReaders.set(key, (this.selectedReaders.get(key) ?? 0) + identities.length);
      const onClose = selection ? async () => {
        const remaining = (this.selectedReaders.get(key) ?? 1) - 1;
        if (remaining > 0) { this.selectedReaders.set(key, remaining); return; }
        this.selectedReaders.delete(key);
        if (this.releasedSelections.has(key)) await this.serial(sessionKey, () => this.removeReleasedBytes(key));
      } : undefined;
      return identities.map((identity, index) => ({ ...identity,
        body: this.body(`${key}/${index}`, identity.byteSize, readSignal ?? undefined, onClose), opaqueFileId: digest(`${key}/${index}`) }));
    });
  }

  async release(input: Parameters<NonNullable<WorkspaceRuntime["releaseOutputCapture"]>>[0]): Promise<void> {
    parseOutputCaptureRequest({ id: input.captureId, create: false });
    await this.serial(this.sessionKey(input), async () => {
      input.signal?.throwIfAborted();
      const key = this.captureKey(input, input.captureId);
      const path = join(this.directory, key);
      const manifest = await readFile(join(path, "manifest.json"), "utf8").then(text => JSON.parse(text))
        .catch(() => null);
      const selectedRequest = await lstat(join(path, "request.json")).then(stat => stat.isFile()).catch(() => false);
      if (selectedRequest || manifest?.selection || manifest?.released === true) {
        // Keep a durable tombstone: a delayed create delivery cannot capture
        // a replacement guest file under an already released identity.
        const temporary = join(path, `release-${randomUUID()}`);
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile('{"released":true}'); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, join(path, "manifest.json"));
        await this.sync(path);
        this.releasedSelections.add(key);
        // A listed body pins these private bytes until consumed/cancelled;
        // transport expiry owns cancellation of abandoned unopened handles.
        if (!this.selectedReaders.has(key)) await this.removeReleasedBytes(key);
      } else await rm(path, { force: true, recursive: true });
    });
  }

  async removeSession(input: { sessionId: string; runtimeSandboxId: string | null }): Promise<void> {
    const sessionKey = this.sessionKey(input);
    await this.serial(sessionKey, async () => {
      await rm(join(this.directory, sessionKey), { force: true, recursive: true });
      for (const key of this.selectedReaders.keys()) if (key.startsWith(`${sessionKey}/`)) this.selectedReaders.delete(key);
      for (const key of this.releasedSelections) if (key.startsWith(`${sessionKey}/`)) this.releasedSelections.delete(key);
    });
  }
}
