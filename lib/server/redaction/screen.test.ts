import { describe, expect, it } from "vitest";
import { SAVED_SECRET_MARKER } from "./savedSecrets";
import { redactSecretsAndSavedValues } from "./screen";
import { UNPROCESSED_TEXT_PLACEHOLDER } from "./secrets";

const URL_MARKER = "[REDACTED:CREDENTIAL_URL]";
const TOKEN_MARKER = "[REDACTED:TOKEN]";
const CREDENTIAL_URL = "https://deploy-bot:fixture-pass-42@db.example.org";
const GITHUB_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
const OPENAI_TOKEN = "sk-abcdefghijklmnopqrstuvwxyz123456";

const screen = (text: string, saved: readonly string[]) => redactSecretsAndSavedValues(text, saved).text;

describe("screening recognized secrets and saved values together", () => {
  it("removes a credential URL whole when a saved value sits inside it", () => {
    const text = `connect ${CREDENTIAL_URL} today`;
    expect(screen(text, ["deploy-bot"])).toBe(`connect ${URL_MARKER} today`);
    expect(screen(text, ["fixture-pass-42"])).toBe(`connect ${URL_MARKER} today`);
    // The same as with no saved values at all.
    expect(screen(text, [])).toBe(`connect ${URL_MARKER} today`);
  });

  it("removes a saved value whole when a recognized secret sits inside it", () => {
    const saved = `API_KEY=${OPENAI_TOKEN} DB_PASS=fixture-pass-42`;
    expect(screen(`rotation ${saved} schedule`, [saved])).toBe(`rotation ${SAVED_SECRET_MARKER} schedule`);
  });

  it("joins a saved value that ends inside a token with the token, so no tail is left", () => {
    const saved = "corp-prefix::ghp_abcdefghij";
    const result = screen(`x corp-prefix::${GITHUB_TOKEN} y`, [saved]);
    expect(result).toBe(`x ${TOKEN_MARKER} y`);
    expect(result).not.toContain("klmnop");
  });

  it("joins a saved value that starts inside a credential URL with it, so the password is not left", () => {
    const result = screen(`use ${CREDENTIAL_URL} lane-7 now`, ["db.example.org lane-7"]);
    expect(result).toBe(`use ${URL_MARKER} now`);
    expect(result).not.toContain("fixture-pass-42");
  });

  it("leaves one marker where a secret and a saved value touch", () => {
    expect(screen(`${GITHUB_TOKEN}:fixture-pass-42 end`, [":fixture-pass-42"])).toBe(`${TOKEN_MARKER} end`);
    expect(screen("a fixture-pass-42fixture-pass-43 b", ["fixture-pass-42", "fixture-pass-43"]))
      .toBe(`a ${SAVED_SECRET_MARKER} b`);
  });

  it("still finds a token that stands alone only once the saved value right before it is out", () => {
    const result = screen(`x saved-value-1234567890${OPENAI_TOKEN} y`, ["saved-value-1234567890"]);
    expect(result).toBe(`x ${TOKEN_MARKER} y`);
    expect(result).not.toContain("sk-");
  });

  it("matches values whatever line endings the text and the value use, and gives LF line breaks", () => {
    const crlf = "account=demo\r\npass=fixture-pass-42";
    const lf = "account=demo\npass=fixture-pass-42";
    expect(screen(`x ${lf} y`, [crlf])).toBe(`x ${SAVED_SECRET_MARKER} y`);
    expect(screen(`x\r\n${crlf}\r\ny`, [lf])).toBe(`x\n${SAVED_SECRET_MARKER}\ny`);
    expect(screen(`x\r${crlf}`, [crlf])).toBe(`x\n${SAVED_SECRET_MARKER}`);
    expect(screen(`Login:\r\n${CREDENTIAL_URL}\r\nThanks`, ["deploy-bot"])).toBe(`Login:\n${URL_MARKER}\nThanks`);
    // A value of line breaks alone would match ordinary text, so it is never matched.
    expect(screen("a\r\n\r\nb", ["\r\n\r\n"])).toBe("a\n\nb");
  });

  it("matches a saved value with any run of whitespace in the text for any run in the value", () => {
    const passphrase = "correct horse battery staple";
    expect(screen("a correct horse\nbattery staple b", [passphrase])).toBe(`a ${SAVED_SECRET_MARKER} b`);
    expect(screen("a correct\t\thorse  battery\r\n\r\nstaple b", [passphrase])).toBe(`a ${SAVED_SECRET_MARKER} b`);
    expect(screen("a correct horse battery staple b", ["correct\n  horse\tbattery staple"])).toBe(`a ${SAVED_SECRET_MARKER} b`);
    // Words still match as written: no match without whitespace where the value has it; inside a longer word, as before.
    expect(screen("a correcthorse battery staple b", [passphrase])).toBe("a correcthorse battery staple b");
    expect(screen("a correct horse battery stapler", [passphrase])).toBe(`a ${SAVED_SECRET_MARKER}r`);
    // Characters with a meaning in patterns match only themselves.
    expect(screen("pw a.b*c+(d) [e]|f$ end", ["a.b*c+(d) [e]|f$"])).toBe(`pw ${SAVED_SECRET_MARKER} end`);
    expect(screen("pw axb*c+(d) [e]|f$ end", ["a.b*c+(d) [e]|f$"])).toBe("pw axb*c+(d) [e]|f$ end");
    // Whitespace at a value's edge needs whitespace there, and covers one character of it.
    expect(screen("x\n\n fixture-pass-42\n\ny", [" fixture-pass-42\n"])).toBe(`x\n\n${SAVED_SECRET_MARKER}\ny`);
    expect(screen("xfixture-pass-42 y", [" fixture-pass-42"])).toBe("xfixture-pass-42 y");
    // A value of whitespace alone never matches, whatever kind.
    expect(screen("a \t \n b", [" \t", " ", "\n\n"])).toBe("a \t \n b");
    // Overlapping occurrences are all covered.
    expect(screen("p ab ab ab q", ["ab ab"])).toBe(`p ${SAVED_SECRET_MARKER} q`);
  });

  it("keeps markers already in the text, so screening screened text changes nothing", () => {
    const already = `a ${TOKEN_MARKER}${SAVED_SECRET_MARKER} b`;
    expect(redactSecretsAndSavedValues(already, ["SAVED_SECRET", "REDACTED:TOKEN"])).toEqual({ redacted: false, text: already });
    for (const [text, saved] of [[`connect ${CREDENTIAL_URL} today`, ["deploy-bot"]], [`x corp-prefix::${GITHUB_TOKEN} y`,
      ["corp-prefix::ghp_abcdefghij"]], [`x saved-value-1234567890${OPENAI_TOKEN} y`, ["saved-value-1234567890"]]] as const) {
      const once = screen(text, saved);
      expect(redactSecretsAndSavedValues(once, saved)).toEqual({ redacted: false, text: once });
    }
  });

  it("says whether anything was replaced", () => {
    expect(redactSecretsAndSavedValues("nothing secret here", ["fixture-pass-42"])).toEqual({ redacted: false, text: "nothing secret here" });
    expect(redactSecretsAndSavedValues("pass fixture-pass-42", ["fixture-pass-42"]).redacted).toBe(true);
  });

  it("in windows, withholds what lies past the bound, with all of a saved value that reaches into it", () => {
    const windows = { maxCodeUnits: 30, windowCodeUnits: 30 };
    const text = `${"a".repeat(29)} rest-of-value and more text`;
    expect(redactSecretsAndSavedValues(text, [], windows).text).toBe(`${"a".repeat(29)} ${UNPROCESSED_TEXT_PLACEHOLDER}`);
    expect(redactSecretsAndSavedValues(text, ["aaaaa rest-of-value"], windows).text)
      .toBe(`${"a".repeat(24)}${UNPROCESSED_TEXT_PLACEHOLDER}`);
  });
});
