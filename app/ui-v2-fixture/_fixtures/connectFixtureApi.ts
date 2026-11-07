import type { ConnectComputerSource } from "@/features/connect/connectShellContext";
import type { ConnectComputerWire } from "@/lib/contracts/computer";

/**
 * Synthetic AIQSA Connect data for the gallery: a fixed computer list and an
 * in-browser `/api/connect` for pairing, recent folders, folder browsing and
 * folder checks. Nothing reaches a server.
 */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const CONNECT_FIXTURE_WINDOWS_ID = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
export const CONNECT_FIXTURE_MAC_ID = "0b6f2c1e-5a7d-4c3e-9f10-2a4b6c8d0e1f";
export const CONNECT_FIXTURE_BOX_ID = "6c1d9e3a-2b4f-4a8c-8d7e-5f3a1b9c0d2e";
/** A computer that is no longer the user's: the chip shows it as removed. */
export const CONNECT_FIXTURE_REMOVED_ID = "4d3c2b1a-0f9e-4d8c-9b7a-6f5e4d3c2b1a";

export function connectFixtureComputers(): ConnectComputerWire[] {
  return [
    {
      arch: "amd64",
      clientVersion: "0.4.22",
      id: CONNECT_FIXTURE_WINDOWS_ID,
      info: {
        home: "C:\\Users\\dana",
        osVersion: "Windows 11 Pro",
        shell: { kind: "powershell", name: "Windows PowerShell", version: "5.1" }
      },
      lastSeenAt: minutesAgo(0),
      name: "DESKTOP-7Q2",
      online: true,
      os: "windows"
    },
    {
      arch: "arm64",
      clientVersion: "0.4.22",
      id: CONNECT_FIXTURE_MAC_ID,
      info: { home: "/Users/dana", osVersion: "macOS 15.1", shell: { kind: "posix", name: "zsh", version: "5.9" } },
      lastSeenAt: minutesAgo(0),
      name: "Dana's MacBook Pro with a rather long computer name",
      online: true,
      os: "darwin"
    },
    {
      arch: "amd64",
      clientVersion: "0.4.21",
      id: CONNECT_FIXTURE_BOX_ID,
      lastSeenAt: minutesAgo(190),
      name: "build-box",
      online: false,
      os: "linux"
    }
  ];
}

export function staticConnectComputerSource(computers: ConnectComputerWire[] | null): ConnectComputerSource {
  const snapshot = { computers, connection: "live" as const, loadError: null };
  return {
    getSnapshot: () => snapshot,
    removeComputer: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe: () => () => undefined
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status });
}

const WINDOWS_TREE: Readonly<Record<string, readonly string[]>> = {
  "C:\\Users\\dana": ["Desktop", "Documents", "Downloads", "Pictures", "Projects"],
  "C:\\Users\\dana\\Documents": ["Contracts", "Invoices 2026", "Reports", "Templates"],
  "C:\\Users\\dana\\Documents\\Reports": ["October", "September"]
};
const MAC_TREE: Readonly<Record<string, readonly string[]>> = {
  "/Users/dana": ["Desktop", "Documents", "Downloads", "src"],
  "/Users/dana/src": ["aiqsa", "payments-service"]
};

function parentOf(path: string): string | null {
  const windows = path.includes("\\");
  const index = path.lastIndexOf(windows ? "\\" : "/");
  if (windows) return index > 2 ? path.slice(0, index) : null;
  return index > 0 ? path.slice(0, index) : path === "/" ? null : "/";
}

let installed = false;

/** Answers the browser API in this fixture page; installed once, before the first page effect. */
export function installConnectFixtureApi(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.origin);
    const path = url.pathname;
    const method = (init?.method ?? "GET").toUpperCase();
    if (path.startsWith("/api/connect/pairings/by-code/")) {
      if (path.endsWith("/ZZZZ-ZZZZ")) return json({ code: "connect_pairing_expired" }, 404);
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { decision?: string };
        return json({ status: body.decision === "deny" ? "denied" : "approved" });
      }
      return json({
        pairing: {
          arch: "amd64",
          clientVersion: "0.4.22",
          expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
          hostname: "DESKTOP-7Q2",
          name: "DESKTOP-7Q2",
          os: "windows"
        }
      });
    }
    const windows = path.includes(CONNECT_FIXTURE_WINDOWS_ID);
    if (path.endsWith("/recent-dirs")) {
      return json(windows
        ? {
            dirs: ["C:\\Users\\dana\\Documents\\Reports", "C:\\Users\\dana\\Projects\\budget-2027", "D:\\Archive\\Scans"],
            home: "C:\\Users\\dana"
          }
        : { dirs: ["/Users/dana/src/aiqsa", "/Users/dana/notes"], home: "/Users/dana" });
    }
    if (path.endsWith("/dirs")) {
      const requested = url.searchParams.get("path") ?? "~";
      const target = requested === "~" ? windows ? "C:\\Users\\dana" : "/Users/dana" : requested;
      const tree = windows ? WINDOWS_TREE : MAC_TREE;
      return json({ dirs: [...(tree[target] ?? [])], parent: parentOf(target), path: target, truncated: false });
    }
    if (path.endsWith("/stat")) {
      const requested = url.searchParams.get("path") ?? "";
      if (/\.(?:txt|docx|xlsx|pdf)$/iu.test(requested)) {
        return json({ exists: true, kind: "file", mtime: minutesAgo(30), path: requested, size: 2048 });
      }
      if (/missing/iu.test(requested)) return json({ exists: false });
      return json({ exists: true, kind: "dir", mtime: minutesAgo(30), path: requested, size: 0 });
    }
    if (path.startsWith("/api/connect/") && method === "DELETE") return new Response(null, { status: 204 });
    return original(input, init);
  };
}
