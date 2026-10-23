/** Message of the error a lease check throws when the run's authority ended
 * because its user stopped the run: its streams end as cancelled, not failed. */
export const RUNNER_GATEWAY_LEASE_CANCELLED = "agent_run_cancelled";

function cancelledByUser(reason: unknown): boolean {
  return reason instanceof Error && reason.message === RUNNER_GATEWAY_LEASE_CANCELLED;
}

/** A gateway request cannot outlive its executor, even in another app process. */
export async function withRunnerGatewayLease(
  request: Request,
  assertActive: () => Promise<void>,
  handle: (signal: AbortSignal) => Promise<Response>
): Promise<Response> {
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  let checking = false;
  const timer = setInterval(() => {
    if (checking || signal.aborted) return;
    checking = true;
    void assertActive().catch((error: unknown) =>
      controller.abort(cancelledByUser(error) ? error : new Error("agent_authority_expired")))
      .finally(() => { checking = false; });
  }, 1000);
  timer.unref();
  const release = () => clearInterval(timer);
  signal.addEventListener("abort", release, { once: true });
  const dispose = () => { release(); signal.removeEventListener("abort", release); };
  try {
    await assertActive();
    signal.throwIfAborted();
    const response = await handle(signal);
    if (!response.body) { dispose(); return response; }
    const reader = response.body.getReader();
    return new Response(new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) { dispose(); output.close(); }
          else output.enqueue(next.value);
        } catch {
          dispose();
          await reader.cancel().catch(() => undefined);
          // The client inside the VM closed its own request, or its user
          // stopped the run: nobody reads the rest, so the stream just ends.
          // An expired grant or an upstream failure still interrupts it as a
          // failure.
          if (request.signal.aborted && !controller.signal.aborted) output.close();
          else if (controller.signal.aborted && cancelledByUser(controller.signal.reason)) output.close();
          else output.error(new Error("agent_request_interrupted"));
        }
      },
      async cancel() {
        controller.abort();
        dispose();
        await reader.cancel().catch(() => undefined);
      }
    }), { status: response.status, headers: response.headers });
  } catch (error) {
    controller.abort();
    dispose();
    throw error;
  }
}
