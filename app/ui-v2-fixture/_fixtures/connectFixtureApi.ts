import type { ConnectEventSource } from "@/features/connect/connectDeviceFeed";
import type { ConnectDeviceSource } from "@/features/connect/connectShellContext";
import type { ConnectViewTransport } from "@/features/connect/connectTerminalSession";
import type { ConnectDevice } from "@/lib/contracts/connect";

/**
 * Synthetic AIQSA Connect data for the gallery: a fixed device list, an
 * in-browser `/api/connect` for pairing, recent folders and session start,
 * and a terminal view that replays a static screen. Nothing reaches a server.
 */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export function connectFixtureDevices(): ConnectDevice[] {
  return [
    {
      arch: "arm64",
      clientVersion: "0.3.20",
      createdAt: minutesAgo(60 * 24 * 9),
      hostname: "dana-mbp.local",
      id: "0b6f2c1e-5a7d-4c3e-9f10-2a4b6c8d0e1f",
      lastSeenAt: minutesAgo(0),
      name: "MacBook Pro",
      online: true,
      os: "darwin",
      sessions: [
        {
          attachedClients: 1,
          createdAt: minutesAgo(42),
          cwd: "/Users/dana/src/aiqsa",
          id: "ac-k3m9q2",
          program: "claude",
          status: "needs_approval",
          statusAt: minutesAgo(1),
          title: "Rate limit for the login route"
        },
        {
          attachedClients: 0,
          createdAt: minutesAgo(130),
          cwd: "/Users/dana/src/payments-service",
          id: "ac-p7x2we",
          program: "codex",
          status: "waiting",
          statusAt: minutesAgo(12),
          title: "Codex · payments-service"
        },
        {
          attachedClients: 0,
          createdAt: minutesAgo(300),
          cwd: "/Users/dana",
          id: "ac-shell01",
          program: "shell",
          status: "idle",
          statusAt: minutesAgo(250),
          title: "Shell · dana"
        }
      ]
    },
    {
      arch: "amd64",
      clientVersion: "0.3.20",
      createdAt: minutesAgo(60 * 24 * 30),
      hostname: "build-box",
      id: "6c1d9e3a-2b4f-4a8c-8d7e-5f3a1b9c0d2e",
      lastSeenAt: minutesAgo(0),
      name: "build-box",
      online: true,
      os: "linux",
      sessions: [
        {
          attachedClients: 0,
          createdAt: minutesAgo(18),
          cwd: "/home/dana/work/infrastructure-with-a-rather-long-folder-name",
          id: "ac-b8n4t6",
          program: "claude",
          status: "running",
          statusAt: minutesAgo(0),
          title: "Nightly migration check across every staging database"
        }
      ]
    },
    {
      arch: "amd64",
      clientVersion: "0.3.19",
      createdAt: minutesAgo(60 * 24 * 60),
      hostname: "DESKTOP-7Q2",
      id: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b",
      lastSeenAt: minutesAgo(190),
      name: "Home desktop (WSL)",
      online: false,
      os: "linux",
      sessions: [
        {
          attachedClients: 0,
          createdAt: minutesAgo(60 * 26),
          cwd: "/home/dana/notes",
          id: "ac-h2j5l8",
          program: "shell",
          status: "idle",
          statusAt: minutesAgo(60 * 4),
          title: "Shell · notes"
        }
      ]
    }
  ];
}

export function staticConnectDeviceSource(devices: ConnectDevice[]): ConnectDeviceSource {
  const snapshot = { connection: "live" as const, devices, loadError: null };
  return {
    getSnapshot: () => snapshot,
    removeDevice: () => undefined,
    removeSession: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    subscribe: () => () => undefined
  };
}

const ESC = "\u001b";
const dim = (text: string) => `${ESC}[2m${text}${ESC}[0m`;
const bold = (text: string) => `${ESC}[1m${text}${ESC}[0m`;
const accent = (text: string) => `${ESC}[38;5;209m${text}${ESC}[0m`;
const green = (text: string) => `${ESC}[32m${text}${ESC}[0m`;
const red = (text: string) => `${ESC}[31m${text}${ESC}[0m`;
const cyan = (text: string) => `${ESC}[36m${text}${ESC}[0m`;

/** A synthetic agent screen waiting for an approval. */
export const CONNECT_FIXTURE_SCREEN = [
  `${accent("✻")} ${bold("Agent session")} ${dim("· ~/src/aiqsa")}`,
  "",
  `${dim(">")} Add a per-IP rate limit to the login route and cover it with a test`,
  "",
  `${cyan("●")} I'll add a limiter in front of the login handler and reuse the existing store.`,
  "",
  `${cyan("●")} ${bold("Read")}(lib/server/auth/login.ts)`,
  `  ${dim("⎿  Read 182 lines")}`,
  "",
  `${cyan("●")} ${bold("Update")}(lib/server/auth/login.ts)`,
  `  ${dim("⎿  Updated lib/server/auth/login.ts with 12 additions and 2 removals")}`,
  `     ${dim("41")}   export async function login(request: Request) {`,
  `     ${dim("42")} ${red("-")}   const body = await readJsonBody(request);`,
  `     ${dim("42")} ${green("+")}   const limited = await loginLimiter.check(clientAddress(request));`,
  `     ${dim("43")} ${green("+")}   if (limited) return tooManyAttempts(limited.retryAfterSeconds);`,
  `     ${dim("44")} ${green("+")}   const body = await readJsonBody(request);`,
  "",
  `  ${dim("Glyphs: ⎿ ╭─╮ │ ╰─╯ ❯ › ✻ ●")}`,
  "",
  `${cyan("●")} ${bold("Bash")}(npx vitest run lib/server/auth/login.test.ts)`,
  "",
  `${dim("╭──────────────────────────────────────────────────────────────╮")}`,
  `${dim("│")} ${bold("Bash command")}                                                 ${dim("│")}`,
  `${dim("│")}   npx vitest run lib/server/auth/login.test.ts               ${dim("│")}`,
  `${dim("│")}                                                              ${dim("│")}`,
  `${dim("│")} Do you want to proceed?                                      ${dim("│")}`,
  `${dim("│")} ${accent("❯ 1. Yes")}                                                     ${dim("│")}`,
  `${dim("│")}   2. Yes, and don't ask again for vitest commands            ${dim("│")}`,
  `${dim("│")}   3. No, and tell the agent what to do differently           ${dim("│")}`,
  `${dim("╰──────────────────────────────────────────────────────────────╯")}`
].join("\r\n");

/** The choices of the approval on the fixture screen. */
export const CONNECT_FIXTURE_OPTIONS = [
  { key: "1", label: "Yes" },
  { key: "2", label: "Yes, and don't ask again for vitest commands" },
  { key: "3", label: "No, and tell the agent what to do differently" }
];

/** Plain text, as the history endpoint answers: earlier work, then the current screen. */
export function connectFixtureHistory(): string {
  const earlier = Array.from({ length: 160 }, (_, index) =>
    index % 8 === 0
      ? `● Bash(npm run test -- shard ${index / 8 + 1})`
      : `  ⎿  ✓ lib/server/auth/case-${String(index).padStart(3, "0")}.test.ts (${(index * 7) % 23 + 2} tests) ${(index * 13) % 90 + 10}ms`);
  const screen = CONNECT_FIXTURE_SCREEN.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "gu"), "").split("\r\n");
  return [...earlier, "", ...screen].join("\n");
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class StaticViewStream implements ConnectEventSource {
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  private readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();
  private closed = false;

  constructor(screen: string) {
    window.setTimeout(() => {
      if (this.closed) return;
      this.onopen?.(new Event("open"));
      this.listeners.get("output")?.(new MessageEvent("output", {
        data: JSON.stringify({ data: base64Utf8(screen), seq: 0 })
      }));
    }, 50);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }

  close(): void {
    this.closed = true;
  }
}

const ok = <T,>(data: T) => Promise.resolve({ data, ok: true as const });

export function staticConnectViewTransport(screen = CONNECT_FIXTURE_SCREEN): ConnectViewTransport {
  return {
    closeView: () => undefined,
    createView: () => ok({ viewId: "3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f" }),
    openStream: () => new StaticViewStream(screen),
    resize: () => ok(undefined),
    sendInput: () => ok(undefined),
    setVisibility: () => ok(undefined)
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, status });
}

let installed = false;

/** Answers the browser API in this fixture page; installed once, before the first page effect. */
export function installConnectFixtureApi(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (path.startsWith("/api/connect/pairings/by-code/")) {
      if (path.endsWith("/ZZZZ-ZZZZ")) return json({ code: "connect_pairing_expired" }, 404);
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { decision?: string };
        return json({ status: body.decision === "deny" ? "denied" : "approved" });
      }
      return json({
        pairing: {
          arch: "arm64",
          clientVersion: "0.3.20",
          expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
          hostname: "dana-mbp.local",
          name: "MacBook Pro",
          os: "darwin"
        }
      });
    }
    if (path.endsWith("/recent-dirs")) {
      return json({
        dirs: ["/Users/dana/src/aiqsa", "/Users/dana/src/payments-service", "/Users/dana/notes", "/opt/tools"],
        home: "/Users/dana"
      });
    }
    if (path.endsWith("/options") && method === "GET") return json({ options: CONNECT_FIXTURE_OPTIONS });
    if (path.endsWith("/history") && method === "GET") return json({ text: connectFixtureHistory() });
    if (path === "/api/me/catalog") return json({ catalog: { dictation: { available: true, unavailableReason: null } } });
    if (path.endsWith("/sessions") && method === "POST") return json({ sessionId: "ac-new001" }, 201);
    if (path.startsWith("/api/connect/") && method === "DELETE") return new Response(null, { status: 204 });
    return original(input, init);
  };
}
