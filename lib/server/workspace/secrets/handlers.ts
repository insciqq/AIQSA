import type { RequestAuthResolver } from "../../auth/requestAuth";
import { readBoundedRequestBody, RequestBodyTooLargeError, requestBodyErrorResponse } from "../../http/requestBody";
import { getRequestBodyConfig } from "../../http/requestBodyConfig";
import type { WorkspaceSecretStore } from "./store";
import { parseWorkspaceSecretMutation, WORKSPACE_SECRET_MUTATION_MAX_BYTES, WorkspaceSecretError } from "./validation";

/** A browser-session import exceeds the generic JSON cap; the route owns its larger, still bounded body. */
async function readMutationBody(request: Request): Promise<unknown> {
  try {
    const bytes = await readBoundedRequestBody(request, {
      maxBytes: Math.max(getRequestBodyConfig().jsonMaxBytes, WORKSPACE_SECRET_MUTATION_MAX_BYTES)
    });
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return error;
    if (request.signal.aborted) throw error;
    return null;
  }
}

export function createWorkspaceSecretHandlers(input: { resolveAuth: RequestAuthResolver; store: WorkspaceSecretStore }) {
  async function handle(request: Request, write: boolean): Promise<Response> {
    const auth = await input.resolveAuth(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (auth.user.status !== "active") return Response.json({ error: "forbidden" }, { status: 403 });
    try {
      if (write) {
        const raw = await readMutationBody(request);
        const bodyError = requestBodyErrorResponse(raw);
        if (bodyError) return bodyError;
        await input.store.mutate(auth.userId, parseWorkspaceSecretMutation(raw));
      }
      const secrets = await input.store.list(auth.userId);
      const browserAutosave = await input.store.browserAutosave(auth.userId);
      return Response.json({ secrets, ...(browserAutosave ? { browserAutosave } : {}) }, { headers: { "cache-control": "private, no-store" } });
    } catch (error) {
      const code = error instanceof WorkspaceSecretError ? error.code : "workspace_secret_unavailable";
      return Response.json({ error: code }, { status: code === "workspace_secret_conflict" ? 409 : code === "workspace_secret_unavailable" ? 503 : 400 });
    }
  }
  return { GET: (request: Request) => handle(request, false), POST: (request: Request) => handle(request, true) };
}
