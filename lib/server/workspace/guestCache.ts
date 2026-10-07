/**
 * uv's download and environment cache on the chat's own guest disk, so
 * `uv run --script` reuses it between runs of the same chat. It lies outside
 * every export, archive, share and carry-over root (`/workspace/output`,
 * `/workspace/project`, `/workspace/inbox`), so it never leaves the disk.
 */
export const WORKSPACE_UV_CACHE_DIRECTORY = "/workspace/.cache/uv";

/**
 * Release defaults every guest command starts from. Run, saved and
 * per-command values of the same name win.
 */
export const WORKSPACE_GUEST_COMMAND_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  UV_CACHE_DIR: WORKSPACE_UV_CACHE_DIRECTORY
});

/** A scheduled run's execution initialization prunes the cache above this size. */
export const WORKSPACE_UV_CACHE_PRUNE_THRESHOLD_BYTES = 1024 * 1024 * 1024;
/** Guest-side bound of the prune itself; the measurement has its own shorter one. */
export const WORKSPACE_UV_CACHE_PRUNE_TIMEOUT_SECONDS = 60;
/** Host-side bound of the whole helper: both guest bounds plus their kill grace. */
export const WORKSPACE_UV_CACHE_BOUND_TIMEOUT_MS = 105_000;

export const WORKSPACE_UV_CACHE_BOUND_OUTCOMES = ["absent", "within", "pruned", "failed"] as const;
export type WorkspaceUvCacheBoundOutcome = (typeof WORKSPACE_UV_CACHE_BOUND_OUTCOMES)[number];

/**
 * Fixed guest helper run as `/bin/sh -c` with no caller input. It measures only
 * the cache directory (a path that resolves elsewhere through a symlink counts
 * as absent, so nothing outside it is touched), runs uv's own `cache prune`,
 * which removes only unused entries, when the directory exceeds the threshold,
 * discards all tool output and prints one outcome word. It always exits 0;
 * the host treats anything else as `failed`.
 */
export const BOUND_WORKSPACE_UV_CACHE = [
  "PATH=/opt/aiqsa-python/bin:/usr/local/bin:/usr/bin:/bin; export PATH",
  `dir='${WORKSPACE_UV_CACHE_DIRECTORY}'`,
  "if [ ! -d \"$dir\" ] || [ \"$(readlink -f -- \"$dir\" 2>/dev/null)\" != \"$dir\" ]; then echo absent; exit 0; fi",
  "size=$(timeout -k 5 30 du -sbx -- \"$dir\" 2>/dev/null | cut -f1)",
  "case \"$size\" in ''|*[!0-9]*) echo failed; exit 0;; esac",
  `if [ "$size" -le ${WORKSPACE_UV_CACHE_PRUNE_THRESHOLD_BYTES} ]; then echo within; exit 0; fi`,
  `if timeout -k 5 ${WORKSPACE_UV_CACHE_PRUNE_TIMEOUT_SECONDS} uv cache prune --cache-dir "$dir" >/dev/null 2>&1 </dev/null; then echo pruned; else echo failed; fi`,
  "exit 0"
].join("\n");

export function parseWorkspaceUvCacheBoundOutcome(stdout: string): WorkspaceUvCacheBoundOutcome {
  const value = stdout.trim();
  return (WORKSPACE_UV_CACHE_BOUND_OUTCOMES as readonly string[]).includes(value) ? value as WorkspaceUvCacheBoundOutcome : "failed";
}
