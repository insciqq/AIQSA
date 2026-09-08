import {
  ADMIN_PROVIDER_SETUP_STREAM_TYPE,
  decodeAdminProviderSetupProgress,
  type AdminProviderSetupProgress
} from "../../../contracts/adminProviderSetupProgress";

/** Called only after the handler's authentication and bounded request decoding. */
export function setupProgressResponse(
  request: Request,
  operation: (signal: AbortSignal, progress?: (value: AdminProviderSetupProgress) => void) => Promise<Response>
): Promise<Response> | Response {
  if (request.headers.get("accept") !== ADMIN_PROVIDER_SETUP_STREAM_TYPE) {
    return operation(request.signal);
  }
  const abort = new AbortController();
  const forwardAbort = () => abort.abort(request.signal.reason);
  if (request.signal.aborted) forwardAbort();
  else request.signal.addEventListener("abort", forwardAbort, { once: true });
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    clearInterval(heartbeat);
    request.signal.removeEventListener("abort", forwardAbort);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: unknown) => {
        if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      const progress = (value: AdminProviderSetupProgress) => {
        const safe = decodeAdminProviderSetupProgress(value);
        if (!safe) throw new Error("provider_setup_progress_invalid");
        send({ type: "progress", progress: safe });
      };
      heartbeat = setInterval(() => send({ type: "heartbeat" }), 10_000);
      void operation(abort.signal, progress).then(async (response) => {
        send({ type: "result", status: response.status, data: await response.json() });
      }).catch(() => {
        send({ type: "result", status: 500, data: { error: "provider_setup_interrupted" } });
      }).finally(() => {
        cleanup();
        if (!closed) { closed = true; controller.close(); }
      });
    },
    cancel() {
      closed = true;
      abort.abort();
      cleanup();
    }
  });
  return new Response(stream, { headers: {
    "content-type": `${ADMIN_PROVIDER_SETUP_STREAM_TYPE}; charset=utf-8`,
    "cache-control": "no-store",
    "x-accel-buffering": "no"
  } });
}
