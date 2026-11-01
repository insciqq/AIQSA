import type { ResearchGate } from "./gates";

/**
 * The gap check (`research-gap-rounds` fills this): open questions, weak answers, conflicts and source classes with no
 * opened source send the main agent back for another round. Until then it passes every draft.
 */
export const gapCheckGate: ResearchGate = {
  name: "gap_check",
  run: async () => ({ kind: "pass" })
};
