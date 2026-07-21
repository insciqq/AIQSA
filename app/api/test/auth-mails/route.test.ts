// @vitest-environment node

import { createTestAuthMailHandlers } from "./route";

describe("test auth mail route", () => {
  it("returns not found when deterministic local test auth is disabled", async () => {
    const list = vi.fn(() => []);
    const clear = vi.fn();
    const disabled = createTestAuthMailHandlers({
      clear,
      enabled: () => false,
      list
    });

    expect((await disabled.GET()).status).toBe(404);
    expect((await disabled.DELETE()).status).toBe(404);
    expect(list).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("lists and clears the local mail sink when test auth is enabled", async () => {
    const list = vi.fn(() => [
      { subject: "Verify", text: "one-time link", to: "operator@example.com" }
    ]);
    const clear = vi.fn();
    const handlers = createTestAuthMailHandlers({
      clear,
      enabled: () => true,
      list
    });

    const getResponse = await handlers.GET();
    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toEqual({
      emails: [{ subject: "Verify", text: "one-time link", to: "operator@example.com" }]
    });
    expect(list).toHaveBeenCalledOnce();

    const deleteResponse = await handlers.DELETE();
    expect(deleteResponse.status).toBe(200);
    await expect(deleteResponse.json()).resolves.toEqual({ ok: true });
    expect(clear).toHaveBeenCalledOnce();
  });
});
