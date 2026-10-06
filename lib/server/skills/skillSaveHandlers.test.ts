import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createSkillSaveHandlers } from "./skillSaveHandlers";

const session = (status = "active") => ({ userId: "user-1", user: { status } }) as unknown as AuthenticatedSession;

function harness(input: Readonly<{ signedIn?: boolean; status?: string }> = {}) {
  const service = {
    state: vi.fn(async () => ({ state: "available" as const })),
    undo: vi.fn(async () => ({ state: "undone" as const, outcome: "restored" as const, revision: 5 })),
    revisionFile: vi.fn(async () => ({ path: "run.sh", content: "#!/bin/sh\n" }))
  };
  const handlers = createSkillSaveHandlers({ resolveAuth: async () => input.signedIn === false ? null : session(input.status),
    service: () => service });
  return { handlers, service };
}
const saveContext = (skillId = "skill-1", saveId = "save-1") => ({ params: { skillId, saveId } });

describe("Skill save card routes", () => {
  it("reads and performs Undo as the signed-in owner", async () => {
    const { handlers, service } = harness();
    const state = await handlers.GET_UNDO(new Request("http://app/api"), saveContext());
    expect(await state.json()).toEqual({ state: "available" });
    expect(state.headers.get("cache-control")).toBe("private, no-store");
    const undo = await handlers.POST_UNDO(new Request("http://app/api", { method: "POST" }), saveContext());
    expect(await undo.json()).toEqual({ state: "undone", outcome: "restored", revision: 5 });
    expect(service.undo).toHaveBeenCalledWith({ userId: "user-1", skillId: "skill-1", saveId: "save-1" });
  });

  it("refuses anonymous, inactive and malformed requests before the service", async () => {
    expect((await harness({ signedIn: false }).handlers.POST_UNDO(new Request("http://app/api"), saveContext())).status).toBe(401);
    const inactive = harness({ status: "suspended" });
    expect((await inactive.handlers.POST_UNDO(new Request("http://app/api"), saveContext())).status).toBe(403);
    expect(inactive.service.undo).not.toHaveBeenCalled();
    const { handlers, service } = harness();
    expect((await handlers.POST_UNDO(new Request("http://app/api"), saveContext("../x"))).status).toBe(404);
    expect(service.undo).not.toHaveBeenCalled();
  });

  it("serves one immutable revision file by a safe path and hides others", async () => {
    const { handlers, service } = harness();
    const ok = await handlers.GET_FILE(new Request("http://app/api?path=run.sh"), { params: { skillId: "skill-1", revisionId: "rev-1" } });
    expect(await ok.json()).toEqual({ path: "run.sh", content: "#!/bin/sh\n" });
    expect(service.revisionFile).toHaveBeenCalledWith({ userId: "user-1", skillId: "skill-1", revisionId: "rev-1", path: "run.sh" });
    for (const query of ["?path=../etc", "?path=a&path=b", "?path=a&x=1", ""]) {
      expect((await handlers.GET_FILE(new Request(`http://app/api${query}`), { params: { skillId: "skill-1", revisionId: "rev-1" } })).status, query)
        .toBe(400);
    }
    service.revisionFile.mockResolvedValueOnce(null as never);
    expect((await handlers.GET_FILE(new Request("http://app/api?path=x"), { params: { skillId: "skill-1", revisionId: "rev-1" } })).status)
      .toBe(404);
  });

  it("fails visibly without leaking database errors", async () => {
    const { handlers, service } = harness();
    service.undo.mockRejectedValueOnce(new Error("connection refused at 10.0.0.1"));
    const response = await handlers.POST_UNDO(new Request("http://app/api"), saveContext());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("10.0.0.1");
  });
});
