import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonalMcpConnection } from "./personalMcpApi";
import {
  applyPersonalMcpConnection,
  deactivatePersonalMcp,
  observePersonalMcpReadiness,
  refreshPersonalMcp,
  usePersonalMcpStore
} from "./personalMcpStore";

function connection(overrides: Partial<PersonalMcpConnection> = {}): PersonalMcpConnection {
  return {
    accountLabel: null, authHeaderName: null, authMode: "none", availableTools: [], description: "", enabled: true,
    fields: [], id: "personal-1", knownToolCount: 0, name: "Personal", oauthAvailable: false, oauthState: null,
    readiness: "ready", runtimeErrorCode: null, sourceType: "personal", tools: [], userDisabledToolNames: [],
    ...overrides
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  deactivatePersonalMcp();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("personal MCP store", () => {
  it("never lets an older read revert a newer server-confirmed row", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    const read = refreshPersonalMcp();
    applyPersonalMcpConnection(connection({ enabled: false }));
    pending.resolve(Response.json({ servers: [connection({ enabled: true })] }));
    await read;
    expect(usePersonalMcpStore.getState().connections).toEqual([expect.objectContaining({ enabled: false })]);
  });

  it("keeps the loaded rows when a background read fails and reports a first failure as an error state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "mcp_unavailable" }, { status: 503 })));
    await expect(refreshPersonalMcp()).rejects.toMatchObject({ code: "mcp_unavailable" });
    expect(usePersonalMcpStore.getState()).toMatchObject({ connections: [], error: "mcp_unavailable", loadState: "error" });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ servers: [connection()] })));
    await refreshPersonalMcp();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "mcp_unavailable" }, { status: 503 })));
    await expect(refreshPersonalMcp({ background: true })).rejects.toBeTruthy();
    expect(usePersonalMcpStore.getState()).toMatchObject({ connections: [expect.objectContaining({ id: "personal-1" })], loadState: "ready" });
  });

  it("drops a read that was in flight across an account change", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => pending.promise));
    const read = refreshPersonalMcp();
    deactivatePersonalMcp();
    pending.resolve(Response.json({ servers: [connection()] }));
    await read;
    expect(usePersonalMcpStore.getState()).toMatchObject({ connections: [], loadState: "idle" });
  });

  it("polls while an enabled connection is starting, backs off, and stops when settled or unobserved", async () => {
    vi.useFakeTimers();
    let readiness: PersonalMcpConnection["readiness"] = "starting";
    const fetchMock = vi.fn(async () => Response.json({ servers: [connection({ readiness })] }));
    vi.stubGlobal("fetch", fetchMock);
    await refreshPersonalMcp();
    const stop = observePersonalMcpReadiness();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    readiness = "ready";
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    readiness = "starting";
    applyPersonalMcpConnection(connection({ readiness: "queued" }));
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("never polls a disabled or failed connection", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => Response.json({ servers: [
      connection({ enabled: false, id: "off", readiness: "starting" }),
      connection({ id: "failed", readiness: "unavailable", runtimeErrorCode: "mcp_connect_failed" })
    ] }));
    vi.stubGlobal("fetch", fetchMock);
    await refreshPersonalMcp();
    const stop = observePersonalMcpReadiness();
    await vi.advanceTimersByTimeAsync(60_000);
    stop();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
