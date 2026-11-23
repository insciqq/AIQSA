import { describe, expect, it } from "vitest";
import { applyMemoryNoteEdit } from "./edit";
import { memoryNoteChangeAddsSecret, memoryNoteTextHoldsSecret } from "./secrets";

const SAVED = "synthetic-saved-value-0123456789";

function composed(before: string, find: string, text: string): string {
  const applied = applyMemoryNoteEdit(before, { find, kind: "replace", text });
  if ("code" in applied) throw new Error(applied.code);
  return applied.text;
}

describe("the memory note's credential screen of a whole change", () => {
  it("refuses a credential an edit assembles from the text around it, which the inserted text alone does not hold", () => {
    const before = "Staging: https://staging.example.org/";
    const insertion = "demo:fixture-pass@staging.example.org";
    expect(memoryNoteTextHoldsSecret(insertion, [])).toBe(false);
    const after = composed(before, "staging.example.org", insertion);
    expect(memoryNoteTextHoldsSecret(after, [])).toBe(true);
    expect(memoryNoteChangeAddsSecret(before, after, [])).toBe(true);
  });

  it("refuses a saved value an edit completes", () => {
    const before = "Token: synthetic-saved-value-XXXX";
    expect(memoryNoteChangeAddsSecret(before, composed(before, "XXXX", "0123456789"), [SAVED])).toBe(true);
    expect(memoryNoteChangeAddsSecret(before, composed(before, "Token", "Old token"), [SAVED])).toBe(false);
  });

  it("refuses a saved value an edit completes across a line break, and lets one an edit only moves or rewraps through", () => {
    const saved = "host=reports.example password=fixture-pass-42";
    const before = "Use host=reports.example";
    expect(memoryNoteChangeAddsSecret(before, `${before}\npassword=fixture-pass-42`, [saved])).toBe(true);
    expect(memoryNoteChangeAddsSecret(before, `${before}\n\n  password=fixture-pass-42 later`, [saved])).toBe(true);
    const holding = `Rules first.\nLogin host=reports.example\npassword=fixture-pass-42\nEnd.`;
    expect(memoryNoteChangeAddsSecret(holding, "Login host=reports.example password=fixture-pass-42\nRules first.\nEnd.", [saved]))
      .toBe(false);
    expect(memoryNoteChangeAddsSecret(holding, composed(holding, "Rules first.", "Rules second."), [saved])).toBe(false);
  });

  it("lets an edit through that adds no credential to a note that already held one, a removal included", () => {
    const before = `Use tables.\nOld key ${SAVED}\nStaging: https://demo:fixture-pass@staging.example.org/`;
    expect(memoryNoteChangeAddsSecret(before, composed(before, "Use tables.", "Use lists."), [SAVED])).toBe(false);
    expect(memoryNoteChangeAddsSecret(before, `Use tables.\nStaging: https://demo:fixture-pass@staging.example.org/`, [SAVED])).toBe(false);
    // A second copy is still one more than the note held.
    expect(memoryNoteChangeAddsSecret(before, `${before}\nAgain ${SAVED}`, [SAVED])).toBe(true);
  });
});
