import type { ConnectComputerWire } from "@/lib/contracts/computer";
import type { ConnectArch, ConnectOs } from "@/lib/contracts/connect";
import type { ConnectFailureCode } from "./connectApi";

/** The mode's only name: never "Connect" on its own. */
export const CONNECT_PRODUCT_NAME = "AIQSA Connect";

const OS_LABELS: Readonly<Record<ConnectOs, string>> = { darwin: "macOS", linux: "Linux", windows: "Windows" };
const ARCH_LABELS: Readonly<Record<ConnectArch, string>> = { amd64: "x64", arm64: "ARM64" };

export function connectPlatformLabel(os: ConnectOs, arch: ConnectArch): string {
  return `${OS_LABELS[os]} · ${ARCH_LABELS[arch]}`;
}

/** What the computer reported about itself when online ("Windows 11 Pro"), else its OS family. */
export function connectComputerSystemLabel(computer: Pick<ConnectComputerWire, "arch" | "info" | "os">): string {
  return computer.info?.osVersion
    ? `${computer.info.osVersion} · ${ARCH_LABELS[computer.arch]}`
    : connectPlatformLabel(computer.os, computer.arch);
}

/** Windows paths use `\`, other systems `/`; a path that names a drive or a UNC share is Windows-style. */
function windowsStyle(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\") || (path.includes("\\") && !path.includes("/"));
}

/** The last segment of a folder path, as the composer chip shows it: `~` for home, the drive for a root. */
export function connectFolderName(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed === "~") return "~";
  const separators = windowsStyle(trimmed) ? /[\\/]+$/u : /\/+$/u;
  const withoutTrailing = trimmed.replace(separators, "");
  if (!withoutTrailing) return "/";
  if (/^[A-Za-z]:$/u.test(withoutTrailing)) return `${withoutTrailing}\\`;
  const index = Math.max(withoutTrailing.lastIndexOf("/"), windowsStyle(trimmed) ? withoutTrailing.lastIndexOf("\\") : -1);
  return withoutTrailing.slice(index + 1) || withoutTrailing;
}

/** A subfolder of `parent` on that computer, with its own separator. */
export function connectChildPath(parent: string, name: string, os: ConnectOs): string {
  const separator = os === "windows" || windowsStyle(parent) ? "\\" : "/";
  return parent.endsWith("/") || parent.endsWith("\\") ? `${parent}${name}` : `${parent}${separator}${name}`;
}

/** `/home/me/app` → `~/app` (and `C:\Users\me\Docs` → `~\Docs`) for a folder under the computer's home. */
export function connectDisplayPath(path: string, home: string | null): string {
  if (!home || home === "/" || home.length <= 3) return path;
  const windows = windowsStyle(home);
  const same = windows ? (left: string, right: string) => left.toLowerCase() === right.toLowerCase() : (left: string, right: string) => left === right;
  const homeTrimmed = home.replace(windows ? /[\\/]+$/u : /\/+$/u, "");
  if (same(path.replace(windows ? /[\\/]+$/u : /\/+$/u, ""), homeTrimmed)) return "~";
  const head = path.slice(0, homeTrimmed.length);
  const next = path.charAt(homeTrimmed.length);
  if (same(head, homeTrimmed) && (next === "/" || (windows && next === "\\"))) return `~${path.slice(homeTrimmed.length)}`;
  return path;
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
  return `Offline · last seen ${connectRelativeTime(lastSeenAt, now)}`;
}

function retryLater(retryAfterSeconds: number | undefined): string {
  return retryAfterSeconds ? `Try again in ${retryAfterSeconds} s.` : "Try again in a moment.";
}

/**
 * One sentence for a refusal, by its stable code. The switch reads the code as
 * a string so codes the device protocol retires do not have to be listed.
 */
export function connectErrorMessage(code: ConnectFailureCode, retryAfterSeconds?: number): string {
  switch (code as string) {
    case "connect_device_offline":
    case "connect_device_disconnected": return "This computer is offline. Start AIQSA Connect on it, then try again.";
    case "connect_device_timeout":
    case "computer_timeout": return "The computer did not answer in time. Try again.";
    case "connect_device_limit": return "You already have the maximum of 10 computers. Revoke one in AIQSA Connect first.";
    case "connect_device_unavailable":
    case "connect_not_found": return "This computer is no longer connected to your account.";
    case "computer_path_not_found":
    case "connect_cwd_invalid": return "This folder does not exist on the computer.";
    case "computer_not_a_directory":
    case "computer_is_a_directory": return "This is a file, not a folder. Choose a folder.";
    case "computer_permission_denied": return "Your account on the computer cannot open this folder.";
    case "computer_limit": return "The computer is busy with other work. Try again in a moment.";
    case "connect_client_outdated": return "AIQSA Connect on this computer is out of date. It updates itself when it next connects.";
    case "connect_pairing_expired": return "This code is not valid or has expired. Start the connection on your computer again to get a new code.";
    case "connect_rate_limited": return `Too many requests. ${retryLater(retryAfterSeconds)}`;
    case "connect_unsupported": return "The computer could not do this. Update AIQSA Connect on it.";
    case "connect_device_error": return "The computer could not complete the request. Try again.";
    case "connect_disabled": return "AIQSA Connect is turned off for this installation.";
    case "connect_unauthorized": return "Your session has expired. Sign in again to continue.";
    case "network_error": return "AIQSA could not be reached. Check your connection and try again.";
    default: return "The request could not be completed. Try again.";
  }
}
