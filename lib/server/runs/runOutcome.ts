import {
  RUN_OUTCOME_RESPONSE_VERSION,
  type RunOutcomeResponse
} from "../../contracts/runs";
import type { RunOutcomeRecord } from "./runRepositoryContract";

/** Runtime privacy boundary for the owner-authorized run outcome route. */
export function serializeRunOutcome(record: RunOutcomeRecord): RunOutcomeResponse {
  return {
    run: {
      id: record.id,
      status: record.status
    },
    version: RUN_OUTCOME_RESPONSE_VERSION
  };
}
