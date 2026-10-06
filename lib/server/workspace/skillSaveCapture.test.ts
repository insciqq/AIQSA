import { describe, expect, it, vi } from "vitest";
import { createSkillSaveWorkspaceReader } from "./skillSaveCapture";

function captures(files: Record<string, Buffer>, fail = false) {
  const create = vi.fn(async (_input: { requestKey: string }) => ({ id: "c".repeat(32), readiness: "captured" as const,
    files: Object.entries(files).map(([relativePath, bytes]) => ({ relativePath, byteSize: bytes.length, checksum: "x", mimeType: "text/plain",
      readiness: "captured" as const })) }));
  const openFile = vi.fn(async (input: { relativePath: string }) => {
    if (fail) throw new Error("synthetic_stream_failure");
    return new Response(files[input.relativePath]).body!;
  });
  const release = vi.fn(async () => undefined);
  return { create, openFile, release };
}

describe("Skill save Workspace reader", () => {
  it("reads every captured file within the bound, lists larger ones unread and always releases the capture", async () => {
    const fake = captures({ "project/s/SKILL.md": Buffer.from("skill"), "project/s/big.bin": Buffer.alloc(32) });
    const reader = createSkillSaveWorkspaceReader({ captures: fake as never,
      repository: { binding: vi.fn(), personalSecrets: vi.fn() } as never });
    const files = await reader.read({ runId: "run", userId: "user", consumerKey: "call", maxFileBytes: 16,
      files: [{ root: "project", relativePath: "s/SKILL.md" }, { root: "project", relativePath: "s/big.bin" }] });
    expect(files).toEqual([{ relativePath: "project/s/SKILL.md", byteSize: 5, bytes: Buffer.from("skill") },
      { relativePath: "project/s/big.bin", byteSize: 32, bytes: null }]);
    expect(fake.openFile).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledOnce();
    // A later attempt never reuses the released capture.
    await reader.read({ runId: "run", userId: "user", consumerKey: "call", maxFileBytes: 16, files: [] });
    const keys = fake.create.mock.calls.map(([input]) => input.requestKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => /^call_[a-f0-9]{32}$/u.test(key))).toBe(true);

    const failing = captures({ "project/s/SKILL.md": Buffer.from("skill") }, true);
    await expect(createSkillSaveWorkspaceReader({ captures: failing as never, repository: {} as never })
      .read({ runId: "run", userId: "user", consumerKey: "call", maxFileBytes: 16, files: [] })).rejects.toThrow("synthetic_stream_failure");
    expect(failing.release).toHaveBeenCalledOnce();
  });

  it("returns the run's delivered secrets and fails closed without a current binding", async () => {
    const binding = { runId: "run" };
    const personalSecrets = vi.fn(async () => [{ value: { kind: "text", text: "secret-value" } }]);
    const reader = createSkillSaveWorkspaceReader({ captures: {} as never,
      repository: { binding: vi.fn(async () => binding), personalSecrets } as never });
    expect(await reader.secrets({ runId: "run", userId: "user" })).toHaveLength(1);
    expect(personalSecrets).toHaveBeenCalledWith(binding);
    const missing = createSkillSaveWorkspaceReader({ captures: {} as never,
      repository: { binding: vi.fn(async () => null), personalSecrets } as never });
    await expect(missing.secrets({ runId: "run", userId: "user" })).rejects.toThrow("skill_save_workspace_unavailable");
  });
});
