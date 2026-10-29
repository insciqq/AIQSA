import { describe, expect, it } from "vitest";
import { decisionUpgradeFixtureSql, decisionUpgradeProofSql } from "./decision-upgrade-adoption";
import { semanticDecisionsFixtureSql, semanticDecisionsProofSql } from "./semantic-decisions-adoption";

/** Evaluate the JSONB key-removal projection only, without running a database smoke. */
function projectedPolicy(sql: string, row: Readonly<Record<string, unknown>>) {
  const projection = /to_jsonb\(policy\)((?:\s*-\s*'[^']+')*)/u.exec(sql);
  if (!projection) throw new Error("policy_projection_missing");
  const excluded = new Set([...projection[1].matchAll(/'([^']+)'/gu)].map(match => match[1]));
  return Object.fromEntries(Object.entries(row).filter(([key]) => !excluded.has(key)));
}

const predecessor = { id: "installation", providerModelId: "existing-model", reasoningEffort: "low", version: 13 };
const laterFields = { visionProviderModelId: null, visionReasoningEffort: null, speechToTextConnectionId: null,
  speechToTextModelId: null, speechToTextCredentialVersionId: null, speechToTextConfiguredAt: null,
  mcpGuardProviderModelId: null, mcpGuardReasoningEffort: null };

describe("MCP guard forward-adoption compatibility", () => {
  it.each([
    { name: "optional semantic decisions", fixture: semanticDecisionsFixtureSql, proof: semanticDecisionsProofSql,
      adopted: { decisionProviderModelId: null, decisionConfiguredAt: null, decisionFeaturesJson: {},
        decisionAdoptionVersion: 0, decisionAdoptionReason: null } },
    { name: "decision upgrade", fixture: decisionUpgradeFixtureSql, proof: decisionUpgradeProofSql,
      adopted: { decisionAdoptionVersion: 0, decisionAdoptionReason: null } }
  ])("$name ignores later guard columns but still detects changes to existing policy", ({ fixture, proof, adopted }) => {
    const original = projectedPolicy(fixture, predecessor);
    const upgraded = { ...predecessor, ...adopted, ...laterFields };
    expect(projectedPolicy(proof, upgraded)).toEqual(original);
    // The fixture is also safe when it runs with those columns already present.
    expect(projectedPolicy(fixture, { ...predecessor, mcpGuardProviderModelId: "guard", mcpGuardReasoningEffort: "high" })).toEqual(original);
    expect(projectedPolicy(proof, { ...upgraded, providerModelId: "changed-model" })).not.toEqual(original);
    expect(projectedPolicy(proof, { ...upgraded, version: 14 })).not.toEqual(original);
  });
});
