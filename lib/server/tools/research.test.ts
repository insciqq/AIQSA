import type { JsonSchemaType } from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { describe, expect, it } from "vitest";
import { decodeResearchDraft, RESEARCH_LIMITS } from "../../contracts/research";
import { submitResearchDraftTool } from "./research";

describe("submit_research_draft schema", () => {
  const validator = new AjvJsonSchemaValidator().getValidator(submitResearchDraftTool.inputSchema as JsonSchemaType);
  const validate = (input: unknown) => validator(input).valid;
  const references = { branch_picks: [], does_not_separate: null, pick_row_key: null, record_ids: [], unreachable: [] };
  const summary = { row_keys: [], text: "Try both." };

  it("accepts a whole report or edits with an optional replacement summary", () => {
    expect(validate({ ...references, report: "Report.", summary })).toBe(true);
    expect(validate({ ...references, edits: [{ old: "Old.", new: "New." }] })).toBe(true);
    expect(validate({ ...references, edits: [], summary })).toBe(true);
    expect(decodeResearchDraft({ ...references, report: "Report.", edits: [], summary })).toMatchObject({ ok: false, message: expect.stringContaining("either report or edits") });
    expect(decodeResearchDraft({ ...references, summary })).toMatchObject({ ok: false, message: expect.stringContaining("report must be") });
  });

  it("requires full references and bounds edits in the static schema", () => {
    for (const field of Object.keys(references)) {
      const partial: Record<string, unknown> = { ...references, edits: [] };
      delete partial[field];
      expect(validate(partial)).toBe(false);
    }
    expect(validate({ ...references, edits: Array.from({ length: RESEARCH_LIMITS.draftEdits + 1 }, () => ({ old: "Old.", new: "New." })) })).toBe(false);
    expect(validate({ ...references, edits: [{ old: "", new: "New." }] })).toBe(false);
    expect(validate({ ...references, edits: [{ old: "Old.", new: "x".repeat(RESEARCH_LIMITS.draftEditCharacters + 1) }] })).toBe(false);
  });
});
