import { describe, expect, it } from "vitest";
import {
  MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
  MEMORY_FACT_EXTRACTION_SCHEMA_VERSION
} from "./contract";
import {
  MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT,
  memoryFactExtractionTool
} from "./prompt";
import { MEMORY_PREFERENCE_DIMENSION_PREFIXES } from "../identity/registry";

describe("Memory semantic-frame extraction prompt", () => {
  it("locks the v5 forced-strict wire shape under the current prompt policy", () => {
    expect(MEMORY_FACT_EXTRACTION_PROMPT_VERSION)
      .toBe("memory-fact-extraction-prompt-v25");
    expect(MEMORY_FACT_EXTRACTION_SCHEMA_VERSION)
      .toBe("memory-fact-extraction-schema-v5");
    expect(memoryFactExtractionTool).toMatchObject({
      name: "submit_memory_fact_observations_v5",
      strict: true
    });
    const observation = (memoryFactExtractionTool.inputSchema as {
      properties: { observations: { items: { properties: Record<string, unknown> } } };
    }).properties.observations.items.properties;
    expect(Object.keys(observation).sort()).toEqual([
      "candidate_ref", "confidence_band", "dependency_refs", "entities",
      "evidence", "future_useful", "identity", "memory_type", "reason_code",
      "semantic_frame", "sensitivity", "statement", "temporal", "temporary",
      "value"
    ]);
  });

  it("makes semantic authority and exact occurrences explicit", () => {
    for (const rule of [
      "zero-based exact occurrence index",
      "zero-based ordinal among identical exact-text matches",
      "never a character offset",
      "language-neutral semantic_frame",
      "the name value is not a separate PERSON_SELF object or alias",
      "question, condition, hypothesis, quotation",
      "must produce one HIGH-confidence observation",
      "synthetic-looking, hyphenated, non-Latin",
      "memory_type STATE, confidence_band HIGH, future_useful true",
      "Put X in value.value, use value.kind name and value.state known",
      "Apply this semantic rule language-neutrally",
      "predicate_key product_status",
      "Set value.state to owned and every other value field to null",
      "must exactly equal the entity_type and canonical_label",
      "never leave identity.subject.canonical_label null",
      "Every non-null identity.subject brand or model qualifier",
      "same key and value plus an exact source occurrence",
      "full exact mention as canonical_label with null brand and model qualifiers",
      "mere neighboring product mention is never direct ownership",
      "one residence SLOT observation",
      "predicate_key residence, dimension_key primary",
      "value.place to the grounded PLACE canonical label",
      "qualifier_supports key canonical_place",
      "one PREFERENCE observation",
      "use identity mode SLOT with subject PERSON_SELF",
      "predicate_key preference",
      "Positive preference SLOT anchor",
      "do not downgrade it to PROPOSITION",
      "value.value to the explicitly preferred value",
      "never infer or manufacture a missing preference dimension",
      "does not explicitly supply a stable category, format, interaction, or topic dimension",
      "never invent a SLOT dimension",
      "structured temporal normalization",
      "target_message.created_at in time_zone",
      "preserving the exact original wording",
      "PRONOMINAL, ELLIPSIS, UNKNOWN",
      "no prose or hidden rationale"
    ]) {
      expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT).toContain(rule);
    }
    for (const prefix of MEMORY_PREFERENCE_DIMENSION_PREFIXES) {
      expect(MEMORY_FACT_EXTRACTION_SYSTEM_PROMPT)
        .toContain(`${prefix}:<grounded dimension>`);
    }
  });
});
