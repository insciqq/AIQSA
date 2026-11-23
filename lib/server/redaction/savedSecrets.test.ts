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
    // A value rewrapped across lines or spaces still counts, as screening matches it; a value of only whitespace never does.
    expect(valueContainsSavedSecret({ note: "Vault: correct horse\nbattery  staple" }, ["correct horse battery staple"])).toBe(true);
    expect(valueContainsSavedSecret({ "account=demo pass=fixture-pass-42": 1 }, saved)).toBe(true);
    expect(valueContainsSavedSecret("correct horse, battery staple", ["correct horse battery staple"])).toBe(false);
    expect(valueContainsSavedSecret("any text", [" \n\t"])).toBe(false);
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

  it("never exempts a value that reads as a credential, whatever its variable is called", () => {
    const hex40 = "0123456789abcdef0123456789abcdef01234567";
    const tokens = [
      // A code-quality server's login holds a user token; a code host's personal token under a login name.
      ["SONAR_LOGIN", `squ_${hex40}`], ["GIT_LOGIN", "ghp_abcdefghijklmnopqrstuvwxyz1234567890"],
      // Flagged by the recognized-secret detector.
      ["CLOUD_USER", "AKIAABCDEFGHIJKLMNOP"], ["API_LOGIN", "sk-abcdefghijklmnopqrstuvwxyz123456"],
      // A word of 20 or more characters mixing letters and digits, alone, as a host label or as an email's local part.
      ["SERVICE_USER", "a1b2c3d4e5f6g7h8i9j0"], ["DB_HOST", "k8s2f9q7x3m1v6b4n0z5.example.org"],
      ["JIRA_EMAIL", "a1b2c3d4e5f6g7h8i9j0@example.com"],
      // 32 or more characters of a token alphabet: hex, base64url with no digit, a UUID.
      ["DEPLOY_USER", hex40.slice(0, 32)], ["DEPLOY_USER", "abcdefghijklmnopqrstuvwxyzABCDEF_-"],
      ["TENANT_ACCOUNT", "0f8fad5b-d9cb-469f-a165-70867728950e"],
      // A known prefix with a short tail, and one after a separator.
      ["CHAT_USER", "xoxb-12345678"], ["CI_LOGIN", "bot.glpat-abcdefgh"]
    ];
    for (const [name, value] of tokens) expect(savedSecretIdentifierVariable(name, value), `${name}=${value}`).toBe(false);
    const ordinary = [
      ["SERVICE_LOGIN", "admin"], ["SERVICE_LOGIN", "deploy-bot"], ["SAUCEDEMO_USERNAME", "standard_user"],
      ["JIRA_EMAIL", "ivan.petrov+alerts@example.com"], ["DB_HOST", "ip-172-31-23-45.eu-central-1.compute.internal"],
      ["DB_HOST", "mydb-instance-1.c9akciq32.eu-central-1.rds.example.com"], ["AWS_REGION", "ap-southeast-2"],
      ["DB_PORT", "5432"], ["DB_HOST", "10.0.0.5"], ["JIRA_HOST", "https://jira.example.com:8443/"],
      ["AWS_ACCOUNT", "123456789012"], ["DESK_USER", "bask-keyboard-team"], ["GCP_PROJECT", "analytics-prod-2026"]
    ];
    for (const [name, value] of ordinary) expect(savedSecretIdentifierVariable(name, value), `${name}=${value}`).toBe(true);
    const saved = savedSecretScreenedValues([{ name: "Code quality", value: { entries: [
      { name: "SONAR_HOST", value: "https://sonar.example.com" }, { name: "SONAR_LOGIN", value: `squ_${hex40}` },
      { name: "TRACKER_URL", value: `https://${hex40}.example.com` }
    ], kind: "env" } }]);
    expect(saved).toEqual([`squ_${hex40}`, `https://${hex40}.example.com`]);
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
