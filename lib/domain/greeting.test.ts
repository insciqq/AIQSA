import { describe, expect, it } from "vitest";
import {
  FALLBACK_GREETING,
  greetingFirstName,
  greetingPeriodAt,
  greetingPeriodInTimeZone,
  greetingText,
  isGreetingTimeZone
} from "./greeting";

describe("blank chat greeting", () => {
  it("splits the day into morning, afternoon and evening without a farewell", () => {
    expect([4, 5, 11, 12, 17, 18, 23, 0].map(greetingPeriodAt)).toEqual([
      "evening", "morning", "morning", "afternoon", "afternoon", "evening", "evening", "evening"
    ]);
  });

  it("reads the hour in the browser's zone and rejects unknown or malformed zones", () => {
    const at = new Date("2026-10-20T06:30:00Z");
    expect(greetingPeriodInTimeZone("Europe/Moscow", at)).toBe("morning");
    expect(greetingPeriodInTimeZone("America/Los_Angeles", at)).toBe("evening");
    expect(greetingPeriodInTimeZone("Asia/Kolkata", at)).toBe("afternoon");
    expect(greetingPeriodInTimeZone("Mars/Olympus", at)).toBeNull();
    expect(greetingPeriodInTimeZone("Europe/Moscow; path=/", at)).toBeNull();
    expect(greetingPeriodInTimeZone(undefined, at)).toBeNull();
    expect(isGreetingTimeZone("x".repeat(65))).toBe(false);
  });

  it("greets by first name and keeps the question without a usable name or period", () => {
    expect(greetingFirstName("  Дмитрий Тульнов ")).toBe("Дмитрий");
    expect(greetingFirstName("sam@example.com")).toBeNull();
    expect(greetingText("morning", "Дмитрий Тульнов")).toBe("Good morning, Дмитрий");
    expect(greetingText("evening", "")).toBe(FALLBACK_GREETING);
    expect(greetingText(null, "Дмитрий")).toBe(FALLBACK_GREETING);
  });
});
