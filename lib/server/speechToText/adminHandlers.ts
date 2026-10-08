import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { isSpeechToTextModelId } from "../../contracts/speechToText";
import { SpeechToTextAdminError, type SpeechToTextAdminService } from "./adminService";

const NO_STORE = { "cache-control": "no-store" } as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function fence(value: unknown): value is string | null {
  return value === null || typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { headers: NO_STORE, status });
}

function failure(error: unknown): Response {
  if (error instanceof SpeechToTextAdminError) {
    const status = error.code === "speech_to_text_stale" ? 409
      : error.code === "speech_to_text_test_failed" ? 422
        : error.code === "speech_to_text_model_invalid" ? 400
          : error.code === "speech_to_text_connection_unavailable" ? 409 : 502;
    return json({ error: error.code, ...(error.reason ? { reason: error.reason } : {}) }, status);
  }
  logEvent("service_operation", { subsystem: "dictation", stage: "write", outcome: "failed", code: "speech_to_text_admin_action_failed",
    prisma_code: databaseFailureCode(error) });
  return json({ error: "speech_to_text_admin_action_failed" }, 500);
}

/**
 * `GET` reads the role; `POST` takes one action: `discover` lists a
 * connection's speech-to-text models, `test_and_save` runs the paid Test and
 * saves only when it passes, `clear` removes the role. Administrators only.
 */
export function createSpeechToTextAdminHandlers(input: Readonly<{
  resolveAuth: RequestAuthResolver;
  service: SpeechToTextAdminService;
}>) {
  async function requireAdmin(request: Request) {
    const session = await input.resolveAuth(request);
    if (!session) return { error: json({ error: "unauthorized" }, 401), session: null };
    if (session.user.status !== "active" || session.user.role !== "admin") return { error: json({ error: "forbidden" }, 403), session: null };
    return { error: null, session };
  }

  return {
    async GET(request: Request): Promise<Response> {
      const auth = await requireAdmin(request);
      if (auth.error) return auth.error;
      try {
        return json({ speechToText: await input.service.read() });
      } catch (error) {
        return failure(error);
      }
    },

    async POST(request: Request): Promise<Response> {
      const type = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
      if (type !== "application/json") return json({ error: "json_required" }, 415);
      const auth = await requireAdmin(request);
      if (auth.error || !auth.session) return auth.error!;
      const value = await readJsonBodyOrNull(request, "json");
      const bodyError = requestBodyErrorResponse(value);
      if (bodyError) return bodyError;
      const invalid = () => json({ error: "speech_to_text_request_invalid" }, 400);
      if (!record(value)) return invalid();
      const keys = Object.keys(value).sort().join(",");
      try {
        if (value.action === "discover") {
          if (keys !== "action,connectionId" || !identifier(value.connectionId)) return invalid();
          return json({ models: await input.service.discover({ connectionId: value.connectionId, signal: request.signal }) });
        }
        if (value.action === "test_and_save") {
          if (keys !== "action,connectionId,expectedConfiguredAt,modelId" || !identifier(value.connectionId) ||
            !isSpeechToTextModelId(value.modelId) || !fence(value.expectedConfiguredAt)) return invalid();
          await input.service.testAndSave({ connectionId: value.connectionId, expectedConfiguredAt: value.expectedConfiguredAt,
            modelId: value.modelId, signal: request.signal, userId: auth.session.userId });
          return json({ speechToText: await input.service.read() });
        }
        if (value.action === "clear") {
          if (keys !== "action,expectedConfiguredAt" || !fence(value.expectedConfiguredAt)) return invalid();
          await input.service.clear({ expectedConfiguredAt: value.expectedConfiguredAt, userId: auth.session.userId });
          return json({ speechToText: await input.service.read() });
        }
        return invalid();
      } catch (error) {
        return failure(error);
      }
    }
  };
}
