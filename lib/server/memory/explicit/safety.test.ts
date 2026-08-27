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
    )).toEqual({ containsSecret: false, findings: [], spans: [] });
    expect(parseMemorySecret(
      "Source chunk 9c24a000-9bd2-41b9-96ff-a9369526af5c"
    )).toEqual({ containsSecret: false, findings: [], spans: [] });
    expect(parseMemorySecret(
      "652ca28b-7ac4-4078-97cd-9b48066e7cb9-secret123"
    ).findings).toContain("HIGH_ENTROPY_TOKEN");
  });

  it.each([
    "API key: sk-abcdefghijklmnopqrstuvwxyz123456",
    "api_key=sk-abcdefghijklmnopqrstuvwxyz123456",
    "AWS access key AKIAIOSFODNN7EXAMPLE",
    "GitHub token ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    "postgresql://owner:private-password@db.example.test/app",
    "database_url=postgresql://owner:private-password@db.example.test/app",
    "-----BEGIN PRIVATE KEY----- abc -----END PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.signature123456",
    "jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.signature123456",
    "Card 4111 1111 1111 1111",
    "Recovery: ABCD-EFGH-IJKL-MNOP"
  ])("rejects credential-like plaintext without returning it (%#)", (statement) => {
    expect(memoryExplicitStatementContainsSecret(statement)).toBe(true);
  });

  it("reports structural findings without treating semantic labels as secrets", () => {
    expect(parseMemorySecret("My password is hunter2-secret")).toEqual({
      containsSecret: false,
      findings: [],
      spans: []
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
        "Я переехал в Хельсинки, мой API token [REDACTED:TOKEN]; найди мой адрес."
    });
    expect(result.findings).toContain("KNOWN_TOKEN");
    expect(result.redactedText).not.toContain(token);
    expect(result.spans.some((span) => input.slice(span.start, span.end) === token))
      .toBe(true);
  });

  it.each([
    ["URL", "postgresql://owner:private-password@db.example.test/app",
      "[REDACTED:CREDENTIAL_URL]"],
    ["card", "4111 1111 1111 1111", "[REDACTED:PAYMENT_CARD]"],
    ["recovery", "ABCD-EFGH-IJKL-MNOP", "[REDACTED:RECOVERY_CODE]"],
    [
      "PEM",
      "-----BEGIN PRIVATE KEY-----\nprivate-body-1234567890\n-----END PRIVATE KEY-----",
      "[REDACTED:PRIVATE_KEY]"
    ]
  ])("redacts a %s candidate without removing adjacent prose", (
    _kind,
    secret,
    placeholder
  ) => {
    const result = redactMemorySecrets(`before ${secret} after`);
    expect(result.redactedText).toBe(`before ${placeholder} after`);
    expect(result.redactedText).not.toContain(secret);
  });

  it("fails closed over an unterminated single-line private key", () => {
    const key = "-----BEGIN PRIVATE KEY----- private-body-without-end";
    const result = redactMemorySecrets(`before ${key}`);

    expect(result.redactedText).toBe("before [REDACTED:PRIVATE_KEY]");
    expect(result.redactedText).not.toContain("private-body-without-end");
  });

  it("returns typed spans and an exact source map for retained text", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const input = `before ${token} after`;
    const result = redactMemorySecrets(input);

    expect(result.spans).toEqual([expect.objectContaining({
      action: "REDACT",
      confidence: "HIGH",
      detectorClass: "KNOWN_FORMAT",
      end: 7 + token.length,
      finding: "KNOWN_TOKEN",
      placeholder: "[REDACTED:TOKEN]",
      start: 7
    })]);
    expect(result.sourceMap).toEqual([
      {
        kind: "SOURCE",
        outputEnd: 7,
        outputStart: 0,
        sourceEnd: 7,
        sourceStart: 0
      },
      expect.objectContaining({
        kind: "REDACTION",
        sourceEnd: 7 + token.length,
        sourceStart: 7
      }),
      expect.objectContaining({
        kind: "SOURCE",
        sourceEnd: input.length,
        sourceStart: 7 + token.length
      })
    ]);
  });

  it("normalizes overlapping detections longest-first", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.signature123456";
    const result = redactMemorySecrets(`JWT ${jwt} remains described`);

    expect(result.detections.map(({ finding }) => finding)).toContain("JSON_WEB_TOKEN");
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({
      finding: "JSON_WEB_TOKEN",
      placeholder: "[REDACTED:JWT]"
    });
    expect(result.redactedText).toBe("JWT [REDACTED:JWT] remains described");
  });

  it("keeps generic high entropy audit-only", () => {
    const opaque = "opaqueBuildA1B2C3D4E5F6G7H8I9J0K1L2M3N4";
    const parsed = parseMemorySecret(opaque);
    const redacted = redactMemorySecrets(opaque);

    expect(parsed).toMatchObject({ containsSecret: false });
    expect(parsed.spans).toEqual([expect.objectContaining({
      action: "AUDIT_ONLY",
      confidence: "LOW",
      detectorClass: "HEURISTIC_ENTROPY",
      finding: "HIGH_ENTROPY_TOKEN"
    })]);
    expect(redacted.redactedText).toBe(opaque);
    expect(redacted.spans).toEqual([]);
  });
});
