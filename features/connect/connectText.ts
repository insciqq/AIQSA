import type { ConnectArch, ConnectOs, ConnectProgram, ConnectSessionStatus } from "@/lib/contracts/connect";
import type { ConnectFailureCode } from "./connectApi";

/** The mode's only name: never "Connect" on its own. */
export const CONNECT_PRODUCT_NAME = "AIQSA Connect";

export const CONNECT_PROGRAM_LABELS: Readonly<Record<ConnectProgram, string>> = {
  claude: "Claude Code",
  codex: "Codex",
  shell: "Shell"
};

export const CONNECT_STATUS_LABELS: Readonly<Record<ConnectSessionStatus, string>> = {
  idle: "Idle",
  needs_approval: "Needs approval",
  running: "Running",
  waiting: "Your turn"
};

const OS_LABELS: Readonly<Record<ConnectOs, string>> = { darwin: "macOS", linux: "Linux" };

export function connectPlatformLabel(os: ConnectOs, arch: ConnectArch): string {
  return `${OS_LABELS[os]} · ${arch}`;
}

/** The last path segment, as the session list shows the folder. */
export function connectFolderName(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  if (!trimmed) return "/";
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return segment || trimmed;
}

/** The title the computer gives a session when the user leaves it empty. */
export function connectDefaultSessionTitle(program: ConnectProgram, cwd: string): string {
  return `${CONNECT_PROGRAM_LABELS[program]} · ${connectFolderName(cwd.trim() || "~")}`;
}

/** `/home/me/app` → `~/app` for a recent folder under the computer's home. */
export function connectDisplayPath(path: string, home: string | null): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function connectRelativeTime(timestamp: string, now: number): string {
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(at).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" });
}

export function connectLastSeenLabel(online: boolean, lastSeenAt: string | null, now: number): string {
  if (online) return "Online";
  if (!lastSeenAt) return "Not connected yet";
  return `Last seen ${connectRelativeTime(lastSeenAt, now)}`;
}

function retryLater(retryAfterSeconds: number | undefined): string {
  return retryAfterSeconds ? `Try again in ${retryAfterSeconds} s.` : "Try again in a moment.";
}

/** One sentence for a refusal, by its reason code. */
export function connectErrorMessage(code: ConnectFailureCode, retryAfterSeconds?: number): string {
  switch (code) {
    case "connect_device_offline": return "This computer is offline. Start aiqsa-connect on it, then try again.";
    case "connect_device_timeout": return "The computer did not answer in time. Try again.";
    case "connect_device_limit": return "You already have the maximum of 10 computers. Revoke one in AIQSA Connect first.";
    case "connect_session_limit": return "This computer already runs the maximum of 30 sessions. End one first.";
    case "connect_view_limit": return "Too many terminals of this computer are open. Close one in another tab or device.";
    case "connect_session_not_found": return "This session has ended on the computer.";
    case "connect_cwd_invalid": return "This folder does not exist on the computer.";
    case "connect_pairing_expired": return "This code is not valid or has expired. Run aiqsa-connect login on your computer again to get a new code.";
    case "connect_rate_limited": return `Too many requests. ${retryLater(retryAfterSeconds)}`;
    case "connect_input_too_large": return "That input is too large to send at once.";
    case "connect_unsupported": return "The computer could not do this. Update aiqsa-connect on it and check that the program is installed.";
    case "connect_device_error": return "The computer could not complete the request. Try again.";
    case "connect_not_found": return "This computer or session is not available.";
    case "connect_disabled": return "AIQSA Connect is turned off for this installation.";
    case "connect_unauthorized": return "Your session has expired. Sign in again to continue.";
    case "network_error": return "AIQSA could not be reached. Check your connection and try again.";
    default: return "The request could not be completed. Try again.";
  }
}
