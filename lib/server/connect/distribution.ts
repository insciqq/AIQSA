import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  CONNECT_ARCH_VALUES,
  CONNECT_CLIENT_CHECKSUMS_PATH,
  CONNECT_CLIENT_DOWNLOAD_PREFIX,
  CONNECT_MAX_CLIENT_BINARY_BYTES,
  CONNECT_OS_VALUES,
  connectClientBinaryName,
  connectClientManifestSchema,
  type ConnectArch,
  type ConnectOs
} from "@/lib/contracts/connect";
import { CONNECT_DEVICE_HEADERS, connectRefusal, connectUnavailable } from "./http";
import { logConnect } from "./observability";
import type { ConnectPolicyGate } from "./policy";

/** The checksum file `npm run build:connect` and the image's connect-build stage write beside the binaries. */
export const CONNECT_CLIENT_SUMS_FILE = "SHA256SUMS";
const SUMS_MAX_BYTES = 4_096;

export const CONNECT_CLIENT_TARGETS: readonly Readonly<{ arch: ConnectArch; os: ConnectOs }>[] = Object.freeze(
  CONNECT_OS_VALUES.flatMap((os) => CONNECT_ARCH_VALUES.map((arch) => Object.freeze({ arch, os })))
);
const BINARY_NAMES: ReadonlySet<string> = new Set(
  CONNECT_CLIENT_TARGETS.map((target) => connectClientBinaryName(target.os, target.arch))
);

export type ConnectClientFile = Readonly<{
  arch: ConnectArch;
  name: string;
  os: ConnectOs;
  path: string;
  sha256: string;
  size: number;
}>;

/** A verified `connect/dist`: every target's binary and the SHA256SUMS text that names them. */
export type ConnectClientDistribution = Readonly<{ files: readonly ConnectClientFile[]; sums: string }>;

/** `connect/dist` under the application root (`/app` in the image, the checkout in development). */
export function connectClientDistDirectory(applicationRoot: string): string {
  return path.join(applicationRoot, "connect", "dist");
}

function parseSums(text: string): Map<string, string> | null {
  const lines = text.split("\n");
  if (lines.pop() !== "") return null;
  const sums = new Map<string, string>();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/u.exec(line);
    if (!match || !BINARY_NAMES.has(match[2]) || sums.has(match[2])) return null;
    sums.set(match[2], match[1]);
  }
  return sums.size === BINARY_NAMES.size ? sums : null;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Identity of the files on disk: a rebuilt `connect/dist` is verified again. */
async function fingerprint(directory: string): Promise<string | null> {
  try {
    const names = [CONNECT_CLIENT_SUMS_FILE, ...BINARY_NAMES];
    const stats = await Promise.all(names.map((name) => stat(path.join(directory, name))));
    if (stats.some((entry) => !entry.isFile())) return null;
    return stats.map((entry) => `${entry.dev}:${entry.ino}:${entry.size}:${entry.mtimeMs}`).join("|");
  } catch {
    return null;
  }
}

async function verify(directory: string): Promise<ConnectClientDistribution | null> {
  const sumsPath = path.join(directory, CONNECT_CLIENT_SUMS_FILE);
  if ((await stat(sumsPath)).size > SUMS_MAX_BYTES) return null;
  const sumsText = await readFile(sumsPath, "utf8");
  const sums = parseSums(sumsText);
  if (!sums) return null;
  const files: ConnectClientFile[] = [];
  for (const target of CONNECT_CLIENT_TARGETS) {
    const name = connectClientBinaryName(target.os, target.arch);
    const filePath = path.join(directory, name);
    const { size } = await stat(filePath);
    if (size < 1 || size > CONNECT_MAX_CLIENT_BINARY_BYTES) return null;
    const sha256 = sums.get(name)!;
    if ((await sha256File(filePath)) !== sha256) return null;
    files.push(Object.freeze({ ...target, name, path: filePath, sha256, size }));
  }
  return Object.freeze({ files: Object.freeze(files), sums: sumsText });
}

/**
 * Reads `connect/dist`, hashing the binaries once per set of files on disk;
 * null while it is missing, incomplete or does not match its checksums.
 */
export function createConnectClientDistributionReader(directory: () => string) {
  let cached: Readonly<{ key: string; value: Promise<ConnectClientDistribution | null> }> | null = null;
  let failureLogged = false;

  function settle(value: ConnectClientDistribution | null): ConnectClientDistribution | null {
    if (value) {
      failureLogged = false;
    } else if (!failureLogged) {
      failureLogged = true;
      logConnect({ code: "connect_client_unavailable", outcome: "failed", stage: "read" });
    }
    return value;
  }

  return async function read(): Promise<ConnectClientDistribution | null> {
    const dir = directory();
    const key = await fingerprint(dir);
    if (!key) return settle(null);
    const fullKey = `${dir}|${key}`;
    if (cached?.key !== fullKey) {
      cached = { key: fullKey, value: verify(dir).catch(() => null) };
    }
    return settle(await cached.value);
  };
}

const SHELL_SAFE_ORIGIN = /^https?:\/\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$/u;

/** The installation's canonical origin from its configured base URL; null when it is not a plain origin. */
export function canonicalConnectOrigin(appBaseUrl: string): string | null {
  try {
    const base = new URL(appBaseUrl);
    if (base.username || base.password || base.hash || base.search) return null;
    return SHELL_SAFE_ORIGIN.test(base.origin) ? base.origin : null;
  } catch {
    return null;
  }
}

/**
 * The POSIX `sh` installer: downloads this computer's binary from `origin`,
 * checks it against `checksums.txt` and installs it without sudo. `origin`
 * must come from {@link canonicalConnectOrigin}, never from the request.
 */
export function connectInstallScript(origin: string): string {
  if (!SHELL_SAFE_ORIGIN.test(origin)) throw new Error("connect_install_origin_invalid");
  return `#!/bin/sh
# Installs aiqsa-connect, the AIQSA Connect client, from ${origin}:
# downloads the binary for this computer, checks its SHA-256 checksum and
# installs it into \${AIQSA_CONNECT_INSTALL_DIR:-$HOME/.local/bin} without sudo.
set -eu

origin='${origin}'

fail() {
  printf 'aiqsa-connect install: %s\\n' "$1" >&2
  exit 1
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "aiqsa-connect runs on macOS and Linux (including WSL), not on $(uname -s)." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "aiqsa-connect runs on amd64 and arm64 computers, not on $(uname -m)." ;;
esac
# A shell running under Rosetta reports x86_64 on Apple silicon.
if [ "$os" = darwin ] && [ "$arch" = amd64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
  arch=arm64
fi

if [ -n "\${AIQSA_CONNECT_INSTALL_DIR:-}" ]; then
  install_dir=$AIQSA_CONNECT_INSTALL_DIR
elif [ -n "\${HOME:-}" ]; then
  install_dir=$HOME/.local/bin
else
  fail "HOME is not set; set AIQSA_CONNECT_INSTALL_DIR to the directory to install into."
fi
case "$install_dir" in
  /*) ;;
  *) fail "the install directory must be an absolute path, not $install_dir." ;;
esac

if command -v curl >/dev/null 2>&1; then
  download() { curl -fsS --proto '=http,https' -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -q -O "$2" "$1"; }
else
  fail "curl or wget is required."
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "sha256sum or shasum is required."
fi

name="aiqsa-connect-$os-$arch"
target="$install_dir/aiqsa-connect"
mkdir -p "$install_dir" || fail "cannot create $install_dir."
# Downloaded next to the target, so the final rename is atomic even while
# the previous version is running.
partial="$install_dir/.aiqsa-connect.download.$$"
sums="$install_dir/.aiqsa-connect.checksums.$$"
trap 'rm -f "$partial" "$sums"' EXIT
trap 'exit 1' HUP INT TERM

printf 'Downloading %s from %s\\n' "$name" "$origin"
download "$origin${CONNECT_CLIENT_CHECKSUMS_PATH}" "$sums" || fail "cannot download the checksums from $origin."
expected=$(awk -v name="$name" '$2 == name { print $1 }' "$sums")
[ -n "$expected" ] || fail "$origin offers no $name."
download "$origin${CONNECT_CLIENT_DOWNLOAD_PREFIX}/$name" "$partial" || fail "cannot download $name from $origin."
[ "$(sha256 "$partial")" = "$expected" ] || fail "the download does not match its SHA-256 checksum; nothing was installed."
chmod 755 "$partial"
mv -f "$partial" "$target"
installed=$("$target" version) || fail "the installed $target does not run on this computer."
printf 'Installed aiqsa-connect %s as %s\\n' "$installed" "$target"

command=$target
case ":\${PATH:-}:" in
  *":$install_dir:"*) command=aiqsa-connect ;;
  *)
    printf '\\n%s is not on your PATH. Add it in your shell profile, for example:\\n' "$install_dir"
    # shellcheck disable=SC2016
    printf '  export PATH="%s:$PATH"\\n' "$install_dir"
    ;;
esac

# An installed user service keeps running the previous version until it restarts.
service_file=
if [ -n "\${HOME:-}" ]; then
  config_home=\${XDG_CONFIG_HOME:-$HOME/.config}
  case "$config_home" in
    /*) ;;
    *) config_home=$HOME/.config ;;
  esac
  for file in "$config_home/systemd/user/aiqsa-connect.service" "$HOME/Library/LaunchAgents/io.github.insciqq.aiqsa-connect.plist"; do
    if [ -f "$file" ]; then
      service_file=$file
    fi
  done
fi

if [ -n "$service_file" ]; then
  printf '\\nThe aiqsa-connect service (%s) still runs the previous version.\\n' "$service_file"
  printf 'Restart the background client:\\n'
  printf '  %s service install\\n' "$command"
else
  printf '\\nNext steps:\\n'
  printf '  %s login %s       # connect this computer to your AIQSA account\\n' "$command" "$origin"
  printf '  %s setup                # check tmux and add the agent hooks\\n' "$command"
  printf '  %s service install      # keep it running in the background\\n' "$command"
fi
`;
}

export type ConnectDistributionDeps = Readonly<{
  distribution: () => Promise<ConnectClientDistribution | null>;
  /** The canonical installation origin; null when the configured base URL is unusable. */
  origin: () => string | null;
  policy: Pick<ConnectPolicyGate, "enabled">;
  /** The client version this server offers: the application version. */
  version: string;
}>;

const READ_CHUNK_BYTES = 256 * 1024;

/**
 * Exactly `size` bytes of a file, opened on the first read and closed at the
 * end or when the client goes away, so an unread response holds no handle.
 */
function fileBody(filePath: string, size: number): ReadableStream<Uint8Array> {
  let handle: FileHandle | null = null;
  let position = 0;
  async function close() {
    const current = handle;
    handle = null;
    await current?.close().catch(() => undefined);
  }
  return new ReadableStream<Uint8Array>({
    async cancel() {
      await close();
    },
    async pull(controller) {
      try {
        handle ??= await open(filePath, "r");
        const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, size - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) throw new Error("connect_client_file_truncated");
        position += bytesRead;
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, bytesRead));
        if (position >= size) {
          await close();
          controller.close();
        }
      } catch (error) {
        await close();
        controller.error(error);
      }
    }
  });
}

type FileParams = Readonly<{ params: Promise<Readonly<{ file: string }>> }>;

const PUBLIC_HEADERS = Object.freeze({ ...CONNECT_DEVICE_HEADERS, "x-content-type-options": "nosniff" });

function notFound(): Response {
  return new Response("Not found\n", {
    headers: { ...PUBLIC_HEADERS, "content-type": "text/plain; charset=utf-8" },
    status: 404
  });
}

function text(body: string): Response {
  return new Response(body, {
    headers: { ...PUBLIC_HEADERS, "content-type": "text/plain; charset=utf-8" },
    status: 200
  });
}

/**
 * The public client distribution: `/connect/install.sh`, the four
 * `/connect/download/<binary>` files, `/connect/checksums.txt` and the device
 * API manifest `/connect-api/v1/client`. They exist only while AIQSA Connect
 * is on; without built binaries they answer `connect_client_unavailable`.
 */
export function createConnectDistributionHandlers(deps: ConnectDistributionDeps) {
  /** The distribution, or the refusal: hidden (public paths) or `connect_disabled` (device API) while off. */
  async function load(disabled: () => Response): Promise<ConnectClientDistribution | Response> {
    try {
      if (!(await deps.policy.enabled())) return disabled();
    } catch (error) {
      logConnect({ action: "retry", code: "connect_policy_unavailable", error, outcome: "failed", stage: "read" });
      return connectUnavailable(PUBLIC_HEADERS);
    }
    return (await deps.distribution()) ?? connectRefusal("connect_client_unavailable", PUBLIC_HEADERS);
  }

  return {
    async checksums(): Promise<Response> {
      const loaded = await load(notFound);
      return loaded instanceof Response ? loaded : text(loaded.sums);
    },

    async download(_request: Request, context: FileParams): Promise<Response> {
      const { file } = await context.params;
      if (!BINARY_NAMES.has(file)) return notFound();
      const loaded = await load(notFound);
      if (loaded instanceof Response) return loaded;
      const entry = loaded.files.find((candidate) => candidate.name === file)!;
      const body = fileBody(entry.path, entry.size);
      return new Response(body, {
        headers: {
          ...PUBLIC_HEADERS,
          "content-disposition": `attachment; filename="${entry.name}"`,
          "content-length": String(entry.size),
          "content-type": "application/octet-stream"
        },
        status: 200
      });
    },

    async installScript(): Promise<Response> {
      const loaded = await load(notFound);
      if (loaded instanceof Response) return loaded;
      const origin = deps.origin();
      return origin ? text(connectInstallScript(origin)) : connectUnavailable(PUBLIC_HEADERS);
    },

    async manifest(): Promise<Response> {
      const loaded = await load(() => connectRefusal("connect_disabled", PUBLIC_HEADERS));
      if (loaded instanceof Response) return loaded;
      const manifest = connectClientManifestSchema.parse({
        targets: loaded.files.map(({ arch, os, sha256, size }) => ({ arch, os, sha256, size })),
        version: deps.version
      });
      return Response.json(manifest, { headers: PUBLIC_HEADERS });
    }
  };
}
