import { describe, expect, it } from "vitest";
import { memoryExplicitStatementContainsSecret } from "./safety";

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
});
