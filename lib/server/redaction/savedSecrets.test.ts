import { describe, expect, it } from "vitest";
import {
  SAVED_SECRET_MARKER,
  savedSecretScreenedValues,
  savedSecretValueIsScreened,
  valueContainsSavedSecret,
  redactSavedSecretValues
} from "./savedSecrets";

const TOKEN = "tok_demo_7f3a9c21b8e4";

describe("saved secret matching", () => {
  it("screens values that look like secrets and leaves plain words alone", () => {
    for (const value of [TOKEN, "12345678", "env-value-123", "Europe/Moscow", "p@ssword",
      "correct horse battery staple", "пароль-2026"]) {
      expect(savedSecretValueIsScreened(value)).toBe(true);
    }
    for (const value of ["localhost", "production", "New York", "abc1234", "password", "Москва и область",
      "correct horse"]) {
      expect(savedSecretValueIsScreened(value)).toBe(false);
    }
  });

  it("collects each screened value of a saved secret, trimmed too, by kind", () => {
    expect(savedSecretScreenedValues([
      { name: "Demo", value: { kind: "text", text: ` ${TOKEN}\n` } },
      { name: "Env", value: { entries: [{ name: "DB_HOST", value: "localhost" }, { name: "DB_PASS", value: "s3cret-pass" },
        { name: "ENV", value: "production" }], kind: "env" } }
    ])).toEqual([` ${TOKEN}\n`, TOKEN, "s3cret-pass"]);
  });

  it("adds the LF form of a value saved with CRLF line endings, so LF text still matches it", () => {
    const crlf = "account=demo\r\npass=fixture-pass-42";
    const saved = savedSecretScreenedValues([{ name: "Login", value: { kind: "text", text: crlf } }]);
    expect(saved).toEqual([crlf, "account=demo\npass=fixture-pass-42"]);
    expect(valueContainsSavedSecret("Login:\naccount=demo\npass=fixture-pass-42", saved)).toBe(true);
    expect(redactSavedSecretValues("x account=demo\npass=fixture-pass-42 y", saved).text).toBe(`x ${SAVED_SECRET_MARKER} y`);
  });

  it("finds a screened value only, so facts naming a plain setting are kept", () => {
    const saved = savedSecretScreenedValues([{ name: "Env", value: { entries: [
      { name: "DB_HOST", value: "localhost" }, { name: "TOKEN", value: TOKEN }], kind: "env" } }]);
    expect(valueContainsSavedSecret("My dev database runs on localhost.", saved)).toBe(false);
    expect(valueContainsSavedSecret(`The demo token is ${TOKEN}.`, saved)).toBe(true);
  });

  it("replaces every occurrence with the marker, the longest value first", () => {
    const longer = `${TOKEN}-extended`;
    const text = `a ${TOKEN} b ${longer} c ${TOKEN}`;
    expect(redactSavedSecretValues(text, [TOKEN, longer])).toEqual({
      redacted: true,
      text: `a ${SAVED_SECRET_MARKER} b ${SAVED_SECRET_MARKER} c ${SAVED_SECRET_MARKER}`
    });
    expect(redactSavedSecretValues("nothing saved here", [TOKEN])).toEqual({
      redacted: false, text: "nothing saved here"
    });
    // A value that also occurs inside the marker never splits a replacement.
    expect(redactSavedSecretValues("x SAVED_SECRET y", ["SAVED_SECRET"]).text)
      .toBe(`x ${SAVED_SECRET_MARKER} y`);
  });
});
