import { afterEach, describe, expect, it, vi } from "vitest";
import { signOutCurrentSession } from "./sessionActions";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("signOutCurrentSession", () => {
  it("revokes through the JSON same-site route before navigating to login", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const navigate = vi.fn();

    await expect(signOutCurrentSession({ fetcher, navigate })).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenCalledWith("/api/auth/logout", {
      body: "{}",
      credentials: "same-origin",
      headers: {
        "content-type": "application/json"
      },
      method: "POST",
      signal: expect.any(AbortSignal)
    });
    expect(navigate).toHaveBeenCalledWith("/login");
  });

  it("keeps the user in place and preserves a stable backend code on failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "unauthorized" }), {
        headers: { "content-type": "application/json" },
        status: 401
      })
    );
    const navigate = vi.fn();

    const result = await signOutCurrentSession({ fetcher, navigate });

    expect(result).toEqual({
      error: "Your session is no longer valid. Refresh the page or sign in again. (unauthorized)",
      ok: false
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("returns actionable network feedback without navigating", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    const navigate = vi.fn();

    const result = await signOutCurrentSession({ fetcher, navigate });

    expect(result).toEqual({
      error: "Could not reach the server. Check your connection and try signing out again. (network_error)",
      ok: false
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("aborts and returns separate actionable timeout feedback when logout hangs", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(
      () =>
        new Promise<Response>(() => {
          // Deliberately ignore the signal: the helper must still settle at its deadline.
        })
    );
    const navigate = vi.fn();

    const pending = signOutCurrentSession({ fetcher, navigate, timeoutMs: 250 });
    const signal = fetcher.mock.calls[0]?.[1]?.signal as AbortSignal;

    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(250);

    await expect(pending).resolves.toEqual({
      error: "Sign out timed out. Check your connection and try again. (logout_timeout)",
      ok: false
    });
    expect(signal.aborted).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("always clears its deadline after a response or network failure", async () => {
    vi.useFakeTimers();
    const navigate = vi.fn();

    await signOutCurrentSession({
      fetcher: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
      navigate,
      timeoutMs: 250
    });
    expect(vi.getTimerCount()).toBe(0);

    await signOutCurrentSession({
      fetcher: vi.fn().mockRejectedValue(new Error("offline")),
      navigate,
      timeoutMs: 250
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
