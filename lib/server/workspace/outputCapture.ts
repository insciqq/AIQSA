import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { WorkspaceConfig } from "./config";
import { outputIdentities, parseOutputCaptureRequest } from "./outputManifest";
import { WorkspaceRuntimeError, type WorkspaceOutputStream, type WorkspaceRuntime } from "./runtime";

type CaptureInput = Parameters<WorkspaceRuntime["collectOutputs"]>[0];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const failed = () => new WorkspaceRuntimeError("workspace_output_export_failed");

/** Runner-private bytes on the existing VM volume. Never mounted into a guest. */
export class WorkspaceOutputCaptureStore {
  private readonly tails = new Map<string, Promise<unknown>>();

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

  private async readManifest(key: string) {
    const path = join(this.directory, key, "manifest.json");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw failed();
    return outputIdentities(JSON.parse(await readFile(path, "utf8")), this.config);
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

  private body(key: string, byteSize: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let opening: Promise<void> | undefined;
    let cancelled = false;
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
          if (next.done) { reader!.releaseLock(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) {
          await reader?.cancel(error).catch(() => undefined);
          if (!cancelled) controller.error(error);
        }
      },
      cancel: async (reason) => {
        cancelled = true;
        await opening?.catch(() => undefined);
        await reader?.cancel(reason).catch(() => undefined);
      }
    }, { highWaterMark: 0 });
  }

  private async available(sessionKey: string, needed: number): Promise<void> {
    const path = join(this.directory, sessionKey);
    const captures = await readdir(path, { withFileTypes: true });
    // Failed/incomplete captures count too. A full private spool must fail an
    // export, never evict another answer's bytes or prevent later chat turns.
    if (captures.length >= 100) throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
    let used = 0;
    for (const capture of captures) {
      if (!capture.isDirectory() || !/^[a-f0-9]{64}$/u.test(capture.name)) throw failed();
      const files = await readdir(join(path, capture.name), { withFileTypes: true });
      if (files.length > 102) throw failed();
      for (const file of files) {
        if (!file.isFile()) throw failed();
        used += (await lstat(join(path, capture.name, file.name))).size;
      }
    }
    if (used + needed > this.config.diskMiB * 1024 * 1024) throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
  }

  async collect(input: CaptureInput, collectCurrent: () => Promise<readonly WorkspaceOutputStream[]>): Promise<readonly WorkspaceOutputStream[]> {
    const capture = parseOutputCaptureRequest(input.capture);
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
        await this.available(sessionKey, this.config.outputTotalMaxBytes + 2 * 1024 * 1024);
        await mkdir(path, { mode: 0o700 });
        await this.sync(join(this.directory, sessionKey));
        const outputs = await collectCurrent();
        try {
          const identities = outputIdentities(outputs, this.config);
          for (let index = 0; index < identities.length; index += 1) {
            const identity = identities[index]!;
            const output = outputs.find((entry) => entry.relativePath === identity.relativePath)!;
            const storageKey = `${key}/${index}`;
            input.signal?.throwIfAborted();
            // Captured bytes belong to the runtime volume, not the build tree.
            await this.copy(join(/* turbopackIgnore: true */ this.directory, storageKey), output, input.signal);
          }
          input.signal?.throwIfAborted();
          const temporary = join(path, `manifest-${randomUUID()}`);
          const handle = await open(temporary, "wx", 0o600);
          try { await handle.writeFile(JSON.stringify(identities)); await handle.sync(); } finally { await handle.close(); }
          input.signal?.throwIfAborted();
          await rename(temporary, join(path, "manifest.json"));
          await this.sync(path);
        } finally {
          await Promise.allSettled(outputs.map((output) => output.body.cancel()));
        }
      }
      // No manifest means capture never finished, including a genuinely empty
      // directory whose capture was interrupted before its durable commit.
      const identities = await this.readManifest(key).catch(() => { throw failed(); });
      input.signal?.throwIfAborted();
      return identities.map((identity, index) => ({ ...identity,
        body: this.body(`${key}/${index}`, identity.byteSize, input.signal), opaqueFileId: digest(`${key}/${index}`) }));
    });
  }

  async release(input: Parameters<NonNullable<WorkspaceRuntime["releaseOutputCapture"]>>[0]): Promise<void> {
    parseOutputCaptureRequest({ id: input.captureId, create: false });
    await this.serial(this.sessionKey(input), async () => {
      input.signal?.throwIfAborted();
      await rm(join(this.directory, this.captureKey(input, input.captureId)), { force: true, recursive: true });
    });
  }

  async removeSession(input: { sessionId: string; runtimeSandboxId: string | null }): Promise<void> {
    await this.serial(this.sessionKey(input), () => rm(join(this.directory, this.sessionKey(input)), { force: true, recursive: true }));
  }
}
