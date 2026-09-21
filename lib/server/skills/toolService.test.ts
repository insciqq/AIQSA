import { describe, expect, it, vi } from "vitest";
import type { ProviderRunRequest } from "../providers/types";
import { createSkillToolService, skillTextPage } from "./toolService";
import { freezeSkillManifest } from "./runManifest";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";

const body = { skillId: "s", revisionId: "revision-frozen", name: "review", instructions: "Frozen instructions", fileCount: 2 };
const files = [{ path: "references/note.md", byteSize: 20, kind: "text" as const, executable: false }, { path: "assets/data.bin", byteSize: 4, kind: "binary" as const, executable: false }];
function harness(pinned = false) {
  const repository = {
    resolveFrozen: vi.fn(async () => ({ ...body, files })),
    isLoaded: vi.fn(async () => false),
    readText: vi.fn(async () => "Text from the frozen revision.")
  };
  const { manifest } = freezeSkillManifest({ mode: pinned ? "off" : "auto", pinned: pinned ? [body] : [], available: pinned ? [] : [body], toolsSupported: true });
  return { repository, service: createSkillToolService(repository), context: { userId: "u", runId: "run", request: { skills: manifest } as ProviderRunRequest } };
}
const call = (name: string, args: Record<string, unknown>): ModelToolCall => ({ id: "c", name, arguments: args });
const json = (result: ToolExecutionResult) => result.content[0]?.type === "json" ? result.content[0].value : null;

describe("progressive Skill tools", () => {
  it("loads only admitted immutable revisions and rechecks access each time", async () => {
    const h = harness();
    const loaded = await h.service.execute(call("load_skill", { skill: "review" }), h.context);
    expect(json(loaded)).toMatchObject({ instructions: "Frozen instructions", files: [{ path: "references/note.md" }, { kind: "binary" }], workspacePath: null });
    expect(h.repository.resolveFrozen).toHaveBeenCalledWith({ userId: "u", skillId: "s", revisionId: "revision-frozen" });
    h.repository.resolveFrozen.mockResolvedValueOnce(null as never);
    expect(json(await h.service.execute(call("load_skill", { skill: "review" }), h.context))).toEqual({ error: "skill_not_available" });
    expect(json(await h.service.execute(call("load_skill", { skill: "unlisted" }), h.context))).toEqual({ error: "skill_unknown" });
  });

  it("requires loading available Skills, while Off preserves pinned reference reads", async () => {
    const h = harness();
    const read = call("read_skill_file", { skill: "review", path: "references/note.md" });
    expect(json(await h.service.execute(read, h.context))).toEqual({ error: "skill_not_loaded" });
    h.repository.isLoaded.mockResolvedValue(true);
    expect(json(await h.service.execute(read, h.context))).toMatchObject({ content: "Text from the frozen revision.", nextOffset: null });
    const off = harness(true);
    expect((await off.service.execute(read, off.context)).status).toBe("complete");
    expect(off.repository.isLoaded).not.toHaveBeenCalled();
    expect(json(await off.service.execute(call("load_skill", { skill: "review" }), off.context))).toEqual({ error: "skill_unknown" });
    expect(json(await off.service.execute(call("read_skill_file", { skill: "review", path: "../secret" }), off.context))).toEqual({ error: "skill_path_invalid" });
    expect(json(await off.service.execute(call("read_skill_file", { skill: "review", path: "absent.md" }), off.context))).toEqual({ error: "skill_file_not_found" });
    expect(json(await off.service.execute(call("read_skill_file", { skill: "review", path: "assets/data.bin" }), off.context))).toEqual({ error: "skill_file_binary", workspacePath: null });
  });

  it("uses byte offsets without splitting UTF-8 and checks revocation between pages", async () => {
    const source = "a".repeat(65_535) + "🙂" + "終";
    const first = skillTextPage(source, 0)!;
    expect(first.content).toBe("a".repeat(65_535));
    expect(first.nextOffset).toBe(65_535);
    expect(skillTextPage(source, first.nextOffset!)?.content).toBe("🙂終");
    expect(skillTextPage(source, 65_536)).toBeNull();
    const h = harness(true);
    h.repository.readText.mockResolvedValue(source);
    expect((await h.service.execute(call("read_skill_file", { skill: "review", path: "references/note.md" }), h.context)).status).toBe("complete");
    h.repository.resolveFrozen.mockResolvedValueOnce(null as never);
    expect(json(await h.service.execute(call("read_skill_file", { skill: "review", path: "references/note.md", offset: 65_535 }), h.context))).toEqual({ error: "skill_not_available" });
    expect(h.repository.readText).toHaveBeenCalledTimes(1);
  });

  it("returns bounded errors after actual JSON escaping for both body and file pages", async () => {
    const h = harness();
    h.repository.resolveFrozen.mockResolvedValue({ ...body, files, instructions: "\u0001".repeat(128 * 1024) });
    const loaded = await h.service.execute(call("load_skill", { skill: "review" }), h.context);
    expect(json(loaded)).toEqual({ error: "skill_result_too_large" });
    expect(JSON.stringify(loaded).length).toBeLessThan(256);
    const pinned = harness(true);
    pinned.repository.readText.mockResolvedValue("\u0001".repeat(65_536));
    expect(json(await pinned.service.execute(call("read_skill_file", { skill: "review", path: "references/note.md" }), pinned.context))).toEqual({ error: "skill_result_too_large" });
  });
});
