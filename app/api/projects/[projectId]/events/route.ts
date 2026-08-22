import {
  ensureProjectEventListener,
  latestProjectEventCursor,
  parseProjectEventCursor,
  projectCursorNeedsResync,
  projectEventAccess,
  projectEventId,
  readProjectEvents,
  safeProjectEventCategory,
  safeProjectEventDeliveries,
  subscribeProjectEvents
} from "@/lib/server/projects/events";
import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ projectId: string }> | { projectId: string } };

function frame(input: Readonly<{ data?: unknown; event?: string; id?: string }>): string {
  return [
    input.id ? `id: ${input.id}` : null,
    input.event ? `event: ${input.event}` : null,
    input.data === undefined ? null : `data: ${JSON.stringify(input.data)}`,
    ""
  ].filter((line): line is string => line !== null).join("\n") + "\n";
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const session = await resolveRequestAuth(request);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
  const { projectId } = await context.params;
  const access = await projectEventAccess(prisma, { projectId, userId: session.userId });
  if (!access) return Response.json({ error: "project_not_found" }, { status: 404 });

  const supplied = request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("since");
  const normalizedCursor = supplied?.trim() || null;
  const cursor = normalizedCursor === null ? null : parseProjectEventCursor(normalizedCursor);
  const initialResyncReason = normalizedCursor === null
    ? "cursor_missing"
    : cursor === null ? "cursor_invalid" : null;
  let currentCursor = cursor ?? 0n;

  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let deliveryInFlight = false;
      let deliveryPending = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void) | undefined;

      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try { controller.close(); } catch { /* already closed by the client */ }
      };
      cleanup = close;
      const write = (value: string): boolean => {
        if (closed) return false;
        if ((controller.desiredSize ?? 1) <= 0) {
          // Native EventSource reconnects with the last frame it actually
          // consumed. Closing keeps a stalled browser from growing an
          // unbounded process-local queue; durable replay supplies the gap.
          close();
          return false;
        }
        try {
          controller.enqueue(encoder.encode(value));
          return true;
        } catch {
          close();
          return false;
        }
      };
      const resync = async (reason: string) => {
        // Updating both the SSE id and this connection's cursor is essential:
        // the client can reload canonical state without a multi-second native
        // EventSource reconnect window or an expired-cursor loop.
        const latestCursor = await latestProjectEventCursor(prisma, projectId);
        if (!write(frame({
          data: { reason },
          event: "resync_required",
          id: projectEventId(latestCursor)
        }))) return;
        currentCursor = latestCursor;
      };
      const deliver = async () => {
        if (closed) return;
        if (deliveryInFlight) {
          deliveryPending = true;
          return;
        }
        deliveryInFlight = true;
        try {
          const currentAccess = await projectEventAccess(prisma, { projectId, userId: session.userId });
          if (!currentAccess) {
            write(frame({ data: { reason: "access_changed" }, event: "access_lost" }));
            close();
            return;
          }
          if (await projectCursorNeedsResync(prisma, { after: currentCursor, projectId })) {
            await resync("cursor_expired");
            return;
          }
          let batchCount = 0;
          while (!closed) {
            if (batchCount > 0 && !await projectEventAccess(prisma, {
              projectId,
              userId: session.userId
            })) {
              write(frame({ data: { reason: "access_changed" }, event: "access_lost" }));
              close();
              return;
            }
            const events = await readProjectEvents(prisma, { after: currentCursor, limit: 256, projectId });
            if (events.length === 0) break;
            // Replay can collapse superseded partial checkpoints for the same
            // entity; the projection is current and therefore idempotent.
            const collapsed = new Map<string, (typeof events)[number]>();
            for (const event of events) {
              const category = safeProjectEventCategory(event.eventType);
              collapsed.set(`${category}:${event.entityType ?? "project"}:${event.entityId ?? "aggregate"}`, event);
            }
            const projectedEvents = [...collapsed.values()].sort((left, right) =>
              left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0
            );
            const deliveries = await safeProjectEventDeliveries(
              prisma,
              projectId,
              projectedEvents
            );
            for (const [index, event] of projectedEvents.entries()) {
              if (closed) return;
              const delivery = deliveries[index]!;
              if (!write(frame({
                data: delivery,
                event: "project_changed",
                id: projectEventId(event.sequence)
              }))) return;
              // Advance only after the frame has entered the bounded stream.
              // A projection/query failure therefore retries from the last
              // successfully enqueued durable cursor.
              currentCursor = event.sequence;
            }
            batchCount += 1;
            if (events.length < 256) break;
            if (batchCount >= 4) {
              await resync("replay_window_too_large");
              return;
            }
          }
        } catch {
          // The browser's native reconnect will issue a cursor replay.  Keep
          // the connection alive for transient database/network failures.
        } finally {
          deliveryInFlight = false;
          if (deliveryPending && !closed) {
            deliveryPending = false;
            queueMicrotask(() => { void deliver(); });
          }
        }
      };

      write(": project-events\n\n");
      if (initialResyncReason) {
        await resync(initialResyncReason);
        if (closed) return;
      }
      // LISTEN first, subscribe locally second, durable catch-up last. An
      // event committed in either gap is therefore present in the final query.
      try { await ensureProjectEventListener(); } catch { /* heartbeat/replay fallback */ }
      if (closed) return;
      unsubscribe = subscribeProjectEvents(projectId, () => { void deliver(); });
      heartbeat = setInterval(() => {
        write(": heartbeat\n\n");
        void deliver();
      }, 15_000);
      await deliver();

    },
    cancel() {
      cleanup();
    }
  }, {
    highWaterMark: 64,
    size: () => 1
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no"
    }
  });
}
