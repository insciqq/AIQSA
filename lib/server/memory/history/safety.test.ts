import { describe, expect, it } from "vitest";
import { projectMemoryHistorySafeText } from "./safety";

describe("Memory history safety projection", () => {
  it("excludes recognizable credential formats without echoing them", () => {
    for (const value of [
      "api key: sk-exampleToken1234567890",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.signature123456"
    ]) {
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
});
