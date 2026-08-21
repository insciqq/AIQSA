import { describe, expect, it } from "vitest";
import {
  memoryExplicitStatementContainsSecret,
  parseMemorySecret
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
    expect(parseMemorySecret("4111 1111 1111 1111").findings)
      .toContain("PAYMENT_CARD");
  });
});
