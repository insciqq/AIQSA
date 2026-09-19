import { decodeSkillSuggestionRequest } from "../../contracts/skillSuggestions";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import type { SkillSuggestionService } from "./suggestionService";

export function createSkillSuggestionHandler(deps: Readonly<{ resolveAuth: RequestAuthResolver; suggest: SkillSuggestionService }>) {
  return async (request: Request): Promise<Response> => {
    const session = await deps.resolveAuth(request);
    if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });
    const value = await readJsonBodyOrNull(request);
    const bodyError = requestBodyErrorResponse(value);
    if (bodyError) return bodyError;
    const input = decodeSkillSuggestionRequest(value);
    if (!input) return Response.json({ error: "skill_suggestion_request_invalid" }, { status: 400 });
    return Response.json(await deps.suggest(session.userId, input, { signal: request.signal,
      async authorizeSession() {
        const current = await deps.resolveAuth(request);
        if (!current || current.id !== session.id || current.userId !== session.userId) throw new Error("skill_suggestion_session_unavailable");
      }
    }), { headers: { "cache-control": "no-store" } });
  };
}
