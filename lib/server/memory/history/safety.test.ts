import { describe, expect, it } from "vitest";
import {
  MEMORY_HISTORY_REDACTION_MARKER,
  projectMemoryHistorySafeText
} from "./safety";

describe("Memory history safety projection", () => {
  it("excludes secret-like English and Russian source text without echoing it", () => {
    const englishSecret = "api key: sk-exampleToken1234567890";
    const russianSecret = "пароль: Qwerty123456!";

    for (const value of [englishSecret, russianSecret]) {
      const projection = projectMemoryHistorySafeText(value);

      expect(projection).toMatchObject({
        eligible: false,
        providerSafeText: null,
        redactionReasonCodes: ["SECRET_PATTERN"],
        redactionState: "EXCLUDED",
        safetyClass: "SECRET_TAINTED",
        safeText: null
      });
      expect(JSON.stringify(projection)).not.toContain(value.split(": ")[1]);
    }
  });

  it("redacts contact details while preserving Russian negation and dates", () => {
    const projection = projectMemoryHistorySafeText(
      "Я не согласен 10.08.2026. Пишите me@example.com или +7 (999) 123-45-67."
    );

    expect(projection).toMatchObject({
      eligible: true,
      redactionReasonCodes: ["CONTACT_EMAIL_REDACTED", "CONTACT_PHONE_REDACTED"],
      redactionState: "REDACTED",
      safetyClass: "SENSITIVE"
    });
    if (!projection.eligible) throw new Error("expected eligible redacted projection");
    expect(projection.safeText).toContain("Я не согласен 10.08.2026.");
    expect(projection.safeText.match(new RegExp(MEMORY_HISTORY_REDACTION_MARKER, "gu")))
      .toHaveLength(2);
    expect(projection.safeText).not.toContain("me@example.com");
    expect(projection.safeText).not.toContain("123-45-67");
    expect(projection.providerSafeText).toBe(projection.safeText);
  });

  it("excludes highly sensitive identity and health assignments", () => {
    expect(projectMemoryHistorySafeText("diagnosis: chronic condition")).toMatchObject({
      eligible: false,
      redactionReasonCodes: ["HIGHLY_SENSITIVE_IDENTITY_OR_HEALTH"],
      safetyClass: "HIGHLY_SENSITIVE"
    });
    expect(projectMemoryHistorySafeText("номер паспорта: 1234 567890")).toMatchObject({
      eligible: false,
      redactionReasonCodes: ["HIGHLY_SENSITIVE_IDENTITY_OR_HEALTH"],
      safetyClass: "HIGHLY_SENSITIVE"
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
});
