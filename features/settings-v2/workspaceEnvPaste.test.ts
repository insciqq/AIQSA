import { describe, expect, it } from "vitest";
import { mergeWorkspaceEnvPaste, WORKSPACE_ENV_PASTE_CHARACTER_LIMIT } from "./workspaceEnvPaste";

describe("local .env paste", () => {
  it("ignores blank/comment lines, accepts export, splits once and keeps unquoted hashes and expressions", () => {
    expect(mergeWorkspaceEnvPaste("\n # comment\nexport TOKEN = abc=def # literal\nVALUE=$(cat file) ${TOKEN}\n9BAD=no\nmissing equals", [])).toEqual({
      entries: [{ name: "TOKEN", value: "abc=def # literal" }, { name: "VALUE", value: "$(cat file) ${TOKEN}" }], added: 2, replaced: 0, skipped: 2, tooLarge: false
    });
  });
  it("keeps single quotes literal and decodes only the supported double-quoted escapes", () => {
    const result = mergeWorkspaceEnvPaste(String.raw`LITERAL='a\nb\t${"${NAME}"}'
DOUBLE="one\ntwo\r\t\"\\\q"`, []);
    expect(result.entries).toEqual([{ name: "LITERAL", value: String.raw`a\nb\t${"${NAME}"}` }, { name: "DOUBLE", value: "one\ntwo\r\t\"\\\\q" }]);
  });
  it("preserves quoted physical newlines and accepts whitespace/comments after the closing quote", () => {
    expect(mergeWorkspaceEnvPaste('MULTI="first\r\nsecond" # comment\nEMPTY=""\nSINGLE=\'literal\'  ', []).entries).toEqual([
      { name: "MULTI", value: "first\r\nsecond" }, { name: "EMPTY", value: "" }, { name: "SINGLE", value: "literal" }
    ]);
  });
  it("uses the last duplicate, merges in order and removes only empty trailing rows", () => {
    const existing = [{ name: "FIRST", value: "old" }, { name: "", value: "keep this draft" }, { name: "", value: "" }];
    const result = mergeWorkspaceEnvPaste("FIRST=new\nADDED=one\nADDED=two", existing);
    expect(result).toEqual({ entries: [{ name: "FIRST", value: "new" }, { name: "", value: "keep this draft" }, { name: "ADDED", value: "two" }], added: 1, replaced: 1, skipped: 0, tooLarge: false });
    expect(existing[0].value).toBe("old");
    expect(existing).toHaveLength(3);
  });
  it("can replace at the 64-row cap but skips additional names", () => {
    const existing = Array.from({ length: 64 }, (_, index) => ({ name: `KEY_${index}`, value: "old" }));
    const result = mergeWorkspaceEnvPaste("EXCESS=one\nKEY_3=updated\nEXCESS=last\nANOTHER=no", existing);
    expect(result).toMatchObject({ added: 0, replaced: 1, skipped: 2 });
    expect(result.entries).toHaveLength(64);
    expect(result.entries[3]).toEqual({ name: "KEY_3", value: "updated" });
  });
  it("rejects invalid trailing text and unterminated quotes without losing the existing table", () => {
    const existing = [{ name: "KEEP", value: "unchanged" }];
    const result = mergeWorkspaceEnvPaste('BAD="closed"junk\nUNCLOSED="first\nlast', existing);
    expect(result).toMatchObject({ entries: existing, added: 0, replaced: 0, skipped: 2 });
    expect(mergeWorkspaceEnvPaste("# only comments", []).entries).toEqual([{ name: "", value: "" }]);
  });
  it("bounds oversized paste before parsing, without altering the existing draft", () => {
    const existing = [{ name: "KEEP", value: "unchanged" }];
    expect(mergeWorkspaceEnvPaste("x".repeat(WORKSPACE_ENV_PASTE_CHARACTER_LIMIT + 1), existing)).toEqual({ entries: existing, added: 0, replaced: 0, skipped: 0, tooLarge: true });
  });
});
