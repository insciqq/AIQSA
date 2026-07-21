import { describe, expect, it } from "vitest";
import {
  serializeAdminDate,
  serializeAdminMemberships
} from "./adminSerializationPrimitives";

describe("admin serialization primitives", () => {
  it("serializes dates to UTC while preserving nullish values", () => {
    expect(serializeAdminDate(new Date("2026-07-12T08:30:00.000Z"))).toBe(
      "2026-07-12T08:30:00.000Z"
    );
    expect(serializeAdminDate("2026-07-12T11:30:00.000+03:00")).toBe(
      "2026-07-12T08:30:00.000Z"
    );
    expect(serializeAdminDate(null)).toBeNull();
    expect(serializeAdminDate(undefined)).toBeNull();
  });

  it("resolves embedded and fallback group names, elides missing groups, and preserves order", () => {
    const groupNamesById = new Map([
      ["embedded", { name: "Fallback must not replace embedded" }],
      ["fallback", { name: "Fallback group" }]
    ]);

    expect(
      serializeAdminMemberships(
        [
          {
            group: { name: "Embedded group" },
            groupId: "embedded",
            role: "owner"
          },
          {
            group: null,
            groupId: "fallback",
            role: "member"
          },
          {
            groupId: "missing",
            role: "member"
          },
          {
            group: { name: "Last group" },
            groupId: "last",
            role: "reviewer"
          }
        ],
        groupNamesById
      )
    ).toEqual([
      {
        groupId: "embedded",
        name: "Embedded group",
        role: "owner"
      },
      {
        groupId: "fallback",
        name: "Fallback group",
        role: "member"
      },
      {
        groupId: "last",
        name: "Last group",
        role: "reviewer"
      }
    ]);
  });
});
