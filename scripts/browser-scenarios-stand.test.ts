import { types as pgTypes } from "pg";
import { describe, expect, it } from "vitest";
import { STAND_DATABASE_TYPES, TIMESTAMP_WITHOUT_TIME_ZONE_OID, parseUtcTimestamp } from "./browser-scenarios-stand";

describe("stand database timestamps", () => {
  it("reads Prisma's timestamp without time zone as UTC whatever the host's zone", () => {
    expect(parseUtcTimestamp("2026-10-30 07:00:00.123").toISOString()).toBe("2026-10-30T07:00:00.123Z");
    expect(parseUtcTimestamp("2026-10-30 07:00:00").toISOString()).toBe("2026-10-30T07:00:00.000Z");
    expect(parseUtcTimestamp("2026-10-30 23:59:59.999999").getTime()).toBe(Date.UTC(2026, 9, 30, 23, 59, 59, 999));
    // node-pg's own parser reads the same text in the host's zone: off by its offset outside UTC (run with TZ=Europe/Istanbul).
    const local = (pgTypes.getTypeParser(TIMESTAMP_WITHOUT_TIME_ZONE_OID, "text") as (value: string) => Date)("2026-10-30 07:00:00.123");
    expect(local.getTime() - Date.UTC(2026, 9, 30, 7, 0, 0, 123)).toBe(local.getTimezoneOffset() * 60_000);
  });

  it("parses timestamp columns through the client's own types and leaves other types to node-pg", () => {
    const timestamp = STAND_DATABASE_TYPES.getTypeParser(TIMESTAMP_WITHOUT_TIME_ZONE_OID, "text") as (value: string) => Date;
    expect(timestamp("2026-10-30 07:00:00.123").toISOString()).toBe("2026-10-30T07:00:00.123Z");
    const integer = STAND_DATABASE_TYPES.getTypeParser(23, "text") as (value: string) => unknown;
    expect(integer("42")).toBe(42);
    expect(parseUtcTimestamp("infinity")).toBe(Infinity);
  });
});
