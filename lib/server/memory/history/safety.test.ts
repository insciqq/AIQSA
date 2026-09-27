import { describe, expect, it } from "vitest";
import { MEMORY_UNPROCESSED_TEXT_PLACEHOLDER } from "../explicit/safety";
import {
  MEMORY_HISTORY_UNPROCESSED_TEXT_REASON,
  memoryHistoryProjectedTextIsStable,
  memoryHistorySafeTextsJoinSafely,
  projectMemoryHistorySafeText,
  projectMemoryHistorySourceText
} from "./safety";

describe("Memory history safety projection", () => {
  it("excludes recognizable credential formats without echoing them", () => {
    for (const value of [
      "sk-exampleToken1234567890",
      "[REDACTED:TOKEN]",
      "[REDACTED_SECRET]",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.signature123456"
    ]) {
      const projection = projectMemoryHistorySafeText(value);

      expect(projection).toMatchObject({
        eligible: false,
        providerSafeText: null,
        redactionReasonCodes: ["SECRET_ONLY"],
        redactionState: "EXCLUDED",
        safetyClass: "SECRET_TAINTED",
        safeText: null
      });
      expect(JSON.stringify(projection)).not.toContain(value);
    }
  });

  it("retains every meaningful character around a recognized secret", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const projection = projectMemoryHistorySafeText(
      `I moved to Helsinki; token ${token}; ask about my new city.`
    );

    expect(projection).toMatchObject({
      eligible: true,
      redactionReasonCodes: ["SECRET_REDACTED_KNOWN_TOKEN"],
      redactionState: "REDACTED",
      safeText:
        "I moved to Helsinki; token [REDACTED:TOKEN]; ask about my new city.",
      safetyClass: "NORMAL"
    });
    expect(projection.redactionSourceMap).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "REDACTION" }),
      expect.objectContaining({ kind: "SOURCE", sourceStart: 0 })
    ]));
  });

  it.each(["key", "ключ", "鍵", "clé"])(
    "retains safe surrounding text as history without inferring a fact (%#)", (label) => {
      const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
      expect(projectMemoryHistorySafeText(`${label}: ${token}`)).toMatchObject({
        eligible: true,
        providerSafeText: `${label}: [REDACTED:TOKEN]`,
        safeText: `${label}: [REDACTED:TOKEN]`
      });
    }
  );

  it("does not classify natural-language secret or sensitivity labels", () => {
    for (const value of [
      "пароль: Qwerty123456!",
      "diagnosis: chronic condition",
      "номер паспорта: 1234 567890"
    ]) {
      expect(projectMemoryHistorySafeText(value)).toMatchObject({
        eligible: true,
        redactionReasonCodes: [],
        safetyClass: "NORMAL"
      });
    }
  });

  it("leaves semantic contact classification to the System Model", () => {
    const text =
      "Я не согласен 10.08.2026. Пишите me@example.com или +7 (999) 123-45-67.";
    const projection = projectMemoryHistorySafeText(
      text
    );

    expect(projection).toMatchObject({
      eligible: true,
      providerSafeText: text,
      redactionReasonCodes: [],
      redactionState: "NOT_NEEDED",
      safetyClass: "NORMAL",
      safeText: text
    });
  });

  it("normalizes line endings deterministically and rejects unsafe controls", () => {
    expect(projectMemoryHistorySafeText("First\r\nSecond\rThird")).toMatchObject({
      eligible: true,
      safeText: "First\nSecond\nThird"
    });
    expect(projectMemoryHistorySafeText("visible\u202Ehidden")).toMatchObject({
      eligible: false,
      redactionReasonCodes: ["UNSAFE_CONTROL"]
    });
  });

  it("reports structural exclusions as processing states without a sensitivity class", () => {
    for (const project of [projectMemoryHistorySafeText, projectMemoryHistorySourceText]) {
      expect(project("  \n ")).toMatchObject({
        eligible: false,
        processingState: "EMPTY",
        redactionReasonCodes: ["EMPTY_TEXT"],
        safetyClass: null
      });
      expect(project("visible\u2067hidden")).toMatchObject({
        eligible: false,
        processingState: "UNSAFE_CONTROL",
        redactionReasonCodes: ["UNSAFE_CONTROL"],
        safetyClass: null
      });
    }
  });
});

describe("Memory message source projection", () => {
  const ordinary = "I moved to Helsinki last spring and work at the harbour. ";

  it("never classifies long ordinary text by its length", () => {
    const text = ordinary.repeat(4_000).trim();
    expect(text.length).toBeGreaterThan(200_000);

    expect(projectMemoryHistorySafeText(text)).toMatchObject({
      eligible: false,
      processingState: "OVERSIZE",
      redactionReasonCodes: ["SOURCE_TEXT_LIMIT"],
      safetyClass: null,
      safeText: null
    });
    expect(projectMemoryHistorySourceText(text)).toMatchObject({
      eligible: true,
      processingState: "COMPLETE",
      redactionReasonCodes: [],
      redactionState: "NOT_NEEDED",
      safetyClass: "NORMAL",
      safeText: text
    });
  });

  it("is the single pass for texts up to one window", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const text = `${ordinary.repeat(1_700)}token ${token} end`;
    expect(text.length).toBeLessThanOrEqual(100_000);

    expect(projectMemoryHistorySourceText(text)).toEqual(projectMemoryHistorySafeText(text));
  });

  it.each([
    "sk-abcdefghijklmnopqrstuvwxyz123456",
    "4111 1111 1111 1111",
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0\n-----END PRIVATE KEY-----"
  ])("redacts a secret that crosses the 100k window boundary (%#)", (secret) => {
    const prefix = "a word ".repeat(14_285);
    const text = `${prefix}${secret} ${ordinary.repeat(1_000)}`.trim();
    const start = text.indexOf(secret);
    expect(start).toBeLessThan(100_000);
    expect(start + secret.length).toBeGreaterThan(100_000);

    const projection = projectMemoryHistorySourceText(text);

    expect(projection).toMatchObject({
      eligible: true,
      processingState: "COMPLETE",
      redactionState: "REDACTED",
      safetyClass: "NORMAL"
    });
    expect(projection.safeText).not.toContain(secret);
    expect(projection.redactionSourceMap).toContainEqual(expect.objectContaining({
      kind: "REDACTION",
      sourceEnd: start + secret.length,
      sourceStart: start
    }));
    expect(JSON.stringify(projection)).not.toContain(secret);
  });

  it("withholds text it cannot scan within bounds instead of passing it on", () => {
    const blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo".repeat(4_000);
    const withBlob = projectMemoryHistorySourceText(
      `My photo is below.\n${blob}\nI moved to Rome.`
    );
    expect(withBlob).toMatchObject({
      eligible: true,
      processingState: "PARTIAL",
      redactionReasonCodes: [MEMORY_HISTORY_UNPROCESSED_TEXT_REASON],
      redactionState: "REDACTED",
      safetyClass: "NORMAL",
      safeText: `My photo is below.\n${MEMORY_UNPROCESSED_TEXT_PLACEHOLDER}I moved to Rome.`
    });

    const onlyBlob = projectMemoryHistorySourceText(blob);
    expect(onlyBlob).toMatchObject({
      eligible: false,
      processingState: "OVERSIZE",
      redactionReasonCodes: ["SOURCE_TEXT_LIMIT"],
      safetyClass: null
    });

    const longText = ordinary.repeat(20_000).trim();
    expect(longText.length).toBeGreaterThan(1_048_576);
    const partial = projectMemoryHistorySourceText(longText);
    expect(partial).toMatchObject({
      eligible: true,
      processingState: "PARTIAL",
      redactionReasonCodes: [MEMORY_HISTORY_UNPROCESSED_TEXT_REASON]
    });
    expect(partial.safeText?.endsWith(MEMORY_UNPROCESSED_TEXT_PLACEHOLDER)).toBe(true);
    expect(partial.redactionSourceMap.at(-1)).toMatchObject({
      kind: "REDACTION",
      sourceEnd: longText.length
    });
  });

  it("revalidates a projected text and its joins without a length gate", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const projected = projectMemoryHistorySourceText(
      `${ordinary.repeat(3_000)}token ${token}`
    );
    expect(projected.eligible).toBe(true);
    expect(memoryHistoryProjectedTextIsStable(projected.safeText!)).toBe(true);
    expect(memoryHistoryProjectedTextIsStable(`raw ${token}`)).toBe(false);
    expect(memoryHistorySafeTextsJoinSafely(projected.safeText!, projected.safeText!))
      .toBe(true);
  });
});
