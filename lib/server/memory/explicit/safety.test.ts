import { describe, expect, it } from "vitest";
import {
  memoryExplicitStatementContainsSecret,
  parseMemorySecret,
  redactMemorySecrets
} from "./safety";

describe("explicit Memory secret screening", () => {
  it("accepts ordinary Russian and English saved-memory statements", () => {
    expect(memoryExplicitStatementContainsSecret(
      "Я предпочитаю ответы о ёлках на русском языке."
    )).toBe(false);
    expect(memoryExplicitStatementContainsSecret(
      "For work trips, I prefer hotels near a metro station."
    )).toBe(false);
    expect(memoryExplicitStatementContainsSecret(
      "Search my history for large recovery evidence."
    )).toBe(false);
    expect(memoryExplicitStatementContainsSecret("My password is hunter2-secret")).toBe(false);
    expect(memoryExplicitStatementContainsSecret("Мой пароль: hunter2-secret")).toBe(false);
    expect(memoryExplicitStatementContainsSecret("API-ключ: example-secret-value")).toBe(false);
    expect(memoryExplicitStatementContainsSecret("The user said they were ready.")).toBe(false);
  });

  it("does not classify canonical UUID identifiers as high-entropy credentials", () => {
    expect(parseMemorySecret(
      "Source chat 652ca28b-7ac4-4078-97cd-9b48066e7cb9"
    )).toEqual({ containsSecret: false, findings: [] });
    expect(parseMemorySecret(
      "Source chunk 9c24a000-9bd2-41b9-96ff-a9369526af5c"
    )).toEqual({ containsSecret: false, findings: [] });
    expect(parseMemorySecret(
      "652ca28b-7ac4-4078-97cd-9b48066e7cb9-secret123"
    ).findings).toContain("HIGH_ENTROPY_TOKEN");
  });

  it.each([
    "API key: sk-abcdefghijklmnopqrstuvwxyz123456",
    "postgresql://owner:private-password@db.example.test/app",
    "-----BEGIN PRIVATE KEY----- abc -----END PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.signature123456",
    "Card 4111 1111 1111 1111",
    "Recovery: ABCD-EFGH-IJKL-MNOP"
  ])("rejects credential-like plaintext without returning it (%#)", (statement) => {
    expect(memoryExplicitStatementContainsSecret(statement)).toBe(true);
  });

  it("reports structural findings without treating semantic labels as secrets", () => {
    expect(parseMemorySecret("My password is hunter2-secret")).toEqual({
      containsSecret: false,
      findings: []
    });
    expect(parseMemorySecret("-----BEGIN PRIVATE KEY-----")).toMatchObject({
      containsSecret: true,
      findings: ["PEM_PRIVATE_KEY"]
    });
    expect(parseMemorySecret("postgresql://owner:private-password@db.example.test/app"))
      .toMatchObject({ containsSecret: true, findings: ["CREDENTIAL_URL"] });
  });

  it("does not require a language or keyword fallback for recovery and card formats", () => {
    expect(parseMemorySecret("ABCD-EFGH-IJKL-MNOP").findings)
      .toContain("RECOVERY_CODE");
    expect(parseMemorySecret("abcd-efgh-ijkl-mnop").findings)
      .toContain("RECOVERY_CODE");
    expect(parseMemorySecret("4111 1111 1111 1111").findings)
      .toContain("PAYMENT_CARD");
  });

  it("redacts exact secret spans while preserving every safe surrounding character", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const input = `Я переехал в Хельсинки, мой API token ${token}; найди мой адрес.`;
    const result = redactMemorySecrets(input);

    expect(result).toMatchObject({
      containsSecret: true,
      redactedText:
        "Я переехал в Хельсинки, мой API token [REDACTED_SECRET]; найди мой адрес."
    });
    expect(result.findings).toContain("KNOWN_TOKEN");
    expect(result.redactedText).not.toContain(token);
    expect(result.spans.some((span) => input.slice(span.start, span.end) === token))
      .toBe(true);
  });

  it.each([
    ["URL", "postgresql://owner:private-password@db.example.test/app"],
    ["card", "4111 1111 1111 1111"],
    ["recovery", "ABCD-EFGH-IJKL-MNOP"],
    [
      "PEM",
      "-----BEGIN PRIVATE KEY-----\nprivate-body-1234567890\n-----END PRIVATE KEY-----"
    ]
  ])("redacts a %s candidate without removing adjacent prose", (_kind, secret) => {
    const result = redactMemorySecrets(`before ${secret} after`);
    expect(result.redactedText).toBe("before [REDACTED_SECRET] after");
    expect(result.redactedText).not.toContain(secret);
  });

  it("fails closed over an unterminated single-line private key", () => {
    const key = "-----BEGIN PRIVATE KEY----- private-body-without-end";
    const result = redactMemorySecrets(`before ${key}`);

    expect(result.redactedText).toBe("before [REDACTED_SECRET]");
    expect(result.redactedText).not.toContain("private-body-without-end");
  });
});
