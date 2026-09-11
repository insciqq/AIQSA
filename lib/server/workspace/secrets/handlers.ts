import type { RequestAuthResolver } from "../../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../../http/requestBody";
import type { WorkspaceSecretStore } from "./store";
import { parseWorkspaceSecretMutation, WorkspaceSecretError } from "./validation";

export function createWorkspaceSecretHandlers(input: { resolveAuth: RequestAuthResolver; store: WorkspaceSecretStore }) {
  async function handle(request: Request, write: boolean): Promise<Response> {
    const auth = await input.resolveAuth(request);
    if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (auth.user.status !== "active") return Response.json({ error: "forbidden" }, { status: 403 });
    try {
      if (write) {
        const raw = await readJsonBodyOrNull(request);
        const bodyError = requestBodyErrorResponse(raw);
        if (bodyError) return bodyError;
        await input.store.mutate(auth.userId, parseWorkspaceSecretMutation(raw));
      }
      return Response.json({ secrets: await input.store.list(auth.userId) }, { headers: { "cache-control": "private, no-store" } });
    } catch (error) {
      const code = error instanceof WorkspaceSecretError ? error.code : "workspace_secret_unavailable";
      return Response.json({ error: code }, { status: code === "workspace_secret_conflict" ? 409 : code === "workspace_secret_unavailable" ? 503 : 400 });
    }
  }
  return { GET: (request: Request) => handle(request, false), POST: (request: Request) => handle(request, true) };
}
