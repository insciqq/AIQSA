import { beforeEach, describe, expect, it, vi } from "vitest";

const { decryptWorkspaceSecret, logEvent } = vi.hoisted(() => ({ decryptWorkspaceSecret: vi.fn(), logEvent: vi.fn() }));
vi.mock("../workspace/secrets/store", () => ({ decryptWorkspaceSecret }));
vi.mock("../observability", () => ({ logEvent }));

import { loadSavedSecretScreenedValues, type SavedSecretReader } from "./savedSecretLoader";

const SAVED = "synthetic-saved-token-0123456789";
const record = { code: "chat_search_saved_secret_unreadable", subsystem: "memory_search" } as const;

function reader(values: readonly string[]) {
  const findMany = vi.fn(async () => values.map((id) => ({ value: { id } })));
  return { db: { workspaceSecret: { findMany } } as unknown as SavedSecretReader, findMany };
}

beforeEach(() => {
  decryptWorkspaceSecret.mockReset();
  logEvent.mockReset();
  decryptWorkspaceSecret.mockImplementation((value: { id: string }) => {
    if (value.id === "broken") throw new Error("workspace_secret_unavailable");
    return { description: null, id: value.id, name: "TOKEN", value: { kind: "text", text: SAVED }, versionId: value.id };
  });
});

describe("loadSavedSecretScreenedValues", () => {
  it("reads only the owner's typed secrets and skips an unreadable one under the caller's record", async () => {
    const { db, findMany } = reader(["readable", "broken"]);
    const values = await loadSavedSecretScreenedValues(db, "user-1", record, () => Buffer.alloc(32));
    expect(values).toContain(SAVED);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { browserFileName: null, userId: "user-1" } }));
    expect(logEvent).toHaveBeenCalledExactlyOnceWith("service_operation", { action: "skip", code: record.code, count: 1,
      outcome: "degraded", stage: "validate", subsystem: record.subsystem });
  });

  it("counts every value unreadable when the encryption key is missing", async () => {
    const { db } = reader(["readable", "readable"]);
    const values = await loadSavedSecretScreenedValues(db, "user-1",
      { code: "memory_note_saved_secret_unreadable", subsystem: "configuration" }, () => { throw new Error("key_missing"); });
    expect(values).toEqual([]);
    expect(decryptWorkspaceSecret).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith("service_operation", expect.objectContaining({
      code: "memory_note_saved_secret_unreadable", count: 2, subsystem: "configuration" }));
  });

  it("asks for no key and logs nothing for an owner without saved secrets", async () => {
    const key = vi.fn(() => Buffer.alloc(32));
    await expect(loadSavedSecretScreenedValues(reader([]).db, "user-1", record, key)).resolves.toEqual([]);
    expect(key).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });
});
