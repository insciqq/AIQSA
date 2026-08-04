import { getRequestBodyConfig } from "./requestBodyConfig";

export type RequestBodyKind = "auth" | "json";

export class RequestBodyTooLargeError extends Error {
  readonly actualBytes: bigint | number;
  readonly limitBytes: number;

  constructor(input: { actualBytes: bigint | number; limitBytes: number }) {
    super("request_body_too_large");
    this.name = "RequestBodyTooLargeError";
    this.actualBytes = input.actualBytes;
    this.limitBytes = input.limitBytes;
  }
}

function validContentLength(value: string | null): bigint | number | null {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }

  const parsed = BigInt(value);
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export async function readBoundedRequestBody(
  request: Request,
  input: { maxBytes: number; signal?: AbortSignal }
): Promise<Uint8Array> {
  const signal = input.signal ?? request.signal;

  if (signal.aborted) {
    const reason = abortReason(signal);
    await request.body?.cancel(reason).catch(() => undefined);
    throw reason;
  }

  const declaredBytes = validContentLength(request.headers.get("content-length"));

  if (declaredBytes !== null && BigInt(declaredBytes) > BigInt(input.maxBytes)) {
    const error = new RequestBodyTooLargeError({ actualBytes: declaredBytes, limitBytes: input.maxBytes });
    await request.body?.cancel(error).catch(() => undefined);
    throw error;
  }

  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let abortReject: ((reason: unknown) => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortReject = reject;
  });
  let abortHandled = false;
  const onAbort = () => {
    if (abortHandled) {
      return;
    }

    abortHandled = true;
    const reason = abortReason(signal);
    void reader.cancel(reason).catch(() => undefined);
    abortReject?.(reason);
  };

  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);

      if (signal.aborted) {
        throw abortReason(signal);
      }

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > input.maxBytes) {
        const error = new RequestBodyTooLargeError({
          actualBytes: totalBytes,
          limitBytes: input.maxBytes
        });
        await reader.cancel(error).catch(() => undefined);
        throw error;
      }

      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
}

export async function readJsonBody(request: Request, kind: RequestBodyKind = "json"): Promise<unknown> {
  const config = getRequestBodyConfig();
  const bytes = await readBoundedRequestBody(request, {
    maxBytes: kind === "auth" ? config.authMaxBytes : config.jsonMaxBytes
  });

  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function readJsonBodyOrNull(
  request: Request,
  kind: RequestBodyKind = "json"
): Promise<unknown> {
  try {
    return await readJsonBody(request, kind);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return error;
    }

    if (request.signal.aborted) {
      throw error;
    }

    return null;
  }
}

export function requestBodyErrorResponse(value: unknown): Response | null {
  if (!(value instanceof RequestBodyTooLargeError)) {
    return null;
  }

  return Response.json(
    {
      error: "request_body_too_large",
      limit: value.limitBytes,
      message: `Request body exceeds the ${value.limitBytes}-byte limit.`
    },
    { status: 413 }
  );
}

export async function readBoundedFormData(request: Request, maxBytes: number): Promise<FormData> {
  const bytes = await readBoundedRequestBody(request, { maxBytes });
  const headers = new Headers(request.headers);
  headers.set("content-length", String(bytes.byteLength));
  const boundedRequest = new Request(request.url, {
    body: bytes,
    headers,
    method: request.method,
    signal: request.signal
  });

  return boundedRequest.formData();
}
