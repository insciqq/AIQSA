import { Readable } from "node:stream";

/** Preserve byte backpressure at Node → Web stream boundaries. */
export function nodeByteStream(source: Readable): ReadableStream<Uint8Array> {
  // Installed Node typings omit the documented strategy option. The runtime
  // otherwise treats the Node byte highWaterMark as a count of whole chunks.
  const toWeb = Readable.toWeb as (source: Readable, options: {
    strategy: QueuingStrategy<Uint8Array>;
  }) => ReadableStream<Uint8Array>;
  return toWeb(source, { strategy: {
    highWaterMark: 64 * 1024,
    size: chunk => chunk.byteLength
  } });
}

/** Race cancellation once per operation, without per-chunk promise chains. */
export function readStreamWithAbort<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return read(); }).then(
      value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); }
    );
  });
}
