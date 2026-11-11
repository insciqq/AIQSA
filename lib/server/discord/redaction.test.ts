import { describe, expect, it } from "vitest";
import { containsOutgoingSecret, isSecretKeyName, redactOutgoing } from "./redaction";

// Synthetic values only; none is a real credential.
const OPENAI_STYLE = "sk-abcdefghijklmnopqrstuvwxyz123456";
const GITHUB_STYLE = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const AWS_STYLE = "AKIAABCDEFGHIJKLMNOP";
const JWT = [
  Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url"),
  Buffer.from('{"sub":"1234567890"}').toString("base64url"),
  "c2lnbmF0dXJlLXZhbHVlLXN5bnRoZXRpYw"
].join(".");
const ENTROPY = "Zx8Qm2Lp7Rt4Vw9Ny3Kb6Hd1Fg5Jc0Sa";

describe("redactOutgoing", () => {
  it("removes the Memory parser's redacting classes", () => {
    const text = [
      `key ${OPENAI_STYLE}`, `gh ${GITHUB_STYLE}`, `aws ${AWS_STYLE}`, `jwt ${JWT}`,
      "db postgres://app:hunter2@db.example.com:5432/app",
      "-----BEGIN PRIVATE KEY-----\nMIIBVwIBADANBgkqhkiG9w0BAQEFAASCAT\n-----END PRIVATE KEY-----"
    ].join("\n");
    expect(redactOutgoing(text)).toEqual({
      text: "key [redacted]\ngh [redacted]\naws [redacted]\njwt [redacted]\ndb [redacted]\n[redacted]",
      count: 6
    });
  });

  it("removes values of secret-named keys in env, YAML, JSON and header style", () => {
    const cases: Array<[string, string]> = [
      ["DB_PASSWORD=hunter2 PORT=5432", "DB_PASSWORD=[redacted] PORT=5432"],
      ['export API_KEY="two words"', 'export API_KEY="[redacted]"'],
      ["  password: correct horse battery", "  password: [redacted]"],
      ["- client_secret: abc", "- client_secret: [redacted]"],
      ['{"accessKey": "abc", "region": "eu"}', '{"accessKey": "[redacted]", "region": "eu"}'],
      ["https://example.com/cb?api_key=abc123&page=2", "https://example.com/cb?api_key=[redacted]&page=2"],
      ["Authorization: Bearer abc.def.123", "Authorization: [redacted]"],
      ["curl -H 'X: Bearer abcdef1234567890xyz'", "curl -H 'X: Bearer [redacted]'"],
      [`checksum=${ENTROPY}`, "checksum=[redacted]"],
      ['config: "' + ENTROPY + '"', 'config: "[redacted]"']
    ];
    for (const [input, output] of cases) expect(redactOutgoing(input).text).toBe(output);
  });

  it("removes a Kubernetes env value named as a secret", () => {
    const yaml = "env:\n  - name: DB_PASSWORD\n    value: hunter2\n  - name: LOG_LEVEL\n    value: debug";
    expect(redactOutgoing(yaml)).toEqual({
      text: "env:\n  - name: DB_PASSWORD\n    value: [redacted]\n  - name: LOG_LEVEL\n    value: debug",
      count: 1
    });
    const json = '[{"name":"SESSION_SECRET","value":"s3cr3t"},{"name":"MODE","value":"prod"}]';
    expect(redactOutgoing(json).text).toBe('[{"name":"SESSION_SECRET","value":"[redacted]"},{"name":"MODE","value":"prod"}]');
  });

  it("keeps ordinary text, references and placeholders", () => {
    const text = [
      "The password is required and the token expires hourly.",
      "MAX_TOKENS=4096 TIMEOUT=30",
      "PASSWORD=${DB_PASSWORD} SECRET=<your secret> TOKEN=*** API_KEY=",
      "token: none",
      "Basic authentication and Bearer tokens",
      "id 123e4567-e89b-12d3-a456-426614174000",
      "See https://example.com/docs?page=2"
    ].join("\n");
    expect(redactOutgoing(text)).toEqual({ text, count: 0 });
    expect(redactOutgoing("")).toEqual({ text: "", count: 0 });
  });

  it("merges overlapping findings into one replacement", () => {
    expect(redactOutgoing(`OPENAI_API_KEY=${OPENAI_STYLE}`)).toEqual({ text: "OPENAI_API_KEY=[redacted]", count: 1 });
  });

  it("names secret keys by their word parts", () => {
    for (const key of ["DB_PASSWORD", "dbPassword", "api-key", "GITHUB_TOKEN", "aws.secretAccessKey", "SIGNING_KEY", "pwd"]) {
      expect(isSecretKeyName(key)).toBe(true);
    }
    for (const key of ["MAX_TOKENS", "PASSAGE", "KEYBOARD", "monkey", "PORT", "AUTHOR"]) {
      expect(isSecretKeyName(key)).toBe(false);
    }
  });

  it("stays linear on long hostile input", () => {
    const hostile = `${"A=".repeat(50_000)}${"password: ".repeat(10_000)}${"Bearer ".repeat(10_000)}`;
    const started = performance.now();
    redactOutgoing(hostile);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("flags addresses that carry a recognized secret", () => {
    expect(containsOutgoingSecret("https://example.com/a?b=c")).toBe(false);
    expect(containsOutgoingSecret("https://user:pass@example.com/")).toBe(true);
    expect(containsOutgoingSecret(`https://example.com/?t=${GITHUB_STYLE}`)).toBe(true);
  });
});
