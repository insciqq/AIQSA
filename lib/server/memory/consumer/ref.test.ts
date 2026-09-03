import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createMemoryConsumerRefService,
  MEMORY_CONSUMER_REF_TTL_MS
} from "./ref";

const key = randomBytes(32);
const refs = createMemoryConsumerRefService({ encryptionKey: () => key });
const now = new Date("2026-08-21T05:00:00.000Z");

describe("Memory consumer refs", () => {
  it("keeps item identity encrypted, owner-bound, operation-bound, and expiring", () => {
    const ref = refs.mintItem("user-1", {
      allowedOperations: ["READ", "EDIT", "FORGET"],
      factId: "private-fact-id",
      factVersionId: "private-version-id"
    }, now);
    expect(ref).not.toContain("private-fact-id");
    expect(ref).not.toContain("private-version-id");
    expect(refs.resolveItem("user-1", ref, "EDIT", now)).toEqual({
      factId: "private-fact-id",
      factVersionId: "private-version-id"
    });
    expect(refs.resolveItem("user-1", ref, "READ", now)).toEqual({
      factId: "private-fact-id",
      factVersionId: "private-version-id"
    });
    expect(refs.resolveItem("other-user", ref, "EDIT", now)).toBeNull();
    expect(refs.resolveItem(
      "user-1",
      ref,
      "EDIT",
      new Date(now.getTime() + MEMORY_CONSUMER_REF_TTL_MS)
    )).toBeNull();
  });

  it("does not grant read authority to an operation-limited reference", () => {
    const ref = refs.mintItem("user-1", {
      allowedOperations: ["EDIT"],
      factId: "private-fact-id",
      factVersionId: "private-version-id"
    }, now);

    expect(refs.resolveItem("user-1", ref, "READ", now)).toBeNull();
  });

  it("encrypts repository cursors before they cross the browser boundary", () => {
    const cursor = "eyJpZCI6InByaXZhdGUtZmFjdC1pZCJ9";
    const ref = refs.mintCursor("user-1", cursor, now);
    expect(ref).not.toContain(cursor);
    expect(refs.resolveCursor("user-1", ref, now)).toBe(cursor);
    expect(refs.resolveCursor("other-user", ref, now)).toBeNull();
  });
});
