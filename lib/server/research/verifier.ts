import type { ResearchGate } from "./gates";

/**
 * The independent verifier (`research-independent-verifier` fills this): a sub-agent turn on the administrator's verifier
 * model that gets claims and sources without the reasoning, and a mechanical check of each quote against opened text. Until
 * then it passes every draft.
 */
export const verifierGate: ResearchGate = {
  name: "verifier",
  run: async () => ({ kind: "pass" })
};
