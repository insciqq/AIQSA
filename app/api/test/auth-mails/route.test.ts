// @vitest-environment node

import { createTestAuthMailHandlers } from "@/lib/server/auth/testMailHandlers";

describe("test auth mail route", () => {
  it("returns not found when deterministic local test auth is disabled", async () => {
    const load = vi.fn();
    const disabled = createTestAuthMailHandlers({
      enabled: () => false,
      load
    });

    expect((await disabled.GET()).status).toBe(404);
    expect((await disabled.DELETE()).status).toBe(404);
    expect(load).not.toHaveBeenCalled();
  });

  it("lists and clears the local mail sink when test auth is enabled", async () => {
    const list = vi.fn(() => [
      { subject: "Verify", text: "one-time link", to: "operator@example.com" }
    ]);
    const clear = vi.fn();
    const load = vi.fn(async () => ({ clear, list }));
    const handlers = createTestAuthMailHandlers({
      enabled: () => true,
      load
    });

    const getResponse = await handlers.GET();
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({
      emails: [{ subject: "Verify", text: "one-time link", to: "operator@example.com" }]
    });
    expect(list).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();

    const deleteResponse = await handlers.DELETE();
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ ok: true });
    expect(clear).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
