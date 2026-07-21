export type ParsedServerSentEvent = {
  data: string;
  event: string;
};

export type ParseSseStreamOptions = {
  idleTimeoutMs?: number;
  signal?: AbortSignal;
};

function parseSseChunk(chunk: string): ParsedServerSentEvent | null {
  const lines = chunk.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    data: dataLines.join("\n"),
    event
  };
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  const error = new Error("sse_stream_aborted");
  error.name = "AbortError";
  return error;
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options: ParseSseStreamOptions
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!options.signal && !options.idleTimeoutMs) {
    return reader.read();
  }

  if (options.signal?.aborted) {
    throw abortError(options.signal);
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  let cleanupAbort: () => void = () => undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (options.signal) {
      const onAbort = () => reject(abortError(options.signal));
      cleanupAbort = () => options.signal?.removeEventListener("abort", onAbort);
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    if (options.idleTimeoutMs) {
      timeout = setTimeout(() => {
        const error = new Error("provider_stream_timeout");
        error.name = "TimeoutError";
        reject(error);
      }, options.idleTimeoutMs);
    }
  });

  try {
    return await Promise.race([reader.read(), abortPromise]);
  } finally {
    cleanupAbort();
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  options: ParseSseStreamOptions = {}
): AsyncGenerator<ParsedServerSentEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;

  try {
    while (true) {
      const { done, value } = await readChunk(reader, options);
      if (done) {
        completed = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split(/\r?\n\r?\n/);
      buffer = chunks.pop() ?? "";

      for (const chunk of chunks) {
        const event = parseSseChunk(chunk);
        if (event) {
          yield event;
        }
      }
    }

    buffer += decoder.decode();
    const trailing = parseSseChunk(buffer.trim());
    if (trailing) {
      yield trailing;
    }
  } finally {
    if (!completed) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}
