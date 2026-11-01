import { PROXY_UNAVAILABLE_CODE } from "@/lib/contracts/proxies";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { ADMINISTRATOR_PROXY_SCOPE, personalProxyScope, type ProxyStore } from "./store";
import { isProxyId, parseProxyVersion, ProxyError, type ProxyErrorCode } from "./validation";

const reply = (body: unknown, status = 200) => Response.json(body, { headers: { "cache-control": "private, no-store" }, status });

/** The address rule's refusals are about the input; only a check that could not run is the server's. */
function statusOf(code: ProxyErrorCode): number {
  if (code === "proxy_not_found") return 404;
  if (code === "proxy_conflict" || code === "proxy_limit" || code === "proxy_name_taken") return 409;
  return code === PROXY_UNAVAILABLE_CODE || code === "proxy_address_check_unavailable" ? 503 : 400;
}

export type ProxyAction = "check" | "create" | "delete" | "list" | "update";
/** Whose list a route serves: the caller's own, or the administrators' to an administrator. */
export type ProxyAudience = "administrator" | "personal";

/**
 * The personal and administrator proxy routes. A proxy of another user, one of
 * the other audience and a missing one all answer `proxy_not_found`, and no
 * response holds a password.
 */
export function createProxyHandlers(input: Readonly<{ resolveAuth: RequestAuthResolver; store: ProxyStore }>) {
  return async function handle(request: Request, action: ProxyAction, audience: ProxyAudience, id?: string): Promise<Response> {
    const auth = await input.resolveAuth(request);
    if (!auth) return reply({ error: "unauthorized" }, 401);
    if (auth.user.status !== "active" || audience === "administrator" && auth.user.role !== "admin") return reply({ error: "forbidden" }, 403);
    if (id !== undefined && !isProxyId(id)) return reply({ error: "proxy_not_found" }, 404);
    const scope = audience === "administrator" ? ADMINISTRATOR_PROXY_SCOPE : personalProxyScope(auth.userId);
    try {
      if (action === "list") {
        return audience === "administrator" ? reply({ proxies: await input.store.listAdministrator() }) : reply(await input.store.listPersonal(auth.userId));
      }
      if (action === "check") return reply(await input.store.check(scope, id!, request.signal));
      const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (type !== "application/json" && !type?.endsWith("+json")) return reply({ error: "json_required" }, 415);
      const body = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(body);
      if (bodyError) return bodyError;
      if (action === "create") return reply({ proxy: await input.store.create(scope, body, request.signal) }, 201);
      if (action === "update") return reply({ proxy: await input.store.update(scope, id!, body, request.signal) });
      const raw = body as { expectedVersion?: unknown } | null;
      const expectedVersion = parseProxyVersion(raw?.expectedVersion);
      if (Object.keys(raw!).length !== 1) throw new ProxyError("proxy_input_invalid");
      await input.store.remove(scope, id!, expectedVersion);
      return reply({ ok: true });
    } catch (error) {
      if (error instanceof ProxyError) return reply({ error: error.code }, statusOf(error.code));
      if (request.signal.aborted) throw error;
      logEvent("service_operation", { error, subsystem: "configuration", stage: "write", outcome: "failed", code: "proxy_change_failed",
        prisma_code: databaseFailureCode(error) });
      return reply({ error: PROXY_UNAVAILABLE_CODE }, 503);
    }
  };
}
