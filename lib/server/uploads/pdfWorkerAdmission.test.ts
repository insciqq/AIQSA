import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { inspectPdfForModelProcessing } from "../parsing/pdfPreparation";
import { extractNativePdfGeometry } from "../parsing/nativePdf";
import { extractPdfTextChunks } from "./pdf";

describe("process PDF worker admission", () => {
  it("shares memory admission across PDF consumers until termination and cancels queued work", async () => {
    const created: Array<{ name: string; worker: EventEmitter; release: () => void }> = [];
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const create = (name: string) => () => {
      const worker = new EventEmitter();
      let release = () => {};
      const terminated = new Promise<number>(resolve => { release = () => resolve(0); });
      Object.assign(worker, { terminate: vi.fn(() => terminated) });
      created.push({ name, worker, release });
      return worker as Worker;
    };
    const observe = <T>(promise: Promise<T>) => promise.then(
      value => ({ value, error: null }), (error: unknown) => ({ value: null, error })
    );
    const flush = async () => { for (let count = 0; count < 10; count++) await Promise.resolve(); };
    const bytes = Buffer.from("%PDF-neutral");
    const first = observe(inspectPdfForModelProcessing({ bytes, mode: "system_model_vision",
      signal: controllers[0]!.signal }, { createWorker: create("inspection"), maxPages: 1 }));
    const second = observe(extractNativePdfGeometry({ bytes, fileName: "neutral.pdf", mimeType: "application/pdf",
      signal: controllers[1]!.signal }, { createWorker: create("geometry"), maxPages: 1, maxBlocks: 10, maxCharacters: 100 }));
    const third = observe(extractPdfTextChunks(bytes, {
      createWorker: create("attachment"), signal: controllers[2]!.signal
    }));
    let fourth: Promise<unknown> | undefined;
    try {
      await flush();
      expect(created.map(item => item.name)).toEqual(["inspection"]);
      const cancellation = new Error("queued_cancelled");
      controllers[2]!.abort(cancellation);
      expect((await third).error).toBe(cancellation);
      created[0]!.worker.emit("message", { ok: true, result: { kind: "inspect", pageCount: 1 } });
      await flush();
      expect(created.map(item => item.name)).toEqual(["inspection"]);
      created[0]!.release();
      expect((await first).value).toEqual({ pageCount: 1 });
      await flush();
      expect(created.map(item => item.name)).toEqual(["inspection", "geometry"]);
      fourth = observe(inspectPdfForModelProcessing({ bytes, mode: "system_model_vision",
        signal: controllers[3]!.signal }, { createWorker: create("after-failure"), maxPages: 1 }));
      created[1]!.worker.emit("error", new Error("worker_failed"));
      await flush();
      expect(created).toHaveLength(2);
      created[1]!.release();
      expect((await second).error).toMatchObject({ code: "parser_unavailable" });
      await flush();
      expect(created.map(item => item.name)).toEqual(["inspection", "geometry", "after-failure"]);
      created[2]!.worker.emit("message", { ok: true, result: { kind: "inspect", pageCount: 1 } });
      created[2]!.release();
      await fourth;
    } finally {
      controllers.forEach(controller => controller.abort());
      created.forEach(item => item.release());
      await Promise.all([first, second, third, fourth]);
    }
  });
});
