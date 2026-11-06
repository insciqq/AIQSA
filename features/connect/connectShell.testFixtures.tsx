import { vi } from "vitest";
import type { ReactNode } from "react";
import type { ConnectComputerWire } from "@/lib/contracts/computer";
import type { ConnectComputerFeedSnapshot } from "./connectDeviceFeed";
import { ConnectShellContext, type ConnectShellContextValue } from "./connectShellContext";

export const MAC_ID = "0b6f2c1e-5a7d-4c3e-9f10-2a4b6c8d0e1f";
export const BOX_ID = "6c1d9e3a-2b4f-4a8c-8d7e-5f3a1b9c0d2e";

export function testComputers(now = Date.now()): ConnectComputerWire[] {
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  return [
    {
      arch: "arm64",
      clientVersion: "0.4.22",
      id: MAC_ID,
      info: { home: "/Users/me", osVersion: "macOS 15.1", shell: { kind: "posix", name: "zsh", version: "5.9" } },
      lastSeenAt: ago(0),
      name: "MacBook Pro",
      online: true,
      os: "darwin"
    },
    {
      arch: "amd64",
      clientVersion: "0.4.21",
      id: BOX_ID,
      lastSeenAt: ago(180),
      name: "build-box",
      online: false,
      os: "linux"
    }
  ];
}

export function testShellValue(computers: ConnectComputerWire[] | null, overrides: Partial<ConnectShellContextValue> = {}) {
  const snapshot: ConnectComputerFeedSnapshot = { computers, connection: "live", loadError: null };
  const source = {
    getSnapshot: () => snapshot,
    removeComputer: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    subscribe: () => () => undefined
  };
  const value: ConnectShellContextValue = {
    installOrigin: "https://ai.example.com",
    leave: vi.fn(),
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
