import { decodeChatPdfPreparations } from "../../contracts/chatPdfPreparation";
import {
  RUN_OUTCOME_RESPONSE_VERSION,
  type RunOutcomeResponse
} from "../../contracts/runs";
import type { RunOutcomeRecord } from "./runRepositoryContract";

/** Runtime privacy boundary for the owner-authorized run outcome route. */
export function serializeRunOutcome(record: RunOutcomeRecord): RunOutcomeResponse {
  const pdfPreparation = decodeChatPdfPreparations(record.pdfPreparation);
  return {
    run: {
      ...(pdfPreparation ? { pdfPreparation } : {}),
      id: record.id,
      status: record.status
    },
    version: RUN_OUTCOME_RESPONSE_VERSION
  };
}
