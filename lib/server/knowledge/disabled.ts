import { KNOWLEDGE_DISABLED_CODE, KNOWLEDGE_ENABLED } from "../../domain/disabledAreas";

/** The refusal of any Knowledge change while Knowledge is disabled; reads keep working. */
export function knowledgeDisabledResponse(): Response {
  return Response.json({ error: KNOWLEDGE_DISABLED_CODE }, { status: 409 });
}

/**
 * A Knowledge change handler, or while Knowledge is disabled
 * (`lib/domain/disabledAreas.ts`) a refusal before authentication, parsing,
 * storage or any repository access.
 */
export function refusedWhileKnowledgeDisabled<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return KNOWLEDGE_ENABLED ? handler : async () => knowledgeDisabledResponse();
}
