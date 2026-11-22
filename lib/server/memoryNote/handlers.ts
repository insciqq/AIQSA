import type { z } from "zod";
import {
  MEMORY_NOTE_ERROR_HTTP_STATUS,
  MEMORY_NOTE_MAX_CHARACTERS,
  memoryLegacySuggestionActionSchema,
  memoryNoteOfferDecisionSchema,
  memoryNoteUpdateSchema,
  memorySwitchesUpdateSchema,
  type MemoryNoteErrorResponse
} from "@/lib/contracts/memoryNote";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { readJsonBodyOrNull, requestBodyErrorResponse } from "../http/requestBody";
import { logEvent } from "../observability";
import { databaseFailureCode } from "../observability/databaseFailure";
import { MemoryNoteError, type MemoryNoteService } from "./service";

/**
 * The Settings › Memory routes, which the answer's note cards and their Telegram messages call too
 * (`lib/server/telegram/changes/gateway.ts`). Each authenticates the active user and acts only on that user's own note,
 * offers and suggestions; bodies are exactly the `lib/contracts/memoryNote.ts` schemas, and a refusal is
 * `memoryNoteErrorResponseSchema`. Browser mutations pass the shared same-origin guard (`proxy.ts`).
 *
 * - `GET /api/me/memory/note` → `memoryNoteSchema`; `PUT` with `memoryNoteUpdateSchema` → the saved note.
 * - `GET /api/me/memory/preferences` → `memorySwitchesSchema`; `PATCH` with `memorySwitchesUpdateSchema` → the switches.
 * - `GET /api/me/memory/offers/[offerId]` → `memoryNoteOfferStatusSchema`; `POST` with `memoryNoteOfferDecisionSchema`
 *   → `memoryNoteOfferDecisionResultSchema`.
 * - `GET /api/me/memory/legacy?cursor=` → `memoryLegacySuggestionPageSchema`; `DELETE` removes them all and answers
 *   with the empty page.
 * - `POST /api/me/memory/legacy/[suggestionId]` with `memoryLegacySuggestionActionSchema` → `memoryNoteSchema`.
 */

const headers = { "cache-control": "private, no-store", vary: "Cookie" };

const SECRET_MESSAGE = "The note cannot hold passwords, tokens, keys or the values of your saved secrets. Keep them in Settings › Secrets.";

function body(value: unknown, status = 200): Response {
  return Response.json(value, { headers, status });
}

function refusal(error: MemoryNoteError): Response {
  if (error.code === "memory_note_unavailable") return body({ error: error.code }, 503);
  const response: MemoryNoteErrorResponse = {
    error: error.code,
    ...(error.details.reason === "secret" ? { message: SECRET_MESSAGE, reason: "secret" as const } : {}),
    ...(error.details.characters !== undefined ? { characters: error.details.characters, limit: MEMORY_NOTE_MAX_CHARACTERS } : {})
  };
  return body(response, MEMORY_NOTE_ERROR_HTTP_STATUS[error.code]);
}

const invalid = () => refusal(new MemoryNoteError("memory_note_invalid"));

type Decoded<T> = Readonly<{ value: T }> | Readonly<{ response: Response }>;

/** The request's JSON body decoded by `schema`, or the refusal. */
async function decode<T>(request: Request, schema: z.ZodType<T>): Promise<Decoded<T>> {
  const raw = await readJsonBodyOrNull(request);
  const tooLarge = requestBodyErrorResponse(raw);
  if (tooLarge) return { response: tooLarge };
  const parsed = schema.safeParse(raw);
  return parsed.success ? { value: parsed.data } : { response: invalid() };
}

export type MemoryNoteHandlers = Readonly<{
  noteGET(request: Request): Promise<Response>;
  notePUT(request: Request): Promise<Response>;
  preferencesGET(request: Request): Promise<Response>;
  preferencesPATCH(request: Request): Promise<Response>;
  offerGET(request: Request, offerId: string): Promise<Response>;
  offerPOST(request: Request, offerId: string): Promise<Response>;
  legacyGET(request: Request): Promise<Response>;
  legacyDELETE(request: Request): Promise<Response>;
  legacyItemPOST(request: Request, suggestionId: string): Promise<Response>;
}>;

export function createMemoryNoteHandlers(input: Readonly<{ resolveAuth: RequestAuthResolver; service: MemoryNoteService }>): MemoryNoteHandlers {
  const { service } = input;

  /** Authenticates the active user, then answers with what `work` returns, or its refusal. */
  async function handle(request: Request, work: (userId: string) => Promise<Response>): Promise<Response> {
    const auth = await input.resolveAuth(request);
    if (!auth) return body({ error: "unauthorized" }, 401);
    if (auth.user.status !== "active") return body({ error: "forbidden" }, 403);
    try {
      return await work(auth.userId);
    } catch (error) {
      if (error instanceof MemoryNoteError) return refusal(error);
      if (request.signal.aborted) throw error;
      logEvent("service_operation", { code: "memory_note_route_failed", error, outcome: "failed", prisma_code: databaseFailureCode(error),
        stage: "write", subsystem: "configuration" });
      return body({ error: "memory_note_unavailable" }, 503);
    }
  }

  return {
    noteGET: (request) => handle(request, async (userId) => body(await service.read(userId))),

    notePUT: (request) => handle(request, async (userId) => {
      const decoded = await decode(request, memoryNoteUpdateSchema);
      return "response" in decoded ? decoded.response : body(await service.save(userId, decoded.value));
    }),

    preferencesGET: (request) => handle(request, async (userId) => body(await service.switches(userId))),

    preferencesPATCH: (request) => handle(request, async (userId) => {
      const decoded = await decode(request, memorySwitchesUpdateSchema);
      return "response" in decoded ? decoded.response : body(await service.updateSwitches(userId, decoded.value));
    }),

    offerGET: (request, offerId) => handle(request, async (userId) => body(await service.offerStatus(userId, offerId))),

    offerPOST: (request, offerId) => handle(request, async (userId) => {
      const decoded = await decode(request, memoryNoteOfferDecisionSchema);
      return "response" in decoded ? decoded.response : body(await service.decideOffer(userId, offerId, decoded.value.decision));
    }),

    legacyGET: (request) => handle(request, async (userId) => {
      const params = new URL(request.url).searchParams;
      const cursors = params.getAll("cursor");
      if (cursors.length > 1 || [...params.keys()].some((key) => key !== "cursor")) return invalid();
      return body(await service.legacyPage(userId, cursors[0] ?? null));
    }),

    legacyDELETE: (request) => handle(request, async (userId) => {
      await service.removeAllLegacy(userId);
      return body({ nextCursor: null, suggestions: [] });
    }),

    legacyItemPOST: (request, suggestionId) => handle(request, async (userId) => {
      const decoded = await decode(request, memoryLegacySuggestionActionSchema);
      return "response" in decoded ? decoded.response : body(await service.legacyAction(userId, suggestionId, decoded.value.action));
    })
  };
}
