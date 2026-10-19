import { vi } from "vitest";
import type { ReactNode } from "react";
import type { ConnectDevice } from "@/lib/contracts/connect";
import type { ConnectDeviceFeedSnapshot } from "./connectDeviceFeed";
import { ConnectShellContext, type ConnectShellContextValue } from "./connectShellContext";

export const MAC_ID = "0b6f2c1e-5a7d-4c3e-9f10-2a4b6c8d0e1f";
export const BOX_ID = "6c1d9e3a-2b4f-4a8c-8d7e-5f3a1b9c0d2e";

export function testDevices(now = Date.now()): ConnectDevice[] {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  return [
    {
      arch: "arm64",
      clientVersion: "0.3.20",
      createdAt: ago(1_000),
      hostname: "mbp.local",
      id: MAC_ID,
      lastSeenAt: ago(0),
      name: "MacBook Pro",
      online: true,
      os: "darwin",
      sessions: [
        {
          attachedClients: 0,
          createdAt: ago(40),
          cwd: "/Users/me/src/aiqsa",
          id: "ac-k3m9q2",
          program: "claude",
          status: "needs_approval",
          statusAt: ago(1),
          title: "Rate limit"
        },
        {
          attachedClients: 0,
          createdAt: ago(20),
          cwd: "/Users/me/src/payments",
          id: "ac-p7x2we",
          program: "codex",
          status: "waiting",
          statusAt: ago(2),
          title: "Payments"
        }
      ]
    },
    {
      arch: "amd64",
      clientVersion: "0.3.19",
      createdAt: ago(5_000),
      hostname: "build-box",
      id: BOX_ID,
      lastSeenAt: ago(180),
      name: "build-box",
      online: false,
      os: "linux",
      sessions: []
    }
  ];
}

export function testShellValue(devices: ConnectDevice[] | null, overrides: Partial<ConnectShellContextValue> = {}) {
  const snapshot: ConnectDeviceFeedSnapshot = { connection: "live", devices, loadError: null };
  const source = {
    getSnapshot: () => snapshot,
    removeDevice: vi.fn(),
    removeSession: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    subscribe: () => () => undefined
  };
  const value: ConnectShellContextValue = {
    installOrigin: "https://ai.example.com",
    leave: vi.fn(),
    openDrawer: vi.fn(),
    openNewSession: vi.fn(),
    snapshot,
    source,
    ...overrides
  };
  return { source, value };
}

export function ConnectTestShell({ children, value }: Readonly<{ children: ReactNode; value: ConnectShellContextValue }>) {
  return <ConnectShellContext.Provider value={value}>{children}</ConnectShellContext.Provider>;
}

export function jsonResponse(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(value === null ? null : JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
    status
  });
}
