import {
  BROWSER_LIVE_ERROR_HTTP_STATUS,
  BROWSER_LIVE_LIMITS,
  BROWSER_LIVE_PRESENCE_PARAM,
  browserLiveControlRequestSchema,
  browserLiveHandoffRequestSchema,
  browserLiveInputSchema,
  type BrowserLiveErrorCode
} from "@/lib/contracts/browserLive";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { createConnectSseStream, type ConnectSseStream } from "../connect/sse";
import { readBoundedRequestBody } from "../http/requestBody";
import { BROWSER_LIVE_RELAY_LIMITS, type BrowserLiveRelay, type BrowserLiveView, type BrowserLiveViewer,
  type BrowserLiveWriter } from "./browserLive";

/**
 * The live Workspace browser's routes under `/api/chats/<chatId>/browser/` (`lib/contracts/browserLive.ts`),
 * modelled on AIQSA Connect's view routes (`lib/server/connect/browserHandlers.ts`): every request authenticates
 * the signed-in browser session and finds the chat's live browser only for the run's owner, so another user, an
 * administrator, a finished run and an unknown chat all get the same `browser_live_not_found`, whichever agent's tab a
 * request names (every agent of a chat browses for its one owner, in the chat's one live browser). Mutations get the
 * proxy's same-origin check; bodies are bounded here. Nothing a request carries is logged or stored.
 */
export type BrowserLiveHandlerDeps = Readonly<{
  /** Whether the browser session that opened a stream is still signed in. */
  authSessionActive(input: Readonly<{ now: Date; sessionId: string; userId: string }>): Promise<boolean>;
  heartbeatMs?: number;
  relay(): BrowserLiveRelay;
  resolveAuth: RequestAuthResolver;
}>;

type Params = Readonly<{ params: Promise<Readonly<{ chatId: string }>> | Readonly<{ chatId: string }> }>;

const HEADERS = Object.freeze({ "cache-control": "private, no-store" });
/** Small JSON bodies: one input (a text insertion escapes to at most six bytes a character), a control or a handoff answer. */
const BODY_MAX_BYTES = 6 * BROWSER_LIVE_LIMITS.textChars + 1_024;
const CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/u;

/** A frame's size on the wire: its base64 picture and a small envelope. */
function frameBytes(data: unknown): number {
  const picture = typeof data === "object" && data !== null ? (data as { data?: unknown }).data : undefined;
  return (typeof picture === "string" ? picture.length : 0) + 256;
}

/**
 * One view's writer. Frames go out only while the stream holds less than about `framesQueued` frames of the size
 * being sent, so a state, steps or end event never waits behind seconds of pictures on a slow connection (production
 * 2026-11-17: the state after Done reached a phone ~15 s late behind a 4 MB queue of frames); other events use the
 * whole queue. A frame held back is replaced by the next one, and the latest is tried again until the reader catches
 * up, so a page that stopped changing still shows its last picture.
 */
export function frameBudgetWriter(stream: ConnectSseStream): BrowserLiveWriter {
  let held: unknown = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fits = (data: unknown) => {
    const bytes = frameBytes(data);
    return stream.queuedBytes() + bytes <= Math.max(BROWSER_LIVE_RELAY_LIMITS.framesQueued * bytes,
      BROWSER_LIVE_RELAY_LIMITS.frameQueueFloorBytes);
  };
  const retry = () => {
    timer = null;
    if (held === null || stream.isClosed()) return;
    if (!fits(held)) {
      hold(held);
      return;
    }
    const frame = held;
    held = null;
    stream.send("frame", frame);
  };
  const hold = (data: unknown) => {
    held = data;
    if (timer) return;
    timer = setTimeout(retry, BROWSER_LIVE_RELAY_LIMITS.frameRetryMs);
    timer.unref?.();
  };
  stream.onClose(() => {
    if (timer) clearTimeout(timer);
    timer = null;
    held = null;
  });
  return {
    close: (final) => stream.close(final),
    send(event, data) {
      if (event !== "frame") return stream.send(event, data);
      if (stream.isClosed()) return false;
      if (!fits(data)) {
        hold(data);
        return false;
      }
      held = null;
      return stream.send(event, data);
    }
  };
}

function refuse(code: BrowserLiveErrorCode): Response {
  return Response.json({ code }, { headers: HEADERS, status: BROWSER_LIVE_ERROR_HTTP_STATUS[code] });
}

export function createBrowserLiveHandlers(deps: BrowserLiveHandlerDeps) {
  const heartbeatMs = deps.heartbeatMs ?? BROWSER_LIVE_LIMITS.heartbeatSeconds * 1_000;
  const noContent = () => new Response(null, { headers: HEADERS, status: 204 });

  /** The owner's view of the chat's live browser, or the refusal that answers anyone else. */
  async function find(request: Request, context: Params): Promise<Readonly<{ view: BrowserLiveView; viewer: BrowserLiveViewer }> | Response> {
    const auth = await deps.resolveAuth(request).catch(() => null);
    const { chatId } = await context.params;
    if (!auth || auth.user.status !== "active" || !CHAT_ID.test(chatId)) return refuse("browser_live_not_found");
    const view = deps.relay().find(chatId, auth.userId);
    return view ? { view, viewer: { authSessionId: auth.id, userId: auth.userId } } : refuse("browser_live_not_found");
  }

  async function body(request: Request): Promise<unknown> {
    try {
      const bytes = await readBoundedRequestBody(request, { maxBytes: BODY_MAX_BYTES });
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      return undefined;
    }
  }

  return {
    /** `GET …/browser/stream`: `state`, `steps`, `frame` and finally `end`, with a `ping` every heartbeat. */
    async stream(request: Request, context: Params): Promise<Response> {
      const found = await find(request, context);
      if (found instanceof Response) return found;
      const stream = createConnectSseStream({ maxQueuedBytes: BROWSER_LIVE_RELAY_LIMITS.viewQueueBytes, signal: request.signal });
      if (stream.isClosed()) return stream.response;
      // Only an opening the person made is a sign of them; an automatic reconnect carries no flag.
      const presence = new URL(request.url).searchParams.get(BROWSER_LIVE_PRESENCE_PARAM) === "1";
      const id = await found.view.watch(found.viewer, frameBudgetWriter(stream), { presence });
      if (!id) {
        stream.close();
        return refuse("browser_live_not_found");
      }
      let checking = false;
      const timer = setInterval(() => {
        if (!stream.send("ping", {})) {
          stream.close();
          return;
        }
        if (checking) return;
        checking = true;
        // A browser session signed out meanwhile loses its view; a failed check keeps it.
        void deps.authSessionActive({ now: new Date(), sessionId: found.viewer.authSessionId, userId: found.viewer.userId })
          .then((active) => { if (!active) stream.close({ data: { reason: "not_available" }, event: "end" }); }, () => undefined)
          .finally(() => { checking = false; });
      }, heartbeatMs);
      timer.unref?.();
      stream.onClose(() => {
        clearInterval(timer);
        found.view.unwatch(id);
      });
      return stream.response;
    },

    /** `POST …/browser/input`: one pointer, key or text input while the user holds the browser. */
    async input(request: Request, context: Params): Promise<Response> {
      const found = await find(request, context);
      if (found instanceof Response) return found;
      const parsed = browserLiveInputSchema.safeParse(await body(request));
      if (!parsed.success) return refuse("browser_live_request_invalid");
      const refusal = await found.view.input(found.viewer, parsed.data);
      return refusal ? refuse(refusal) : noContent();
    },

    /** `POST …/browser/control`: Take control or Return control of one agent's tab, or the agent to watch. */
    async control(request: Request, context: Params): Promise<Response> {
      const found = await find(request, context);
      if (found instanceof Response) return found;
      const parsed = browserLiveControlRequestSchema.safeParse(await body(request));
      if (!parsed.success) return refuse("browser_live_request_invalid");
      const refusal = await found.view.control(found.viewer, parsed.data);
      return refusal ? refuse(refusal) : noContent();
    },

    /** `POST …/browser/handoff`: Done or Cancel on the agent's pending handoff. */
    async handoff(request: Request, context: Params): Promise<Response> {
      const found = await find(request, context);
      if (found instanceof Response) return found;
      const parsed = browserLiveHandoffRequestSchema.safeParse(await body(request));
      if (!parsed.success) return refuse("browser_live_request_invalid");
      const refusal = found.view.answerHandoff(found.viewer, parsed.data);
      return refusal ? refuse(refusal) : noContent();
    }
  };
}
