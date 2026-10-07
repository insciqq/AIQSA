import type { BrowserPushErrorCode, BrowserPushKeyResponse } from "../../contracts/browserPush";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import type { BrowserPushStore } from "./store";
import { decodePushSubscriptionRequest, decodePushUnsubscribeRequest, decodeShownRunRequest } from "./subscriptionRequest";
import type { VapidKeyPair } from "./webPushCrypto";

export type BrowserPushHandlerDeps = Readonly<{
  keys: () => Promise<VapidKeyPair>;
  now?: () => Date;
  resolveAuth: RequestAuthResolver;
  /** The sender's record of a run whose end this session showed on screen. */
  runShown: (runId: string, sessionId: string) => void;
  store: Pick<BrowserPushStore, "deleteSubscription" | "saveSubscription">;
}>;

const headers = { "cache-control": "private, no-store" };
const STATUS: Record<BrowserPushErrorCode, number> = {
  browser_notifications_disabled: 409,
  push_subscription_invalid: 400,
  push_unavailable: 503
};

function failure(code: BrowserPushErrorCode): Response {
  return Response.json({ error: code }, { headers, status: STATUS[code] });
}

/**
 * Owner API for `/api/me/push-subscriptions`: the VAPID public key,
 * registering or removing this device's subscription, and reporting a run
 * this device showed. The proxy enforces the same-origin check on mutations;
 * endpoints and keys never reach logs.
 */
export function createBrowserPushHandlers(deps: BrowserPushHandlerDeps) {
  const now = deps.now ?? (() => new Date());

  async function handle(
    request: Request,
    stage: "read" | "write",
    operation: (auth: Readonly<{ sessionId: string; userId: string }>) => Promise<Response>
  ): Promise<Response> {
    const auth = await deps.resolveAuth(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { headers, status: 401 });
    if (auth.user.status !== "active") return Response.json({ error: "forbidden" }, { headers, status: 403 });
    try {
      return await operation({ sessionId: auth.id, userId: auth.userId });
    } catch (error) {
      logEvent("service_operation", {
        error,
        code: "push_unavailable", outcome: "failed", prisma_code: databaseFailureCode(error), stage, subsystem: "push"
      });
      return failure("push_unavailable");
    }
  }

  async function readBody(request: Request): Promise<readonly [unknown, Response | null]> {
    const raw = await readJsonBodyOrNull(request);
    return [raw, requestBodyErrorResponse(raw)];
  }

  return {
    key: (request: Request) => handle(request, "read", async () => {
      const keys = await deps.keys();
      return Response.json({ applicationServerKey: keys.publicKey } satisfies BrowserPushKeyResponse, { headers });
    }),

    subscribe: (request: Request) => handle(request, "write", async ({ sessionId, userId }) => {
      const [raw, bodyError] = await readBody(request);
      if (bodyError) return bodyError;
      const subscription = decodePushSubscriptionRequest(raw);
      if (!subscription) return failure("push_subscription_invalid");
      const result = await deps.store.saveSubscription({ ...subscription, sessionId, userId }, now());
      if (result === "disabled") return failure("browser_notifications_disabled");
      if (result === "session_inactive") return Response.json({ error: "unauthorized" }, { headers, status: 401 });
      return new Response(null, { headers, status: 204 });
    }),

    unsubscribe: (request: Request) => handle(request, "write", async ({ userId }) => {
      const [raw, bodyError] = await readBody(request);
      if (bodyError) return bodyError;
      const endpoint = decodePushUnsubscribeRequest(raw);
      if (!endpoint) return failure("push_subscription_invalid");
      await deps.store.deleteSubscription(userId, endpoint);
      return new Response(null, { headers, status: 204 });
    }),

    /**
     * The report only spares this session's own devices, so it needs no run
     * lookup: an unknown or foreign run id matches none of their pushes.
     */
    runShown: (request: Request) => handle(request, "write", async ({ sessionId }) => {
      const [raw, bodyError] = await readBody(request);
      if (bodyError) return bodyError;
      const runId = decodeShownRunRequest(raw);
      if (!runId) return failure("push_subscription_invalid");
      deps.runShown(runId, sessionId);
      return new Response(null, { headers, status: 204 });
    })
  };
}
