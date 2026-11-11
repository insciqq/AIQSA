import { describe, expect, it } from "vitest";
import { omitQuietScheduledChecks, type QuietCheckNode } from "./quietScheduledChecks";

const user = (id: string, parentId: string | null): QuietCheckNode => ({ id, parentId, role: "user" });
const answer = (id: string, parentId: string): QuietCheckNode => ({ id, parentId, role: "assistant" });

describe("omitQuietScheduledChecks", () => {
  it("leaves out each quiet turn with every answer to it, and hangs what follows from the nearest kept message", () => {
    // baseline, two quiet checks, an update, a quiet check, the user's reply after it.
    const nodes = [user("b", null), answer("b-a", "b"), user("q1", "b-a"), answer("q1-a", "q1"), answer("q1-v2", "q1"),
      user("q2", "q1-a"), answer("q2-a", "q2"), user("u", "q2-a"), answer("u-a", "u"), user("q3", "u-a"), answer("q3-a", "q3"),
      user("reply", "q3-a"), answer("reply-a", "reply")];
    const omission = omitQuietScheduledChecks(nodes, new Set(["q1", "q2", "q3"]));
    expect([...omission.removed].sort()).toEqual(["q1", "q1-a", "q1-v2", "q2", "q2-a", "q3", "q3-a"]);
    expect(Object.fromEntries(omission.parents)).toEqual({ reply: "u-a", u: "b-a" });
    expect(omission.resolve("q3-a")).toBe("u-a");
    expect(omission.resolve("q2-a")).toBe("b-a");
    expect(omission.resolve("u-a")).toBe("u-a");
    expect(omission.resolve(null)).toBeNull();
  });

  it("reads a branch of only quiet checks as nothing, and keeps a branch without any whole", () => {
    const quiet = omitQuietScheduledChecks([user("q1", null), answer("q1-a", "q1"), user("q2", "q1-a"), answer("q2-a", "q2")],
      new Set(["q1", "q2"]));
    expect(quiet.resolve("q2-a")).toBeNull();
    const plain = omitQuietScheduledChecks([user("m", null), answer("m-a", "m")], new Set());
    expect(plain.removed.size).toBe(0);
    expect(plain.parents.size).toBe(0);
  });
});
