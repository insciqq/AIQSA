import { describe, expect, it } from "vitest";
import {
  MEMORY_UNPROCESSED_TEXT_PLACEHOLDER,
  memoryExplicitStatementContainsSecret,
  memoryProjectionContainsRedaction,
  memoryProjectionHasSourceText,
  memoryRedactionHasSourceText,
  memorySecretJoinIsSafe,
  parseMemorySecret,
  redactMemorySecrets,
  redactMemorySecretsInWindows,
  type MemorySecretWindowedRedactionResult
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

  it.each(["private", "future", "код", "未来", "avenir"])(
    "preserves safe source text without a semantic word filter (%#)", (value) => {
      expect(memoryRedactionHasSourceText(value)).toBe(true);
      expect(memoryProjectionHasSourceText(value)).toBe(true);
      expect(memoryProjectionContainsRedaction(value)).toBe(false);
    }
  );

  it.each(["key", "ключ", "鍵", "clé"])(
    "preserves safe labels without deciding their meaning (%#)", (label) => {
      const value = `${label}: sk-abcdefghijklmnopqrstuvwxyz123456`;
      const redaction = redactMemorySecrets(value);
      expect(redaction.redactedText).toBe(`${label}: [REDACTED:TOKEN]`);
      expect(memoryRedactionHasSourceText(value, redaction)).toBe(true);
      expect(memoryProjectionHasSourceText(redaction.redactedText)).toBe(true);
    }
  );

  it.each([
    "sk-abcdefghijklmnopqrstuvwxyz123456", "[REDACTED:TOKEN]",
    "[REDACTED_SECRET]", "[REDACTED:PRIVATE_KEY] [REDACTED:TOKEN]", " --- "
  ])("does not count removed values or markers as retained source (%#)", (value) => {
    const redaction = redactMemorySecrets(value);
    expect(memoryRedactionHasSourceText(value, redaction)).toBe(false);
    expect(memoryProjectionHasSourceText(redaction.redactedText)).toBe(false);
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

const WINDOW_SECRETS = [
  "sk-abcdefghijklmnopqrstuvwxyz123456",
  "AKIAIOSFODNN7EXAMPLE",
  "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.signature123456",
  "4111 1111 1111 1111",
  "4111-1111-1111-1111",
  "ABCD-EFGH-IJKL-MNOP",
  "postgresql://owner:private-password@db.example.test/app",
  "https://user:pässword@例え.jp/パス",
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----"
] as const;

const WINDOW_FRAGMENTS = [
  ...WINDOW_SECRETS,
  "-----BEGIN RSA PRIVATE KEY-----\nunterminated body",
  "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
  "opaqueBuildA1B2C3D4E5F6G7H8I9J0K1L2M3N4",
  "word", "Helsinki", "кофе", "東京都", "😀", "1234", "5", "x://", "-----BEGIN ",
  " ", " ", " ", "\n", "\n\n", ",", ";", "(", ")", "\"", "'", "-"
] as const;

function windowFixture(seed: number): string {
  let state = seed;
  const next = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  let value = "";
  const count = 1 + Math.floor(next() * 90);
  for (let index = 0; index < count; index += 1) {
    value += WINDOW_FRAGMENTS[Math.floor(next() * WINDOW_FRAGMENTS.length)];
  }
  return value;
}

/** One full pass, with each withheld range replaced by one marker. */
function expectedWindowedText(
  value: string,
  windowed: MemorySecretWindowedRedactionResult
): string {
  const full = redactMemorySecrets(value);
  let expected = "";
  const render = (from: number, to: number) => {
    let cursor = from;
    for (const span of full.spans) {
      if (span.end <= from || span.start >= to) continue;
      // A withheld range never starts or ends inside a full-pass secret.
      expect(span.start >= from && span.end <= to).toBe(true);
      expected += value.slice(cursor, span.start) + span.placeholder;
      cursor = span.end;
    }
    expected += value.slice(cursor, to);
  };
  let cursor = 0;
  for (const range of windowed.withheld) {
    render(cursor, range.start);
    expected += MEMORY_UNPROCESSED_TEXT_PLACEHOLDER;
    cursor = range.end;
  }
  render(cursor, value.length);
  return expected;
}

function expectExactSourceMap(
  value: string,
  windowed: MemorySecretWindowedRedactionResult
): void {
  let sourceCursor = 0;
  let outputCursor = 0;
  for (const entry of windowed.sourceMap) {
    expect(entry.sourceStart).toBe(sourceCursor);
    expect(entry.outputStart).toBe(outputCursor);
    if (entry.kind === "SOURCE") {
      expect(windowed.redactedText.slice(entry.outputStart, entry.outputEnd))
        .toBe(value.slice(entry.sourceStart, entry.sourceEnd));
    }
    sourceCursor = entry.sourceEnd;
    outputCursor = entry.outputEnd;
  }
  expect(sourceCursor).toBe(value.length);
  expect(outputCursor).toBe(windowed.redactedText.length);
}

describe("windowed Memory secret redaction", () => {
  it("equals one full pass for every scanned window and withholds the rest", () => {
    let comparedWithoutWithholding = 0;
    for (let seed = 1; seed <= 250; seed += 1) {
      const value = windowFixture(seed);
      const full = redactMemorySecrets(value);
      for (const windowCodeUnits of [32, 96, 160]) {
        const windowed = redactMemorySecretsInWindows(value, {
          maxCodeUnits: Number.POSITIVE_INFINITY,
          windowCodeUnits
        });
        expectExactSourceMap(value, windowed);
        expect(windowed.redactedText).toBe(expectedWindowedText(value, windowed));
        if (windowed.withheld.length === 0) {
          comparedWithoutWithholding += 1;
          expect(windowed.sourceMap).toEqual(full.sourceMap);
          expect(windowed.spans).toEqual(full.spans);
        }
      }
    }
    expect(comparedWithoutWithholding).toBeGreaterThan(100);
  });

  it.each(WINDOW_SECRETS)("keeps a secret whole across a window boundary (%#)", (secret) => {
    const value = `${"word ".repeat(25)}${secret} ${"tail words ".repeat(40)}`;
    const full = redactMemorySecrets(value);
    const windowed = redactMemorySecretsInWindows(value, {
      maxCodeUnits: Number.POSITIVE_INFINITY,
      windowCodeUnits: 128
    });

    expect(value.indexOf(secret)).toBeLessThan(128);
    expect(value.indexOf(secret) + secret.length).toBeGreaterThan(128);
    expect(full.redactedText).not.toContain(secret);
    expect(windowed.withheld).toEqual([]);
    expect(windowed.redactedText).toBe(full.redactedText);
    expect(windowed.sourceMap).toEqual(full.sourceMap);
    expect(windowed.containsSecret).toBe(true);
  });

  it("withholds what one bounded window cannot scan and continues after it", () => {
    const run = "Qx".repeat(100);
    const opaque = redactMemorySecretsInWindows(
      `before words\n${run} ${run}\nafter words`,
      { maxCodeUnits: Number.POSITIVE_INFINITY, windowCodeUnits: 64 }
    );
    expect(opaque.redactedText)
      .toBe(`before words\n${MEMORY_UNPROCESSED_TEXT_PLACEHOLDER}after words`);
    expect(opaque.withheld).toHaveLength(1);
    expect(opaque.containsSecret).toBe(false);

    const key = `-----BEGIN PRIVATE KEY-----\n${"MIIEvQIBADANBgkq\n".repeat(8)}` +
      "-----END PRIVATE KEY-----";
    const oversizedKey = redactMemorySecretsInWindows(`note:\n${key}\nafter`, {
      maxCodeUnits: Number.POSITIVE_INFINITY,
      windowCodeUnits: 64
    });
    expect(oversizedKey.redactedText).not.toContain("MIIEvQIBADANBgkq");
    expect(oversizedKey.redactedText).toContain(MEMORY_UNPROCESSED_TEXT_PLACEHOLDER);
    expect(oversizedKey.redactedText.endsWith("after")).toBe(true);

    const budgeted = redactMemorySecretsInWindows("word ".repeat(100), {
      maxCodeUnits: 128,
      windowCodeUnits: 64
    });
    expect(budgeted.redactedText.startsWith("word word")).toBe(true);
    expect(budgeted.redactedText.endsWith(MEMORY_UNPROCESSED_TEXT_PLACEHOLDER))
      .toBe(true);
    expect(budgeted.withheld).toEqual([
      { end: 500, start: expect.any(Number) }
    ]);
    expect(budgeted.withheld[0]!.start).toBeGreaterThanOrEqual(128);
  });

  it("scans Unicode text without ASCII delimiters and never splits a code point", () => {
    for (const value of [
      "東京都に住んでいます。毎朝コーヒーを飲みます。".repeat(20),
      `${"😀".repeat(150)} done`,
      `${"кофе".repeat(80)}😀${"a".repeat(20)}`
    ]) {
      const windowed = redactMemorySecretsInWindows(value, {
        maxCodeUnits: Number.POSITIVE_INFINITY,
        windowCodeUnits: 64
      });
      expect(windowed.withheld).toEqual([]);
      expect(windowed.redactedText).toBe(value);
      expectExactSourceMap(value, windowed);
    }
  });

  it("rejects window options that cannot bound the scan", () => {
    expect(() => redactMemorySecretsInWindows("text", {
      maxCodeUnits: 10,
      windowCodeUnits: 0
    })).toThrow("memory_secret_window_options_invalid");
    expect(() => redactMemorySecretsInWindows("text", {
      maxCodeUnits: 5,
      windowCodeUnits: 10
    })).toThrow("memory_secret_window_options_invalid");
  });

  it("scans the join of two redacted texts instead of their combined length", () => {
    expect(memorySecretJoinIsSafe(
      "ordinary ".repeat(20_000),
      "\n\n",
      "reply ".repeat(20_000)
    )).toBe(true);
    // The BEGIN label only completes across the join, so neither side alone
    // redacts the key body.
    const left = "see -----BEGIN ";
    const right = "RSA PRIVATE KEY-----\nkey-body\n-----END RSA PRIVATE KEY-----";
    expect(redactMemorySecrets(right).redactedText).toContain("key-body");
    expect(memorySecretJoinIsSafe(left, "\n\n", right)).toBe(false);
    expect(() => memorySecretJoinIsSafe("a", " ", "b"))
      .toThrow("memory_secret_join_separator_invalid");
    expect(() => memorySecretJoinIsSafe("a", "", "b"))
      .toThrow("memory_secret_join_separator_invalid");
  });
});
