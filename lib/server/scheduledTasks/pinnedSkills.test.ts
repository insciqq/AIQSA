import { describe, expect, it, vi } from "vitest";
import { loadScheduledTaskPinnedSkillMap } from "./pinnedSkills";

const revision = { hasExecutables: false, name: "health-questions" };
function client(rows: unknown[]) {
  return { skillDefinition: { findMany: vi.fn(async () => rows) } } as unknown as Parameters<typeof loadScheduledTaskPinnedSkillMap>[0];
}
const shipped = { id: "skill-1", archivedAt: null, ownerUserId: null, shippedKey: "health-questions",
  currentRevision: revision, sharedRevision: revision };

describe("a scheduled task's pinned shipped Skill", () => {
  it("is available as the Auto catalog offers it: on without a preference, off after the user's Off", async () => {
    expect((await loadScheduledTaskPinnedSkillMap(client([{ ...shipped, preferences: [] }]), "user-1", ["skill-1"])).get("skill-1"))
      .toMatchObject({ available: true, name: "health-questions" });
    expect((await loadScheduledTaskPinnedSkillMap(client([{ ...shipped, preferences: [{ enabled: false }] }]), "user-1", ["skill-1"])).get("skill-1"))
      .toMatchObject({ available: false });
    expect((await loadScheduledTaskPinnedSkillMap(client([{ ...shipped, shippedKey: null, ownerUserId: "owner-2", preferences: [] }]), "user-1", ["skill-1"])).get("skill-1"))
      .toMatchObject({ available: false });
  });
});
