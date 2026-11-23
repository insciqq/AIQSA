import { describe, expect, it } from "vitest";
import {
  SAVED_SECRET_MARKER,
  savedSecretIdentifierVariable,
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

  it("leaves an env variable's login, email, region and bare address unscreened, beside its password", () => {
    const saved = savedSecretScreenedValues([{ name: "Jira", value: { entries: [
      { name: "JIRA_URL", value: "https://jira.example.com" }, { name: "JIRA_LOGIN", value: "ivan.petrov@example.com" },
      { name: "AWS_REGION", value: "eu-central-1" }, { name: "JIRA_PASSWORD", value: "fixture-pass-42" },
      // An address with a path, one with a user and password, and one named as a secret's stay screened.
      { name: "HOOK_URL", value: "https://hooks.example.com/services/T000/B000" },
      { name: "SMTP_HOST", value: "bob:fixture-pw@mail.example.com" }, { name: "TOKEN_URL", value: "https://auth.example.com" }
    ], kind: "env" } }]);
    expect(saved).toEqual(["fixture-pass-42", "https://hooks.example.com/services/T000/B000", "bob:fixture-pw@mail.example.com",
      "https://auth.example.com"]);
    expect(valueContainsSavedSecret("My work email is ivan.petrov@example.com; tickets live at https://jira.example.com/browse/ABC", saved))
      .toBe(false);
    expect(valueContainsSavedSecret("Region eu-central-1, password fixture-pass-42", saved)).toBe(true);
    // A text secret is screened whole, whatever its name.
    expect(savedSecretScreenedValues([{ name: "EMAIL", value: { kind: "text", text: "ivan.petrov@example.com" } }]))
      .toEqual(["ivan.petrov@example.com"]);
  });

  it("leaves an identifier variable unscreened only when its value has that identifier's shape", () => {
    const plain = [
      ["SERVICE_LOGIN", "deploy-bot"], ["JIRA_EMAIL", "ivan.petrov@example.com"], ["REDIS_HOST", "cache.example.org"],
      ["REDIS_HOST", "cache.example.org:6379"], ["REDIS_HOST", "redis:6379"], ["DB_HOST", "10.0.0.5"], ["AWS_REGION", "eu-central-1"],
      ["JIRA_HOST", "https://jira.example.com"], ["JIRA_HOST", "https://jira.example.com:8443/"], ["DB_PORT", "5432"]
    ];
    const credentials = [
      // A login with a password part, and a login and PIN shaped like a host and port outside a host variable.
      ["SERVICE_LOGIN", "demo:fixture-pass-42"], ["SERVICE_LOGIN", "demo:1234"],
      ["JIRA_EMAIL", "ivan.petrov:fixture-pass-42@example.com"],
      // Hosts with a password, with or without a user, and one in a connection string with another scheme.
      ["REDIS_HOST", "redis://:fixture-pass-42@cache.example.org/0"], ["REDIS_HOST", ":fixture-pass-42@cache.example.org"],
      ["DB_HOST", "postgres://db.example.org:5432"], ["AWS_REGION", "eu-central-1:fixture-pass-42"],
      // Origins with a user, a query or a path.
      ["JIRA_HOST", "https://ivan:fixture-pass-42@jira.example.com"], ["JIRA_HOST", "https://jira.example.com/rest?token=fixture-pass-42"],
      ["JIRA_HOST", "https://jira.example.com/browse/fixture"]
    ];
    for (const [name, value] of plain) expect(savedSecretIdentifierVariable(name, value)).toBe(true);
    for (const [name, value] of credentials) expect(savedSecretIdentifierVariable(name, value)).toBe(false);
    const entries = [...plain, ...credentials].map(([name, value]) => ({ name: name!, value: value! }));
    const saved = savedSecretScreenedValues([{ name: "Env", value: { entries, kind: "env" } }]);
    expect(saved).toEqual(credentials.map(([, value]) => value));
    expect(valueContainsSavedSecret("Log in as demo:fixture-pass-42 on cache.example.org:6379", saved)).toBe(true);
    expect(valueContainsSavedSecret("The cache is cache.example.org:6379, the tracker https://jira.example.com", saved)).toBe(false);
    // An address variable's origin takes a port of digits only.
    expect(savedSecretScreenedValues([{ name: "Jira", value: { entries: [
      { name: "JIRA_URL", value: "https://jira.example.com:8443" }, { name: "JIRA_URL", value: "https://jira.example.com:fixture-pass-42" }
    ], kind: "env" } }])).toEqual(["https://jira.example.com:fixture-pass-42"]);
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
