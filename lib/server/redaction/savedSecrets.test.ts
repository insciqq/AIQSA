import { describe, expect, it } from "vitest";
import {
  MEMORY_SAVED_SECRET_MARKER,
  memorySavedSecretScreenedValues,
  memorySavedSecretValueIsScreened,
  memoryValueContainsSavedSecret,
  redactMemorySavedSecretValues
} from "./savedSecretMatching";

const TOKEN = "tok_demo_7f3a9c21b8e4";

describe("saved secret matching", () => {
  it("screens values that look like secrets and leaves plain words alone", () => {
    for (const value of [TOKEN, "12345678", "env-value-123", "Europe/Moscow", "p@ssword",
      "correct horse battery staple", "пароль-2026"]) {
      expect(memorySavedSecretValueIsScreened(value)).toBe(true);
    }
    for (const value of ["localhost", "production", "New York", "abc1234", "password", "Москва и область",
      "correct horse"]) {
      expect(memorySavedSecretValueIsScreened(value)).toBe(false);
    }
  });

  it("collects each screened value of a saved secret, trimmed too, by kind", () => {
    expect(memorySavedSecretScreenedValues([
      { name: "Demo", value: { kind: "text", text: ` ${TOKEN}\n` } },
      { name: "Env", value: { entries: [{ name: "DB_HOST", value: "localhost" }, { name: "DB_PASS", value: "s3cret-pass" },
        { name: "ENV", value: "production" }], kind: "env" } }
    ])).toEqual([` ${TOKEN}\n`, TOKEN, "s3cret-pass"]);
  });

  it("finds a screened value only, so facts naming a plain setting are kept", () => {
    const saved = memorySavedSecretScreenedValues([{ name: "Env", value: { entries: [
      { name: "DB_HOST", value: "localhost" }, { name: "TOKEN", value: TOKEN }], kind: "env" } }]);
    expect(memoryValueContainsSavedSecret("My dev database runs on localhost.", saved)).toBe(false);
    expect(memoryValueContainsSavedSecret(`The demo token is ${TOKEN}.`, saved)).toBe(true);
  });

  it("replaces every occurrence with the marker, the longest value first", () => {
    const longer = `${TOKEN}-extended`;
    const text = `a ${TOKEN} b ${longer} c ${TOKEN}`;
    expect(redactMemorySavedSecretValues(text, [TOKEN, longer])).toEqual({
      redacted: true,
      text: `a ${MEMORY_SAVED_SECRET_MARKER} b ${MEMORY_SAVED_SECRET_MARKER} c ${MEMORY_SAVED_SECRET_MARKER}`
    });
    expect(redactMemorySavedSecretValues("nothing saved here", [TOKEN])).toEqual({
      redacted: false, text: "nothing saved here"
    });
    // A value that also occurs inside the marker never splits a replacement.
    expect(redactMemorySavedSecretValues("x SAVED_SECRET y", ["SAVED_SECRET"]).text)
      .toBe(`x ${MEMORY_SAVED_SECRET_MARKER} y`);
  });
});
