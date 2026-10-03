import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Hermetic harness: every run gets PATH = fake tools + a toolbox of symlinked
// host utilities, so no real docker, ss, curl or sysctl is ever reached.
const script = path.resolve("aiqsa.sh");
const template = readFileSync(path.resolve(".env.example"), "utf8");
const toolNames = ["awk", "basename", "bash", "cat", "chmod", "cp", "cut", "date", "dirname", "env", "git", "grep",
  "head", "id", "ln", "ls", "mkdir", "mktemp", "mv", "od", "openssl", "readlink", "rm", "rmdir", "sed", "sh", "sha256sum",
  "sleep", "sort", "stat", "tail", "tee", "timeout", "touch", "tr", "uname", "wc"];
const generatedKeys = ["AIQSA_INITIAL_ADMIN_PASSWORD", "AIQSA_AUTH_SESSION_SECRET", "AIQSA_ENCRYPTION_KEY",
  "AIQSA_MEMORY_FINGERPRINT_KEYRING", "AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY", "AIQSA_POSTGRES_PASSWORD",
  "AIQSA_S3_SECRET_ACCESS_KEY"];
const directories: string[] = [];
let toolbox = "";

interface Rule { match: string; exit?: number; stdout?: string; stderr?: string; delay?: number }
interface Result { status: number | null; stdout: string; stderr: string; output: string }

const escape = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll("\t", "\\t");
const secretOf = (key: string) => `${key.toLowerCase()}-Value$(touch pwned)'"0123456789`;
const activeLine = /^[A-Z][A-Z0-9_]*=/u;
const values = (body: string) => Object.fromEntries(body.split("\n").filter((line) => activeLine.test(line))
  .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
const readyRows = "app|running|healthy|0|c1\nmigrate-bootstrap|exited||0|c2\npostgres|running|healthy|0|c3\n";

const fakeDocker = `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "$args" >> "$FAKE_STATE/docker.log"
for arg in "$@"; do [[ $arg == *restore-override.yaml ]] && cp "$arg" "$FAKE_STATE/restore-override.yaml"; done
# Simulates an interrupt of the CLI while this docker command runs.
[[ -n \${FAKE_TERM_ON:-} && $args =~ \${FAKE_TERM_ON} ]] && kill -TERM "$PPID"
while IFS=$'\\x1f' read -r pattern code out err delay; do
  [[ -n $pattern && $args =~ $pattern ]] || continue
  [[ -n $delay ]] && sleep "$delay"
  printf '%b' "$out"
  printf '%b' "$err" >&2
  exit "$code"
done < "$FAKE_STATE/docker.rules"
exit 0
`;

class Fixture {
  readonly root = mkdtempSync(path.join(os.tmpdir(), "aiqsa-cli-test-"));
  readonly fake = path.join(this.root, "fake-bin");
  readonly state = path.join(this.root, "fake-state");
  readonly proc = path.join(this.root, "proc");
  readonly kvm = path.join(this.root, "kvm");
  readonly project: string;
  rules: Rule[] = [];
  env: Record<string, string> = {};

  constructor(project?: string) {
    this.project = project ?? path.join(this.root, "project");
    directories.push(this.root);
    for (const directory of [this.fake, this.state, this.proc, this.project, path.join(this.root, "home"), path.join(this.root, "tmp"), path.join(this.root, "docker-root")]) {
      mkdirSync(directory, { recursive: true });
    }
    if (!project) {
      copyFileSync(script, this.file("aiqsa.sh"));
      writeFileSync(this.file(".env.example"), template);
      writeFileSync(this.file("compose.yaml"), "services: {}\n");
      writeFileSync(this.file("package.json"), '{\n  "version": "0.3.0"\n}\n');
    }
    writeFileSync(path.join(this.proc, "meminfo"), "MemTotal:       16384000 kB\n");
    writeFileSync(path.join(this.proc, "cpuinfo"), "processor\t: 0\nflags\t\t: fpu vmx\nprocessor\t: 1\nflags\t\t: fpu vmx\n");
    this.tool("docker", fakeDocker);
    this.tool("sysctl", 'echo "${FAKE_MAX_MAP_COUNT:-262144}"');
    this.tool("timedatectl", 'echo "${FAKE_NTP:-yes}"');
    this.tool("ss", 'cat "$FAKE_STATE/ss.out" 2>/dev/null || true');
    this.tool("df", 'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/x 1 1 %s 1%% /\\n" "${FAKE_DF_AVAILABLE:-100000000}"');
    this.tool("systemd-detect-virt", 'echo "${FAKE_VIRT:-none}"; [ "${FAKE_VIRT:-none}" != none ]');
  }

  tool(name: string, body: string): void {
    writeFileSync(path.join(this.fake, name), body.startsWith("#!") ? body : `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  removeTool(name: string): void { rmSync(path.join(this.fake, name)); }

  file(name: string): string { return path.join(this.project, name); }

  kvmDevice(mode: number): void {
    writeFileSync(this.kvm, "");
    chmodSync(this.kvm, mode);
  }

  writeEnv(overrides: Record<string, string | null> = {}, mode = 0o600): string {
    const settings: Record<string, string | null> = { AIQSA_INITIAL_ADMIN_EMAIL: "admin@example.com", ...overrides };
    for (const key of generatedKeys) if (!(key in settings)) settings[key] = secretOf(key);
    const seen = new Set<string>();
    const lines = template.split("\n").flatMap((line) => {
      const key = line.slice(0, line.indexOf("="));
      if (!activeLine.test(line) || !(key in settings)) return [line];
      seen.add(key);
      return settings[key] === null ? [] : [`${key}=${settings[key]}`];
    });
    for (const [key, value] of Object.entries(settings)) if (!seen.has(key) && value !== null) lines.splice(-1, 0, `${key}=${value}`);
    const body = lines.join("\n");
    writeFileSync(this.file(".env"), body);
    chmodSync(this.file(".env"), mode);
    return body;
  }

  run(args: string[], env: Record<string, string> = {}, executable = this.file("aiqsa.sh")): Result {
    const defaults: Rule[] = [
      { match: "^version ", stdout: "27.3.1\n" },
      { match: "^compose version --short", stdout: "2.29.7\n" },
      { match: "^info --format", stdout: `${path.join(this.root, "docker-root")}\n` },
      { match: " config --format json", stdout: '{\n  "name": "aiqsa-test",\n  "services": {}\n}\n' },
      { match: " ps -a --format", stdout: readyRows },
      { match: "^inspect --format", stdout: "0\n" },
      { match: " exec -T app node", stdout: "200\n" },
      { match: " exec -T workspace-runner node", stdout: "200 ready \n" },
      { match: " port app 3000", exit: 1 },
      { match: "^volume inspect", exit: 1 }
    ];
    writeFileSync(path.join(this.state, "docker.rules"), [...this.rules, ...defaults]
      .map((rule) => [rule.match, rule.exit ?? 0, escape(rule.stdout ?? ""), escape(rule.stderr ?? ""), rule.delay ?? ""].join("\x1f")).join("\n") + "\n");
    const result = spawnSync("bash", [executable, ...args], {
      cwd: this.project,
      encoding: "utf8",
      input: "",
      env: {
        PATH: `${this.fake}${path.delimiter}${toolbox}`,
        HOME: path.join(this.root, "home"),
        TMPDIR: path.join(this.root, "tmp"),
        LANG: "C",
        NODE_ENV: "test",
        FAKE_STATE: this.state,
        AIQSA_CLI_KVM_DEVICE: this.kvm,
        AIQSA_CLI_PROC_ROOT: this.proc,
        ...this.env,
        ...env
      }
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
  }

  get dockerLog(): string {
    const log = path.join(this.state, "docker.log");
    return existsSync(log) ? readFileSync(log, "utf8") : "";
  }
}

function expectNoSecrets(output: string, body: string): void {
  for (const [key, value] of Object.entries(values(body))) {
    if (/SECRET|PASSWORD|KEY|TOKEN/u.test(key) && value) expect(output).not.toContain(value);
  }
}

beforeAll(() => {
  toolbox = mkdtempSync(path.join(os.tmpdir(), "aiqsa-cli-toolbox-"));
  for (const name of toolNames) {
    const found = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    if (found.startsWith("/")) symlinkSync(found, path.join(toolbox, name));
  }
});

afterAll(() => rmSync(toolbox, { recursive: true, force: true }));

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("aiqsa.sh lint", () => {
  it("parses with bash -n", () => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
  });

  const shellcheck = spawnSync("bash", ["-c", "command -v shellcheck"], { encoding: "utf8" }).stdout.trim();
  it.skipIf(!shellcheck)("passes shellcheck when it is installed", () => {
    const result = spawnSync(shellcheck, [script], { encoding: "utf8" });
    expect(result.stdout + result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("explains itself under sh and rejects bad usage with exit 2", () => {
    const fixture = new Fixture();
    const sh = spawnSync("sh", [fixture.file("aiqsa.sh"), "help"], { encoding: "utf8" });
    expect(sh.status).toBe(3);
    expect(sh.stderr).toContain("requires bash 4");
    expect(fixture.run(["help"]).stdout).toContain("Exit codes:");
    for (const args of [["bogus"], ["doctor", "--to", "v1.0.0"], ["up", "--timeout", "0"], ["upgrade", "--to", "latest"],
      ["backup", "--to", "v1.0.0"], ["restore"], ["restore", "a", "b"], ["backup", "extra"]]) {
      expect(fixture.run(args).status, args.join(" ")).toBe(2);
    }
    expect(fixture.dockerLog).toBe("");
  });
});

describe("configure", () => {
  it("generates separate private secrets without printing them and otherwise copies the template", () => {
    const fixture = new Fixture();
    const result = fixture.run(["configure", "--yes", "--workspace", "off"]);
    expect(result.status).toBe(0);
    const body = readFileSync(fixture.file(".env"), "utf8");
    const parsed = values(body);
    const hexKeys = ["AIQSA_INITIAL_ADMIN_PASSWORD", "AIQSA_AUTH_SESSION_SECRET", "AIQSA_POSTGRES_PASSWORD", "AIQSA_S3_SECRET_ACCESS_KEY"];
    for (const key of hexKeys) expect(parsed[key]).toMatch(/^[a-f0-9]{64}$/u);
    const base64Keys = ["AIQSA_ENCRYPTION_KEY", "AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY"];
    for (const key of base64Keys) expect(Buffer.from(parsed[key], "base64")).toHaveLength(32);
    expect(parsed.AIQSA_MEMORY_FINGERPRINT_KEYRING).toMatch(/^current=v1,v1=[A-Za-z0-9+/]{43}=$/u);
    const secrets = [...hexKeys, ...base64Keys, "AIQSA_MEMORY_FINGERPRINT_KEYRING"].map((key) => parsed[key]);
    expect(new Set(secrets).size).toBe(secrets.length);
    for (const secret of secrets) expect(result.output).not.toContain(secret);
    expect(statSync(fixture.file(".env")).mode & 0o777).toBe(0o600);
    expect(parsed.AIQSA_INITIAL_ADMIN_EMAIL).toBe("");
    expect(body.replace(new RegExp(`^(${generatedKeys.join("|")})=.*$`, "gmu"), "$1=")).toBe(template);
    expect(result.stderr).toContain("an unsupported configuration, only for disposable test installations");
    expect(readdirSync(fixture.project).filter((name) => name.startsWith(".env.tmp."))).toEqual([]);
  });

  it("preserves an existing installation byte for byte, also when --workspace is given", () => {
    const fixture = new Fixture();
    const existing = "OPERATOR_CONFIGURATION=preserve-this\n";
    writeFileSync(fixture.file(".env"), existing);
    fixture.kvmDevice(0o660);
    const result = fixture.run(["configure", "--workspace", "on"]);
    expect(result.status).toBe(1);
    expect(readFileSync(fixture.file(".env"), "utf8")).toBe(existing);
    expect(result.output).not.toContain("preserve-this");
    expect(result.stderr).toContain("--workspace had no effect");
    expect(result.stderr).toContain(`AIQSA_KVM_GID=${statSync(fixture.kvm).gid}`);
  });

  it.each([
    ["fails", "exit 42"],
    ["prints malformed output", "echo short"]
  ])("does not publish a partial configuration if entropy generation %s", (_name, body) => {
    const fixture = new Fixture();
    fixture.tool("openssl", body);
    fixture.kvmDevice(0o660);
    const result = fixture.run(["configure", "--yes"]);
    expect(result.status).toBe(1);
    expect(readdirSync(fixture.project)).not.toContain(".env");
    expect(readdirSync(fixture.project).filter((name) => name.startsWith(".env.tmp."))).toEqual([]);
  });

  it("fills operator values from flags and validates them", () => {
    const fixture = new Fixture();
    for (const args of [["--base-url", "https://chat.example.com/path"], ["--base-url", "ftp://chat.example.com"],
      ["--admin-email", "not-an-email"], ["--workspace", "maybe"], ["--workspace", "auto"]]) {
      expect(fixture.run(["configure", "--yes", ...args]).status, args.join(" ")).toBe(2);
      expect(existsSync(fixture.file(".env"))).toBe(false);
    }
    fixture.kvmDevice(0o660);
    const result = fixture.run(["configure", "--yes", "--base-url=https://chat.example.com", "--admin-email", "admin@example.com"]);
    expect(result.status).toBe(0);
    const parsed = values(readFileSync(fixture.file(".env"), "utf8"));
    expect(parsed.AIQSA_APP_BASE_URL).toBe("https://chat.example.com");
    expect(parsed.AIQSA_INITIAL_ADMIN_EMAIL).toBe("admin@example.com");
  });

  it("enables Workspace by default when KVM is usable and keeps the runner token private", () => {
    const fixture = new Fixture();
    fixture.kvmDevice(0o660);
    const result = fixture.run(["configure", "--yes"]);
    expect(result.status).toBe(0);
    const body = readFileSync(fixture.file(".env"), "utf8");
    const parsed = values(body);
    expect(parsed.COMPOSE_PROFILES).toBe("workspace");
    expect(parsed.AIQSA_WORKSPACE_RUNNER_URL).toBe("http://workspace-runner:4310");
    expect(parsed.AIQSA_KVM_GID).toBe(String(statSync(fixture.kvm).gid));
    expect(parsed.AIQSA_WORKSPACE_RUNNER_TOKEN).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.values(parsed).filter((value) => value === parsed.AIQSA_WORKSPACE_RUNNER_TOKEN)).toHaveLength(1);
    expectNoSecrets(result.output, body);
  });

  it.each([
    ["off (test-only) with a usable device", ["--workspace", "off"], 0o660, 0],
    ["by default without a device", [], null, 4],
    ["by default with a group-inaccessible device", [], 0o600, 4],
    ["on without a device", ["--workspace", "on"], null, 4]
  ])("Workspace %s", (_name, args, mode, status) => {
    const fixture = new Fixture();
    if (mode !== null) fixture.kvmDevice(mode);
    const result = fixture.run(["configure", "--yes", ...args]);
    expect(result.status).toBe(status);
    if (status === 0) {
      expect(readFileSync(fixture.file(".env"), "utf8")).toContain("# COMPOSE_PROFILES=workspace\n");
    } else {
      expect(existsSync(fixture.file(".env"))).toBe(false);
      expect(result.stderr).toContain("AIQSA needs KVM for Workspace");
      expect(result.stderr).toContain("are not supported");
      expect(result.stderr).toContain("nested virtualization");
    }
  });
});

describe("doctor", () => {
  it("passes a healthy host and stack without printing secrets", () => {
    const fixture = new Fixture();
    const body = fixture.writeEnv();
    const result = fixture.run(["doctor"]);
    expect(result.status).toBe(0);
    for (const line of ["PASS docker: Engine 27.3.1", "PASS compose: Compose 2.29.7", "PASS vm.max_map_count: 262144",
      "PASS memory: 15.6 GiB", "PASS cpus: 2", "PASS disk:", "PASS time:", "PASS port: 127.0.0.1:3000 is free",
      "INFO kvm: Workspace unavailable", "WARN workspace: disabled: unsupported configuration", "PASS required-keys",
      "PASS compose-config", "PASS app: healthy",
      "PASS migrate-bootstrap: completed", "PASS readiness", "PASS storage: storage marker valid", "0 failed"]) {
      expect(result.stdout).toContain(line);
    }
    expectNoSecrets(result.output, body);
    expect(fixture.dockerLog).toContain("run --rm --no-deps -T storage-init status");
    expect(fixture.dockerLog).not.toMatch(/ (up|down|pull|stop|rm) /u);
  });

  const hostCases: Array<{ name: string; setup: (fixture: Fixture) => void; expected: RegExp[]; status: number }> = [
    { name: "low vm.max_map_count", status: 4, setup: (f) => { f.env.FAKE_MAX_MAP_COUNT = "65530"; },
      expected: [/FAIL vm\.max_map_count: 65530/u, /sudo sysctl -w vm\.max_map_count=262144/u, /\/etc\/sysctl\.d\/99-aiqsa\.conf/u] },
    { name: "docker socket permission", status: 4, setup: (f) => {
      f.rules.push({ match: "^version ", exit: 1, stderr: "permission denied while trying to connect to the Docker daemon socket\n" });
    }, expected: [/FAIL docker: permission denied on the Docker socket/u, /usermod -aG docker/u] },
    { name: "daemon not running", status: 4, setup: (f) => {
      f.rules.push({ match: "^version ", exit: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n" });
    }, expected: [/FAIL docker: the Docker daemon is not running/u, /systemctl enable --now docker/u] },
    { name: "docker not installed", status: 4, setup: (f) => f.removeTool("docker"),
      expected: [/FAIL docker: Docker is not installed/u, /docs\.docker\.com\/engine\/install/u] },
    { name: "unsupported engine", status: 0, setup: (f) => { f.rules.push({ match: "^version ", stdout: "24.0.7\n" }); },
      expected: [/WARN docker: Engine 24\.0\.7 is unsupported/u] },
    { name: "engine below the technical floor", status: 4, setup: (f) => { f.rules.push({ match: "^version ", stdout: "19.03.15\n" }); },
      expected: [/FAIL docker: Engine 19\.03\.15 is too old/u] },
    { name: "old compose", status: 4, setup: (f) => { f.rules.push({ match: "^compose version", stdout: "v2.20.2\n" }); },
      expected: [/FAIL compose: Compose 2\.20\.2 is older than 2\.29\.7/u] },
    { name: "compose v1 only", status: 4, setup: (f) => {
      f.rules.push({ match: "^compose version", exit: 1, stderr: "docker: 'compose' is not a docker command.\n" });
      f.tool("docker-compose", "echo 1.29.2");
    }, expected: [/FAIL compose: only Compose v1/u] },
    { name: "too little memory", status: 4, setup: (f) => writeFileSync(path.join(f.proc, "meminfo"), "MemTotal: 6000000 kB\n"),
      expected: [/FAIL memory: 5\.7 GiB; at least 8 GB is required/u] },
    { name: "nominal 8 GB host", status: 0, setup: (f) => writeFileSync(path.join(f.proc, "meminfo"), "MemTotal: 8000000 kB\n"),
      expected: [/WARN memory: 7\.6 GiB; 16 GB is recommended/u] },
    { name: "small Docker root", status: 0, setup: (f) => { f.env.FAKE_DF_AVAILABLE = "10000000"; },
      expected: [/WARN disk: 10 GB free in .*docker-root; 50 GB is recommended/u] },
    { name: "unsynchronised clock", status: 0, setup: (f) => { f.env.FAKE_NTP = "no"; },
      expected: [/WARN time: the clock is not NTP synchronised/u, /timedatectl set-ntp true/u] },
    { name: "busy foreign port", status: 4, setup: (f) => writeFileSync(path.join(f.state, "ss.out"), "LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*\n"),
      expected: [/FAIL port: 127\.0\.0\.1:3000 is already in use by another process/u, /AIQSA_PORT/u] },
    { name: "port served by this project's app", status: 0, setup: (f) => {
      writeFileSync(path.join(f.state, "ss.out"), "LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:*\n");
      f.rules.push({ match: " port app 3000", stdout: "127.0.0.1:3000\n" });
    }, expected: [/PASS port: 127\.0\.0\.1:3000 is served by this project's app container/u] },
    { name: "listener on another address", status: 0, setup: (f) => writeFileSync(path.join(f.state, "ss.out"), "LISTEN 0 4096 10.0.0.5:3000 0.0.0.0:*\n"),
      expected: [/PASS port: 127\.0\.0\.1:3000 is free/u] },
    { name: "virtual machine without nested virtualization", status: 4, setup: (f) => {
      rmSync(f.kvm, { force: true });
      f.env.FAKE_VIRT = "kvm";
      writeFileSync(path.join(f.proc, "cpuinfo"), "processor\t: 0\nflags\t\t: fpu hypervisor\n");
    }, expected: [/FAIL kvm: AIQSA needs KVM for Workspace, but .* virtual machine \(kvm\) without nested virtualization/u,
      /installations without a usable .* are not supported/u, /WARN cpus: 1/u] }
  ];

  it.each(hostCases)("host check: $name", ({ setup, expected, status }) => {
    const fixture = new Fixture();
    fixture.kvmDevice(0o660);
    setup(fixture);
    const result = fixture.run(["doctor", "--host-only"]);
    for (const pattern of expected) expect(result.stdout).toMatch(pattern);
    expect(result.status).toBe(status);
  });

  it("skips the time check silently when timedatectl is unavailable", () => {
    const fixture = new Fixture();
    fixture.removeTool("timedatectl");
    fixture.kvmDevice(0o660);
    const result = fixture.run(["doctor", "--host-only"]);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("time:");
  });

  const configCases: Array<{ name: string; setup: (fixture: Fixture) => void; expected: RegExp[]; status: number }> = [
    { name: "loose .env permissions", status: 0, setup: (f) => { f.writeEnv({}, 0o644); },
      expected: [/WARN env-file: mode 644/u, /chmod 600 \.env/u] },
    { name: "missing secret", status: 4, setup: (f) => { f.writeEnv({ AIQSA_ENCRYPTION_KEY: null }); },
      expected: [/FAIL required-keys: empty or missing: AIQSA_ENCRYPTION_KEY/u] },
    { name: "incomplete Workspace block", status: 4, setup: (f) => { f.writeEnv({ COMPOSE_PROFILES: "workspace" }); },
      expected: [/FAIL workspace: incomplete Workspace block; missing: AIQSA_WORKSPACE_RUNNER_URL AIQSA_WORKSPACE_RUNNER_TOKEN AIQSA_KVM_GID/u,
        /FAIL kvm: Workspace is enabled but/u] },
    { name: "KVM group mismatch", status: 4, setup: (f) => {
      f.kvmDevice(0o660);
      f.writeEnv({ COMPOSE_PROFILES: "workspace", AIQSA_WORKSPACE_RUNNER_URL: "http://workspace-runner:4310",
        AIQSA_WORKSPACE_RUNNER_TOKEN: secretOf("TOKEN"), AIQSA_KVM_GID: "424242" });
    }, expected: [/PASS workspace: enabled/u, /FAIL kvm-gid: AIQSA_KVM_GID is '424242' but/u] },
    { name: "legacy storage-migration profile", status: 4, setup: (f) => { f.writeEnv({ COMPOSE_PROFILES: "storage-migration" }); },
      expected: [/FAIL legacy-storage: COMPOSE_PROFILES contains storage-migration/u, /UPGRADING_FROM_MINIO\.md/u] },
    { name: "public URL behind a loopback bind", status: 0, setup: (f) => { f.writeEnv({ AIQSA_APP_BASE_URL: "https://chat.example.com" }); },
      expected: [/INFO base-url: https:\/\/chat\.example\.com with a loopback bind: a reverse proxy is expected/u,
        /AIQSA_TRUST_PROXY_HEADERS=1/u, /upstream read timeout/u] },
    { name: "local URL on another port", status: 0, setup: (f) => { f.writeEnv({ AIQSA_APP_BASE_URL: "http://localhost:8080" }); },
      expected: [/WARN base-url: http:\/\/localhost:8080 uses port 8080 but the application listens on 3000/u, /Set AIQSA_PORT=8080/u] },
    { name: "invalid Compose configuration", status: 4, setup: (f) => {
      f.writeEnv();
      f.rules.push({ match: " config --quiet", exit: 1, stderr: "required variable AIQSA_X is missing a value\n" });
    }, expected: [/FAIL compose-config: docker compose config rejected the configuration: required variable AIQSA_X/u] },
    { name: "restarting worker and readiness failure", status: 4, setup: (f) => {
      f.writeEnv();
      f.rules.push({ match: " ps -a --format", stdout: `${readyRows}memory-worker|running||0|c9\n` },
        { match: "^inspect --format .* c9", stdout: "3\n" }, { match: " exec -T app node", stdout: "503\n" });
    }, expected: [/WARN memory-worker: running, restarted 3 time\(s\)/u, /FAIL readiness: \/api\/health\/ready answered 503/u] },
    { name: "fresh storage", status: 0, setup: (f) => {
      f.writeEnv();
      f.rules.push({ match: "storage-init status", exit: 3 });
    }, expected: [/WARN storage: no storage marker yet/u] },
    { name: "foreign storage", status: 4, setup: (f) => {
      f.writeEnv();
      f.rules.push({ match: "storage-init status", exit: 4 });
    }, expected: [/FAIL storage: the storage marker is invalid or belongs to another installation/u] },
    { name: "fresh external storage", status: 0, setup: (f) => {
      f.writeEnv({ AIQSA_S3_ENDPOINT: "https://s3.example.com" });
      f.rules.push({ match: "storage-init status", exit: 3 });
    }, expected: [/INFO storage: no storage marker on the external endpoint yet/u] },
    { name: "unreachable storage", status: 4, setup: (f) => {
      f.writeEnv();
      f.rules.push({ match: "storage-init status", exit: 1, stdout: "storage-init: refused ECONNREFUSED\n" });
    }, expected: [/FAIL storage: object storage is unreachable \(ECONNREFUSED\)/u] },
    { name: "failing storage status", status: 4, setup: (f) => {
      f.writeEnv();
      f.rules.push({ match: "storage-init status", exit: 1, stdout: "storage-init: refused storage_configuration_incomplete\n" });
    }, expected: [/ {2}storage-init: refused storage_configuration_incomplete\nFAIL storage: storage-init status failed \(see the output above\)/u] },
    { name: "unavailable Workspace runner", status: 0, setup: (f) => {
      f.kvmDevice(0o660);
      f.writeEnv({ COMPOSE_PROFILES: "workspace", AIQSA_WORKSPACE_RUNNER_URL: "http://workspace-runner:4310",
        AIQSA_WORKSPACE_RUNNER_TOKEN: secretOf("TOKEN"), AIQSA_KVM_GID: String(statSync(f.kvm).gid) });
      f.rules.push({ match: " ps -a --format", stdout: `${readyRows}workspace-runner|running|healthy|0|c8\n` },
        { match: " exec -T workspace-runner node", stdout: "200 unavailable workspace_runtime_unavailable\n" });
    }, expected: [/WARN workspace-runner: runtime unavailable \(workspace_runtime_unavailable\); Workspace is unavailable/u] }
  ];

  it.each(configCases)("configuration and stack check: $name", ({ setup, expected, status }) => {
    const fixture = new Fixture();
    setup(fixture);
    const result = fixture.run(["doctor"]);
    for (const pattern of expected) expect(result.stdout).toMatch(pattern);
    expect(result.status).toBe(status);
    expectNoSecrets(result.output, readFileSync(fixture.file(".env"), "utf8"));
  });

  it("lists ToolHive leftovers with exact removal commands and stays quiet without them", () => {
    const fixture = new Fixture();
    fixture.writeEnv();
    const clean = fixture.run(["doctor", "--stack-only"]);
    expect(clean.status).toBe(0);
    expect(clean.stdout).not.toContain("toolhive");
    fixture.rules.push(
      { match: "^ps -aq --filter label=com.docker.compose.project=aiqsa-test --filter label=com.docker.compose.service=toolhive-runtime", stdout: "c99\n" },
      { match: "^volume inspect aiqsa-test_toolhive_data", stdout: "[]\n" },
      { match: "^ps -a --format \\{\\{\\.Names\\}\\}", stdout: "aiqsa-test-app-1\naiqsa-0123456789abcdef-0123456789abcdefghijklmn\n" },
      { match: "^images --format", stdout: "postgres:18\ntoolhivelocal/example-mcp:1.0.0\n" }
    );
    const result = fixture.run(["doctor", "--stack-only"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("WARN toolhive-leftovers: local MCP servers were removed");
    expect(result.stdout).toContain("./aiqsa.sh up   # --remove-orphans removes the toolhive-runtime container");
    expect(result.stdout).toContain("docker volume rm aiqsa-test_toolhive_data");
    expect(result.stdout).toContain("docker rm -f aiqsa-0123456789abcdef-0123456789abcdefghijklmn\n");
    expect(result.stdout).not.toContain("rm -f aiqsa-test-app-1");
    expect(result.stdout).toContain("docker image rm toolhivelocal/example-mcp:1.0.0\n");
    expect(fixture.dockerLog).not.toMatch(/^(rm|volume rm|image rm) /mu);
  });

  it("reads .env strictly: quotes, CRLF, spaces, export and shell metacharacters", () => {
    const fixture = new Fixture();
    const secret = "pa$$ word`id`$(touch pwned)\"'";
    const body = fixture.writeEnv({
      AIQSA_APP_BASE_URL: '"http://localhost:3000"',
      AIQSA_INITIAL_ADMIN_EMAIL: "'admin@example.com'   # operator",
      AIQSA_POSTGRES_PASSWORD: `'${secret}'`
    }).replace("AIQSA_AUTH_SESSION_SECRET=", "export AIQSA_AUTH_SESSION_SECRET = ").replaceAll("\n", "\r\n");
    writeFileSync(fixture.file(".env"), body);
    const result = fixture.run(["doctor", "--verbose"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS base-url: http://localhost:3000\n");
    expect(result.stdout).toContain("PASS required-keys: all set");
    expect(result.stderr).toContain("+ docker compose --project-directory");
    expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain("\r");
    expect(existsSync(fixture.file("pwned"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("explains an unreadable .env instead of a raw bash error", () => {
    const fixture = new Fixture();
    fixture.writeEnv({}, 0o000);
    for (const command of ["doctor", "up"]) {
      const result = fixture.run([command]);
      expect(result.status, command).toBe(1);
      expect(result.stderr).toMatch(/^\.env is not readable by \S+ \(owner \S+, mode 0\)\.$/mu);
      expect(result.stderr).toContain('sudo chown "$(id -un)": .env');
      expect(result.output).not.toMatch(/Permission denied|line \d+:/u);
    }
    expect(fixture.dockerLog).not.toContain(" up -d");
  });
});

describe("up and install", () => {
  it("starts the stack, waits with the timeout and prints no secret", () => {
    const fixture = new Fixture();
    const body = fixture.writeEnv();
    const result = fixture.run(["up", "--timeout", "42"]);
    expect(result.status).toBe(0);
    expect(fixture.dockerLog).toContain("up -d --remove-orphans --wait --wait-timeout 42");
    expect(result.stdout).toContain("AIQSA is ready at http://localhost:3000.");
    expect(result.stdout).toContain("Administrator: admin@example.com; the initial password is AIQSA_INITIAL_ADMIN_PASSWORD in .env.");
    expectNoSecrets(result.output, body);
  });

  it("exits 5 with a masked bootstrap log tail and the local MCP removal remedy", () => {
    const fixture = new Fixture();
    const keyring = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg=";
    const body = fixture.writeEnv({ AIQSA_MEMORY_FINGERPRINT_KEYRING: `current=v1,v1=${keyring}` });
    const password = values(body).AIQSA_POSTGRES_PASSWORD;
    fixture.rules.push(
      { match: " up -d ", exit: 1, stderr: "service \"migrate-bootstrap\" didn't complete successfully: exit 1\n" },
      { match: " ps -a --format", stdout: "migrate-bootstrap|exited||1|c2\npostgres|running|healthy|0|c3\napp|created||0|c1\n" },
      { match: " logs --no-color --tail 60 migrate-bootstrap", stdout: `connecting with ${password}\nkey ${keyring}\nError: local_mcp_removal_acknowledgement_required\n` }
    );
    const result = fixture.run(["up"]);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain("Last 60 log lines of migrate-bootstrap:");
    expect(result.stderr).toContain("connecting with ***");
    expect(result.stderr).toContain("key ***");
    expect(result.stderr).toContain("set AIQSA_ACCEPT_LOCAL_MCP_REMOVAL=1 in .env, then rerun ./aiqsa.sh up");
    expectNoSecrets(result.output, body);
  });

  it("exits 5 on a wait timeout and shows the service that is still starting", () => {
    const fixture = new Fixture();
    fixture.writeEnv();
    // Compose lists ps rows by container name: the created app comes first.
    fixture.rules.push(
      { match: " up -d ", exit: 1, stderr: "timeout waiting for services\n" },
      { match: " ps -a --format", stdout: "app|created||0|c1\nmigrate-bootstrap|exited||0|c2\nopensearch|running|starting|0|c4\n" }
    );
    const result = fixture.run(["up", "--timeout", "5"]);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain("Last 60 log lines of opensearch:");
    expect(fixture.dockerLog).toContain("logs --no-color --tail 60 opensearch");
    expect(fixture.dockerLog).not.toContain("logs --no-color --tail 60 app");
  });

  it("bounds the whole start, including the wait for migrate-bootstrap, by --timeout", () => {
    const fixture = new Fixture();
    fixture.writeEnv();
    fixture.rules.push(
      { match: " up -d ", delay: 30 },
      { match: " ps -a --format", stdout: "app|created||0|c1\nmigrate-bootstrap|running||0|c2\n" }
    );
    const started = Date.now();
    const result = fixture.run(["up", "--timeout", "1"]);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.status).toBe(5);
    expect(result.stderr).toContain("did not finish within 1 s");
    expect(result.stderr).toContain("Last 60 log lines of migrate-bootstrap:");
  });

  it.each([
    ["an exited service before a still starting one", "app|created||0|c1\nmemory-worker|exited||137|c5\nopensearch|running|starting|0|c4\n", "memory-worker"],
    ["a running one-shot before a created service", "app|created||0|c1\nmigrate-bootstrap|running||0|c2\n", "migrate-bootstrap"],
    ["a created service when nothing else is pending", "app|created||0|c1\npostgres|running|healthy|0|c3\n", "app"]
  ])("diagnoses a timeout by rank: %s", (_name, rows, service) => {
    const fixture = new Fixture();
    fixture.writeEnv();
    fixture.rules.push({ match: " up -d ", exit: 1, stderr: "timeout\n" }, { match: " ps -a --format", stdout: rows });
    expect(fixture.run(["up"]).status).toBe(5);
    expect(fixture.dockerLog.match(/logs --no-color --tail 60 (\S+)/u)?.[1]).toBe(service);
  });

  it.each([
    ["a busy foreign port", (f: Fixture) => writeFileSync(path.join(f.state, "ss.out"), "LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:*\n"), 4],
    ["Workspace enabled without KVM", (f: Fixture) => {
      f.writeEnv({ COMPOSE_PROFILES: "workspace", AIQSA_WORKSPACE_RUNNER_URL: "http://workspace-runner:4310",
        AIQSA_WORKSPACE_RUNNER_TOKEN: secretOf("TOKEN"), AIQSA_KVM_GID: "993" });
    }, 4],
    ["a missing .env", (f: Fixture) => rmSync(f.file(".env")), 1]
  ])("refuses to start with %s before docker compose up", (_name, setup, status) => {
    const fixture = new Fixture();
    fixture.writeEnv();
    setup(fixture);
    expect(fixture.run(["up"]).status).toBe(status);
    expect(fixture.dockerLog).not.toContain(" up -d");
  });

  it("installs from scratch with Workspace, then preserves .env on a second install", () => {
    const fixture = new Fixture();
    fixture.kvmDevice(0o660);
    fixture.rules.push({ match: " ps -a --format", stdout: `${readyRows}workspace-runner|running|healthy|0|c8\n` });
    const first = fixture.run(["install", "--yes", "--base-url", "http://localhost:3000", "--admin-email", "admin@example.com"]);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain(`Workspace enabled (KVM group ${statSync(fixture.kvm).gid}).`);
    const body = readFileSync(fixture.file(".env"), "utf8");
    expect(statSync(fixture.file(".env")).mode & 0o777).toBe(0o600);
    expect(first.stdout).toContain("AIQSA is ready at http://localhost:3000.");
    expect(first.stdout).toContain("Open http://localhost:3000 and sign in as admin@example.com");
    expectNoSecrets(first.output, body);
    const second = fixture.run(["install", "--yes"]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain(".env already exists; its configuration and secrets were preserved.");
    expect(readFileSync(fixture.file(".env"), "utf8")).toBe(body);
    expect(fixture.dockerLog.match(/ up -d --remove-orphans --wait/gu)).toHaveLength(2);
  });

  it("exits 5, not 4, when the post-start check fails after a successful start", () => {
    const fixture = new Fixture();
    fixture.writeEnv();
    fixture.rules.push({ match: "storage-init status", exit: 4 });
    const result = fixture.run(["install", "--yes"]);
    expect(result.status).toBe(5);
    expect(result.stdout).toContain("FAIL storage: the storage marker is invalid");
    expect(result.stderr).toContain("The stack started but the checks above failed");
    expect(fixture.dockerLog).toContain(" up -d --remove-orphans --wait");
  });

  it("treats a Workspace runner that is not ready as a warning during and after the start", () => {
    const fixture = new Fixture();
    fixture.kvmDevice(0o660);
    const body = fixture.writeEnv({ COMPOSE_PROFILES: "workspace", AIQSA_WORKSPACE_RUNNER_URL: "http://workspace-runner:4310",
      AIQSA_WORKSPACE_RUNNER_TOKEN: secretOf("TOKEN"), AIQSA_KVM_GID: String(statSync(fixture.kvm).gid) });
    fixture.rules.push({ match: " ps -a --format", stdout: `${readyRows}workspace-runner|running|healthy|0|c8\n` },
      { match: " exec -T workspace-runner node", stdout: "200 unavailable workspace_runtime_unavailable\n" });
    const result = fixture.run(["install", "--yes"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Workspace is not ready; chat and other features work.");
    expect(result.stdout.match(/WARN workspace-runner: runtime unavailable/gu)).toHaveLength(2);
    expect(result.stdout).not.toContain("FAIL");
    expectNoSecrets(result.output, body);
  });

  it.each([
    ["without an administrator email", ["install", "--yes"], 2],
    ["without KVM", ["install", "--yes", "--admin-email", "admin@example.com"], 4],
    ["without KVM even with --skip-preflight", ["install", "--yes", "--admin-email", "admin@example.com", "--skip-preflight"], 4],
    ["with the configure-only --workspace off", ["install", "--yes", "--admin-email", "admin@example.com", "--workspace", "off"], 2]
  ])("refuses to install %s before any change", (_name, args, status) => {
    const fixture = new Fixture();
    const result = fixture.run(args);
    expect(result.status).toBe(status);
    expect(existsSync(fixture.file(".env"))).toBe(false);
    expect(fixture.dockerLog).not.toMatch(/ (up|config) /u);
    if (status === 4) {
      expect(result.output).toContain("are not supported");
      expect(result.output).not.toContain("rerun with --skip-preflight");
    }
  });
});

describe("upgrade", () => {
  const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_NOSYSTEM: "1" };

  // origin.git holds v0.2.0 and v0.3.0; the installation is a clone at v0.3.0.
  function repository(): { fixture: Fixture; git: (cwd: string, ...args: string[]) => string; seed: string } {
    const root = mkdtempSync(path.join(os.tmpdir(), "aiqsa-cli-upgrade-"));
    const fixture = new Fixture(path.join(root, "install"));
    directories.push(root);
    const env = { ...process.env, ...identity, HOME: path.join(fixture.root, "home") };
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
    const seed = path.join(root, "seed");
    mkdirSync(seed);
    git(seed, "init", "--quiet", "--initial-branch=main");
    copyFileSync(script, path.join(seed, "aiqsa.sh"));
    writeFileSync(path.join(seed, ".env.example"), template);
    writeFileSync(path.join(seed, "compose.yaml"), "services: {}\n");
    writeFileSync(path.join(seed, ".gitignore"), ".env\n");
    for (const version of ["0.2.0", "0.3.0"]) {
      writeFileSync(path.join(seed, "package.json"), `{\n  "version": "${version}"\n}\n`);
      git(seed, "add", ".");
      git(seed, "commit", "--quiet", "-m", `release ${version}`);
      git(seed, "tag", `v${version}`);
    }
    git(root, "clone", "--quiet", "--bare", seed, "origin.git");
    git(seed, "remote", "add", "origin", path.join(root, "origin.git"));
    git(root, "clone", "--quiet", path.join(root, "origin.git"), "install");
    return { fixture, git, seed };
  }

  function release(seed: string, git: (cwd: string, ...args: string[]) => string): void {
    writeFileSync(path.join(seed, "package.json"), '{\n  "version": "0.3.1"\n}\n');
    writeFileSync(path.join(seed, ".env.example"), `${template}AIQSA_NEW_SETTING=on\n# AIQSA_COMMENTED_SETTING=1\n`);
    git(seed, "commit", "--quiet", "-am", "release 0.3.1");
    git(seed, "push", "--quiet", "origin", "main");
  }

  // Publishes tagged releases after the installation's v0.3.0.
  function tagReleases(seed: string, git: (cwd: string, ...args: string[]) => string, ...versions: string[]): void {
    for (const version of versions) {
      writeFileSync(path.join(seed, "package.json"), `{\n  "version": "${version}"\n}\n`);
      git(seed, "commit", "--quiet", "-am", `release ${version}`);
      git(seed, "tag", `v${version}`);
    }
    git(seed, "push", "--quiet", "--tags", "origin", "main");
  }

  function expectUnchanged(fixture: Fixture, git: (cwd: string, ...args: string[]) => string, before: string): void {
    expect(git(fixture.project, "rev-parse", "HEAD")).toBe(before);
    expect(fixture.dockerLog).not.toMatch(/ (pull|up|down)( |$)/mu);
  }

  it.each([
    ["a dirty tree", (f: Fixture) => writeFileSync(f.file("compose.yaml"), "services: {x: {}}\n"), [], /local changes to tracked files/u],
    ["the legacy storage profile", (f: Fixture) => f.writeEnv({ COMPOSE_PROFILES: "storage-migration" }), [], /storage-migration/u],
    ["a MinIO-era volume without a valid marker", (f: Fixture) => {
      f.rules.push({ match: "^volume inspect aiqsa-test_minio_data", exit: 0 }, { match: "storage-init status", exit: 3 });
    }, [], /aiqsa-test_minio_data volume exists/u],
    ["a missing backup confirmation", () => undefined, null, /backup was not confirmed\.\nRerun with --backup to create one first/u],
    ["a downgrade", () => undefined, ["--to", "v0.2.0"], /older than the current 0\.3\.0/u],
    ["an unknown tag", () => undefined, ["--to", "v9.9.9"], /tag v9\.9\.9 does not exist/u]
  ])("refuses %s without moving the checkout or replacing containers", (_name, setup, extra, message) => {
    const { fixture, git, seed } = repository();
    release(seed, git);
    fixture.writeEnv();
    setup(fixture);
    const before = git(fixture.project, "rev-parse", "HEAD");
    const result = fixture.run(["upgrade", ...(extra === null ? [] : ["--backup-confirmed", ...extra])]);
    expect(result.stderr).toMatch(message);
    expect(result.status).toBe(6);
    expect(git(fixture.project, "rev-parse", "HEAD")).toBe(before);
    expect(fixture.dockerLog).not.toMatch(/ (pull|up|down)( |$)/mu);
  });

  it("stops before replacing containers when the image pull fails", () => {
    const { fixture, git, seed } = repository();
    release(seed, git);
    fixture.writeEnv();
    const before = git(fixture.project, "rev-parse", "HEAD");
    fixture.rules.push({ match: " pull ", exit: 1, stderr: "toomanyrequests: rate limit\n" });
    const result = fixture.run(["upgrade", "--backup-confirmed"]);
    expect(result.status).toBe(6);
    expect(result.stderr).toContain("no container was replaced");
    expect(result.stderr).toContain(`git checkout ${before}`);
    expect(fixture.dockerLog).toContain(" pull --quiet");
    expect(fixture.dockerLog).not.toContain(" up -d");
  });

  it("upgrades, keeps .env byte for byte and reports missing keys", () => {
    const { fixture, git, seed } = repository();
    release(seed, git);
    const body = fixture.writeEnv();
    const result = fixture.run(["upgrade", "--backup-confirmed"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Upgrading from 0.3.0 to 0.3.1. Release notes: https://github.com/insciqq/AIQSA/releases/tag/v0.3.1");
    expect(result.stderr).toContain("Keys in .env.example missing from .env: AIQSA_NEW_SETTING");
    expect(readFileSync(fixture.file(".env"), "utf8")).toBe(body);
    expect(readFileSync(fixture.file("package.json"), "utf8")).toContain("0.3.1");
    expect(fixture.dockerLog).toMatch(/ pull --quiet\n(?:.*\n)*.* up -d --remove-orphans --wait --wait-timeout 600\n/u);
    expectNoSecrets(result.output, body);
    expect(readdirSync(path.join(fixture.root, "tmp"))).toEqual([]);
  });

  it("exits 5 when the post-start check fails after the upgrade started the stack", () => {
    const { fixture, git, seed } = repository();
    release(seed, git);
    fixture.writeEnv();
    fixture.rules.push({ match: "storage-init status", exit: 4 });
    const result = fixture.run(["upgrade", "--backup-confirmed"]);
    expect(result.status).toBe(5);
    expect(fixture.dockerLog).toContain(" up -d --remove-orphans --wait");
  });

  it("refuses a detached HEAD without --to and names the flag", () => {
    const { fixture, git, seed } = repository();
    tagReleases(seed, git, "0.3.1");
    git(fixture.project, "checkout", "--quiet", "--detach", "v0.3.0");
    fixture.writeEnv();
    const before = git(fixture.project, "rev-parse", "HEAD");
    const result = fixture.run(["upgrade", "--backup-confirmed"]);
    expect(result.status).toBe(6);
    expect(result.stderr).toContain("Installations on a detached HEAD always pass the release tag: ./aiqsa.sh upgrade --to vX.Y.Z");
    expectUnchanged(fixture, git, before);
  });

  it("shows git's reason and the safe.directory remedy when git refuses the checkout", () => {
    const fixture = new Fixture();
    fixture.writeEnv();
    fixture.tool("git", [
      'if [ "$1" = --version ]; then echo "git version 2.43.0"; exit 0; fi',
      `echo "fatal: detected dubious ownership in repository at '$PWD'" >&2`,
      'echo "To add an exception for this directory, call:" >&2',
      "exit 128"
    ].join("\n"));
    const result = fixture.run(["upgrade", "--backup-confirmed"]);
    expect(result.status).toBe(6);
    expect(result.stderr).toContain("fatal: detected dubious ownership in repository at");
    expect(result.stderr).toContain(`git config --global --add safe.directory ${fixture.project}`);
    expect(result.stderr).not.toContain("is not a git checkout");
  });

  it.each([
    ["an app image pinned to the current release", { AIQSA_IMAGE: "ghcr.io/insciqq/aiqsa:0.3.0" }, {}, [],
      [/pin another release than 0\.3\.1: AIQSA_IMAGE=ghcr\.io\/insciqq\/aiqsa:0\.3\.0 \(from \.env\)/u, /^ {2}AIQSA_IMAGE=ghcr\.io\/insciqq\/aiqsa:0\.3\.1$/mu]],
    ["a minor-version pin from the process environment", {}, { AIQSA_IMAGE: "ghcr.io/insciqq/aiqsa:0.2" }, [],
      [/AIQSA_IMAGE=ghcr\.io\/insciqq\/aiqsa:0\.2 \(from the process environment\)/u, /^ {2}AIQSA_IMAGE=ghcr\.io\/insciqq\/aiqsa:0\.3\.1$/mu]],
    ["a runner image pinned to the current release", { AIQSA_WORKSPACE_RUNNER_IMAGE: "ghcr.io/insciqq/aiqsa:workspace-runner-0.3.0" }, {}, [],
      [/^ {2}AIQSA_WORKSPACE_RUNNER_IMAGE=ghcr\.io\/insciqq\/aiqsa:workspace-runner-0\.3\.1$/mu]],
    ["unpinned images on an older --to release", {}, {}, ["--to", "v0.3.1"],
      [/--to v0\.3\.1 is older than the newest release v0\.3\.2, but the images are not pinned/u,
        /Unpinned images follow the newest release/u, /^ {2}AIQSA_IMAGE=ghcr\.io\/insciqq\/aiqsa:0\.3\.1$/mu]],
    ["an explicit :latest image on an older --to release", { AIQSA_IMAGE: "ghcr.io/insciqq/aiqsa:latest" }, {}, ["--to", "v0.3.1"],
      [/^ {2}AIQSA_IMAGE=ghcr\.io\/insciqq\/aiqsa:0\.3\.1$/mu]]
  ])("refuses %s before the checkout moves", (_name, settings, environment, extra, messages) => {
    const { fixture, git, seed } = repository();
    tagReleases(seed, git, "0.3.1", "0.3.2");
    if (extra.length === 0) {
      // Without --to the branch upstream is the target: make it v0.3.1.
      git(seed, "reset", "--quiet", "--hard", "v0.3.1");
      git(seed, "push", "--quiet", "--force", "origin", "main");
    }
    fixture.writeEnv(settings);
    const before = git(fixture.project, "rev-parse", "HEAD");
    const result = fixture.run(["upgrade", "--backup-confirmed", ...extra], environment);
    for (const message of messages) expect(result.stderr).toMatch(message);
    expect(result.status).toBe(6);
    expectUnchanged(fixture, git, before);
  });

  it.each([
    ["an older --to release with a matching pin", { AIQSA_IMAGE: "ghcr.io/insciqq/aiqsa:0.3.1" }, ["--to", "v0.3.1"], "0.3.1", null],
    ["an older --to release with a matching minor pin", { AIQSA_IMAGE: "ghcr.io/insciqq/aiqsa:0.3" }, ["--to", "v0.3.1"], "0.3.1", null],
    ["unpinned images to the newest release", {}, ["--to", "v0.3.2"], "0.3.2", null],
    ["unpinned images following the branch", {}, [], "0.3.2", null],
    ["a digest pin", { AIQSA_IMAGE: "ghcr.io/insciqq/aiqsa@sha256:0123456789abcdef" }, ["--to", "v0.3.1"], "0.3.1",
      /INFO image: AIQSA_IMAGE=ghcr\.io\/insciqq\/aiqsa@sha256:0123456789abcdef \(from \.env\) is a digest or a custom image; match it to the release notes of 0\.3\.1/u],
    ["a custom registry", { AIQSA_IMAGE: "registry.example.com/aiqsa:0.2.34" }, ["--to", "v0.3.1"], "0.3.1",
      /INFO image: AIQSA_IMAGE=registry\.example\.com\/aiqsa:0\.2\.34/u]
  ])("upgrades with %s", (_name, settings, extra, version, info) => {
    const { fixture, git, seed } = repository();
    tagReleases(seed, git, "0.3.1", "0.3.2");
    fixture.writeEnv(settings);
    const result = fixture.run(["upgrade", "--backup-confirmed", ...extra]);
    expect(result.status).toBe(0);
    expect(readFileSync(fixture.file("package.json"), "utf8")).toContain(version);
    if (info) expect(result.stdout).toMatch(info);
    else expect(result.stdout).not.toContain("INFO image");
  });

  it("never appends a key that the process environment provides", () => {
    const { fixture, git, seed } = repository();
    release(seed, git);
    const routingKey = "cHJvdmlkZWQtYnktdGhlLWVudmlyb25tZW50LTAxMjM0NQ==";
    const body = fixture.writeEnv({ AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY: null });
    const result = fixture.run(["upgrade", "--backup-confirmed", "--add-missing-keys"],
      { AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY: routingKey });
    expect(result.status).toBe(0);
    const appended = readFileSync(fixture.file(".env"), "utf8").slice(body.length);
    expect(values(appended)).toEqual({ AIQSA_NEW_SETTING: "on" });
    expect(result.stdout).toContain("Keys in .env.example provided by the environment, not .env: AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY");
    expect(result.output).not.toContain(routingKey);
  });

  it("appends missing keys only with --add-missing-keys and to a pinned tag", () => {
    const { fixture, git, seed } = repository();
    release(seed, git);
    git(seed, "tag", "v0.3.1");
    git(seed, "push", "--quiet", "origin", "v0.3.1");
    const body = fixture.writeEnv({ AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY: null }).replace(/\n$/u, "");
    writeFileSync(fixture.file(".env"), body);
    const result = fixture.run(["upgrade", "--backup-confirmed", "--add-missing-keys", "--to", "v0.3.1"]);
    expect(result.status).toBe(0);
    const after = readFileSync(fixture.file(".env"), "utf8");
    expect(after.startsWith(`${body}\n`)).toBe(true);
    const appended = values(after.slice(body.length));
    expect(appended.AIQSA_NEW_SETTING).toBe("on");
    expect(Buffer.from(appended.AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY, "base64")).toHaveLength(32);
    expect(appended).not.toHaveProperty("AIQSA_COMMENTED_SETTING");
    expect(result.output).not.toContain(appended.AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY);
    expect(git(fixture.project, "describe", "--tags")).toBe("v0.3.1");
  });

  it("creates the backup with --backup after the guards and before the checkout moves", () => {
    const { fixture, git, seed } = repository();
    release(seed, git);
    const body = fixture.writeEnv();
    backupFixture(fixture);
    const result = fixture.run(["upgrade", "--backup"]);
    expect(result.status, result.stderr).toBe(0);
    expectOrdered(fixture.dockerLog, [/ pg_dump -Fc /u, / up -d --no-recreate --wait /u, / pull --quiet$/u, / up -d --remove-orphans --wait /u]);
    const [directory] = backupDirectories(fixture);
    expect(path.basename(directory)).toMatch(/-v0\.3\.0$/u);
    expect(readFileSync(path.join(directory, "env"), "utf8")).toBe(body);
    expect(readFileSync(fixture.file("package.json"), "utf8")).toContain("0.3.1");
    expectNoSecrets(result.output, body);
  });

  it.each([
    ["the backup fails", (f: Fixture) => { f.rules.unshift({ match: " pg_dump -Fc ", exit: 1 }); }, /Upgrade refused: the backup failed/u, true],
    ["the backup cannot start", (f: Fixture) => { f.env.FAKE_DF_AVAILABLE = "100"; }, /Upgrade refused: the backup could not start: not enough free space/u, false]
  ])("refuses the upgrade with exit 6 when %s, after restarting the stack", (_name, setup, message, restarted) => {
    const { fixture, git, seed } = repository();
    release(seed, git);
    fixture.writeEnv();
    backupFixture(fixture);
    setup(fixture);
    const before = git(fixture.project, "rev-parse", "HEAD");
    const result = fixture.run(["upgrade", "--backup"]);
    expect(result.stderr).toMatch(message);
    expect(result.status).toBe(6);
    expect(git(fixture.project, "rev-parse", "HEAD")).toBe(before);
    expect(fixture.dockerLog).not.toMatch(/ pull /u);
    expect(fixture.dockerLog.includes(" up -d --no-recreate --wait")).toBe(restarted);
    expect(backupDirectories(fixture)).toEqual([]);
  });

  it("rejects --backup together with --backup-confirmed", () => {
    const fixture = new Fixture();
    const result = fixture.run(["upgrade", "--backup", "--backup-confirmed"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--backup and --backup-confirmed are mutually exclusive");
  });
});

const keyringKey = (letter: string) => `${letter.repeat(43)}=`;
const keyring = `current=v2,v1=${keyringKey("A")},v2=${keyringKey("B")}`;
const latestMigration = "20261002000000_latest";
const runningRows = ["app|running|healthy|0|c1", "memory-worker|running||0|c5", "knowledge-search-worker|running||0|c6",
  "migrate-bootstrap|exited||0|c2", "storage-init|exited||0|c7", "postgres|running|healthy|0|c3",
  "opensearch|running|healthy|0|c4", "seaweedfs|running|healthy|0|c8", "minio|running|healthy|0|c9"].join("\n") + "\n";
const restartSet = "app memory-worker knowledge-search-worker postgres opensearch seaweedfs minio";

// A running installation whose schema matches the checkout's newest migration.
function backupFixture(fixture: Fixture, migrationRow = `${latestMigration}|0`): void {
  for (const name of ["20261001000000_init", latestMigration]) mkdirSync(fixture.file(`prisma/migrations/${name}`), { recursive: true });
  fixture.rules.push(
    { match: " ps -a --format \\{\\{\\.Service\\}\\} \\{\\{\\.Image", stdout: "app ghcr.io/insciqq/aiqsa:0.3.0\npostgres ghcr.io/insciqq/aiqsa-postgres:18\n" },
    { match: " ps -a --format", stdout: runningRows },
    { match: "_prisma_migrations", stdout: `${migrationRow}\n` },
    { match: "pg_database_size", stdout: "1048576\n" },
    { match: "^volume inspect aiqsa-test_seaweedfs_data", exit: 0 },
    { match: "--entrypoint du ", stdout: "2048\t/data\n" },
    { match: " pg_dump -Fc ", stdout: "PGDMP-dump" },
    { match: "--entrypoint tar .* -czf ", stdout: "objects-archive" }
  );
}

function backupDirectories(fixture: Fixture): string[] {
  const root = fixture.file("backups");
  return existsSync(root) ? readdirSync(root).map((name) => path.join(root, name)) : [];
}

// Line numbers of the first docker.log line matching each pattern, in order.
function positions(log: string, patterns: RegExp[]): number[] {
  const lines = log.split("\n");
  return patterns.map((pattern) => lines.findIndex((line) => pattern.test(line)));
}

function expectOrdered(log: string, patterns: RegExp[]): void {
  const found = positions(log, patterns);
  patterns.forEach((pattern, index) => expect(found[index], pattern.source).toBeGreaterThanOrEqual(0));
  expect([...found].sort((a, b) => a - b)).toEqual(found);
}

describe("backup", () => {
  it("stops writers, dumps, stops storage, archives, restarts the same set and writes a private verified backup", () => {
    const fixture = new Fixture();
    const body = fixture.writeEnv({ AIQSA_MEMORY_FINGERPRINT_KEYRING: keyring });
    backupFixture(fixture);
    const result = fixture.run(["backup"]);
    expect(result.status, result.stderr).toBe(0);
    expectOrdered(fixture.dockerLog, [/ stop app memory-worker knowledge-search-worker$/u, / pg_dump -Fc -U aiqsa -d aiqsa$/u,
      / stop minio seaweedfs$/u, /^run --rm --network none --user 0:0 -v aiqsa-test_seaweedfs_data:\/data:ro --entrypoint tar /u,
      / exec -T postgres pg_restore --list$/u, / --entrypoint tar .* -tzf -$/u,
      new RegExp(` up -d --no-recreate --wait --wait-timeout 600 ${restartSet}$`, "u")]);
    expect(fixture.dockerLog).not.toMatch(/ stop .*(postgres|opensearch)/u);
    const [directory] = backupDirectories(fixture);
    expect(path.basename(directory)).toMatch(/^\d{8}T\d{6}Z-v0\.3\.0$/u);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory).sort()).toEqual(["SHA256SUMS", "env", "manifest", "objects.tar.gz", "postgres.dump"]);
    for (const name of readdirSync(directory)) expect(statSync(path.join(directory, name)).mode & 0o777, name).toBe(0o600);
    expect(readFileSync(path.join(directory, "env"), "utf8")).toBe(body);
    expect(readFileSync(path.join(directory, "postgres.dump"), "utf8")).toBe("PGDMP-dump");
    const sums = readFileSync(path.join(directory, "SHA256SUMS"), "utf8");
    for (const name of ["env", "manifest", "postgres.dump", "objects.tar.gz"]) {
      const digest = createHash("sha256").update(readFileSync(path.join(directory, name))).digest("hex");
      expect(sums).toContain(`${digest}  ${name}\n`);
    }
    const manifest = readFileSync(path.join(directory, "manifest"), "utf8");
    for (const line of ["format=1", "aiqsa_version=0.3.0", "project=aiqsa-test", `migration=${latestMigration}`, "objects=bundled",
      "size.postgres.dump=10", "image.app=ghcr.io/insciqq/aiqsa:0.3.0", "memory_fingerprint_key_ids=v1,v2",
      "memory_fingerprint_current=v2", "memory_opensearch_routing_key_id=v1"]) {
      expect(manifest).toMatch(new RegExp(`^${line.replaceAll(".", "\\.")}$`, "mu"));
    }
    expectNoSecrets(manifest, body);
    expect(manifest).not.toContain(keyringKey("A"));
    expectNoSecrets(result.output, body);
    expect(result.stdout).toContain("The file env is a copy of .env and holds this installation's secrets");
    expect(result.stdout).toContain("Copy the backup to another host or medium");
  });

  it.each([
    ["pg_dump fails", { match: " pg_dump -Fc ", exit: 1, stderr: "pg_dump: error: connection lost\n" }, undefined, false],
    ["the archive fails", { match: "--entrypoint tar .* -czf ", exit: 2, stderr: "tar: write error\n" }, undefined, true],
    ["the CLI is interrupted during the dump", undefined, " pg_dump -Fc ", false]
  ])("restarts the stopped services and removes the partial backup when %s", (_name, rule, term, storageStopped) => {
    const fixture = new Fixture();
    const body = fixture.writeEnv();
    backupFixture(fixture);
    if (rule) fixture.rules.unshift(rule);
    const result = fixture.run(["backup"], term ? { FAKE_TERM_ON: term } : {});
    expect(result.status).toBe(1);
    expectOrdered(fixture.dockerLog, [/ stop app memory-worker knowledge-search-worker$/u, / pg_dump -Fc /u,
      new RegExp(` up -d --no-recreate --wait --wait-timeout 600 ${restartSet}$`, "u")]);
    expect(fixture.dockerLog.includes(" stop minio seaweedfs")).toBe(storageStopped);
    expect(fixture.dockerLog.match(/ up -d /gu)).toHaveLength(1);
    expect(backupDirectories(fixture)).toEqual([]);
    expect(result.stderr).toContain("The incomplete backup in backups/");
    expectNoSecrets(result.output, body);
  });

  it.each([
    ["low free space", (f: Fixture) => { f.env.FAKE_DF_AVAILABLE = "100"; }, /not enough free space: about 3\.7 MB is needed/u],
    ["no postgres container", (f: Fixture) => { f.rules.unshift({ match: " ps -a --format \\{\\{\\.Service\\}\\}\\|", stdout: "app|running|healthy|0|c1\n" }); },
      /has no postgres container/u],
    ["a migration mismatch", (f: Fixture) => { f.rules.unshift({ match: "_prisma_migrations", stdout: "20261001000000_init|0\n" }); },
      /database is at migration 20261001000000_init, but the newest migration of this checkout is 20261002000000_latest/u],
    ["a failed migration", (f: Fixture) => { f.rules.unshift({ match: "_prisma_migrations", stdout: `${latestMigration}|1\n` }); },
      /1 migration\(s\) are unfinished or failed/u],
    ["a non-empty target", (f: Fixture) => { mkdirSync(f.file("target")); writeFileSync(f.file("target/x"), ""); }, /target is not empty/u]
  ])("refuses %s with exit 4 before stopping anything", (_name, setup, message) => {
    const fixture = new Fixture();
    fixture.writeEnv();
    backupFixture(fixture);
    setup(fixture);
    const result = fixture.run(["backup", "--output", "target"]);
    expect(result.stderr).toMatch(message);
    expect(result.status).toBe(4);
    expect(fixture.dockerLog).not.toMatch(/ (stop|up|pg_dump) /u);
    expect(existsSync(fixture.file("target/env"))).toBe(false);
  });

  it("backs up only PostgreSQL and .env with external object storage and says so", () => {
    const fixture = new Fixture();
    const body = fixture.writeEnv({ AIQSA_S3_ENDPOINT: "https://s3.example.com" });
    backupFixture(fixture);
    const result = fixture.run(["backup", "--output", "external-backup"]);
    expect(result.status, result.stderr).toBe(0);
    const directory = fixture.file("external-backup");
    expect(readdirSync(directory).sort()).toEqual(["SHA256SUMS", "env", "manifest", "postgres.dump"]);
    expect(readFileSync(path.join(directory, "manifest"), "utf8")).toContain("objects=external\n");
    expect(fixture.dockerLog).not.toMatch(/stop minio|--entrypoint (tar|du)/u);
    expect(result.stderr).toContain("Back up the bucket with its provider in the same window");
    expect(result.stdout).toContain("Objects: external.");
    expectNoSecrets(result.output, body);
  });
});

describe("restore", () => {
  interface BackupOptions { manifest?: Record<string, string>; tamper?: boolean }

  // Writes a backup directory as `backup` would and returns its env body.
  function makeBackup(fixture: Fixture, options: BackupOptions = {}): { directory: string; body: string } {
    copyFileSync(path.resolve("compose.yaml"), fixture.file("compose.yaml"));
    const directory = path.join(fixture.root, "backup");
    mkdirSync(directory, { mode: 0o700 });
    const body = fixture.writeEnv();
    copyFileSync(fixture.file(".env"), path.join(directory, "env"));
    rmSync(fixture.file(".env"));
    const manifest = { format: "1", aiqsa_version: "0.3.0", project: "aiqsa-test", objects: "bundled", ...options.manifest };
    writeFileSync(path.join(directory, "manifest"), Object.entries(manifest).map(([key, value]) => `${key}=${value}\n`).join(""));
    writeFileSync(path.join(directory, "postgres.dump"), "PGDMP-dump");
    writeFileSync(path.join(directory, "objects.tar.gz"), "objects-archive");
    const names = ["env", "manifest", "postgres.dump", "objects.tar.gz"];
    writeFileSync(path.join(directory, "SHA256SUMS"), names.map((name) =>
      `${createHash("sha256").update(readFileSync(path.join(directory, name))).digest("hex")}  ${name}\n`).join(""));
    if (options.tamper) writeFileSync(path.join(directory, "postgres.dump"), "PGDMP-changed");
    fixture.rules.push({ match: "^volume ls -q --filter label=com.docker.compose.project=aiqsa-restore-", stdout: "aiqsa-restore-x_storage_socket\n" });
    return { directory, body };
  }

  it("restores through an isolated internal project before starting the real one", () => {
    const fixture = new Fixture();
    const { directory, body } = makeBackup(fixture);
    writeFileSync(fixture.file("subnets.yaml"), "networks: {}\n");
    const result = fixture.run(["restore", directory], { AIQSA_CLI_RESTORE_OVERRIDE: "subnets.yaml" });
    expect(result.status, result.stderr).toBe(0);
    const isolated = `-p aiqsa-restore-\\d{14} -f ${fixture.project}/compose.yaml -f \\S+/restore-override.yaml -f ${fixture.project}/subnets.yaml`;
    expectOrdered(fixture.dockerLog, [/ create postgres seaweedfs$/u,
      /^run --rm --network none --user 0:0 -i -v aiqsa-test_seaweedfs_data:\/data --entrypoint tar \S+ --numeric-owner -xzf - -C \/data$/u,
      new RegExp(`${isolated} up -d --wait --wait-timeout 600 postgres seaweedfs minio$`, "u"),
      new RegExp(`${isolated} exec -T postgres .* pg_restore --no-owner --exit-on-error -U aiqsa -d aiqsa$`, "u"),
      /-e AIQSA_RESTORE_RECONCILIATION=YES -e AIQSA_RESTORE_NETWORK_ISOLATED=YES -e AIQSA_RESTORE_POSTGRES_SERVICE=postgres -e AIQSA_RESTORE_MINIO_SERVICE=minio --entrypoint npm memory-worker run memory:restore:reconcile$/u,
      / --entrypoint npm memory-worker run knowledge:restore:reconcile$/u,
      new RegExp(`${isolated} down$`, "u"), /^volume rm aiqsa-restore-x_storage_socket$/u,
      /^compose --project-directory \S+ up -d --remove-orphans --wait /u, / storage-init status$/u]);
    expect(fixture.dockerLog).not.toMatch(/ down -v|-p aiqsa-test /u);
    expect(readFileSync(fixture.file(".env"), "utf8")).toBe(body);
    expect(statSync(fixture.file(".env")).mode & 0o777).toBe(0o600);
    const override = readFileSync(path.join(fixture.state, "restore-override.yaml"), "utf8");
    for (const network of ["default", "parser-control", "search-control", "workspace-control", "workspace-egress"]) {
      expect(override).toContain(`  ${network}:\n    internal: true\n`);
    }
    expect(override).toContain("  postgres18_data:\n    external: true\n    name: aiqsa-test_postgres18_data\n");
    expect(override).toContain("  seaweedfs_data:\n    external: true\n    name: aiqsa-test_seaweedfs_data\n");
    expect(override).not.toContain("ports");
    expect(result.stdout).toContain("Restore complete.");
    expectNoSecrets(result.output, body);
  });

  it("stops before the real project starts when reconciliation leaves duties and prints the cleanup", () => {
    const fixture = new Fixture();
    const { directory, body } = makeBackup(fixture);
    const password = values(body).AIQSA_POSTGRES_PASSWORD;
    fixture.rules.unshift({ match: "memory:restore:reconcile", exit: 1,
      stdout: `{"event":"runtime_lifecycle","code":"memory_restore_reconciliation_pending","detail":"${password}"}\n` });
    const result = fixture.run(["restore", directory]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("memory:restore:reconcile failed with memory_restore_reconciliation_pending");
    expect(result.stderr).toContain("  docker compose down -v\n  rm .env\n");
    expect(fixture.dockerLog).toMatch(/-p aiqsa-restore-\d{14} .* down$/mu);
    expect(fixture.dockerLog).not.toMatch(/knowledge:restore:reconcile|--remove-orphans|storage-init/u);
    expectNoSecrets(result.output, body);
  });

  it.each([
    ["a checksum mismatch", { tamper: true }, () => undefined, /do not match SHA256SUMS/u],
    ["another version", { manifest: { aiqsa_version: "0.2.0" } }, () => undefined, /git checkout v0\.2\.0/u],
    ["an unknown format", { manifest: { format: "9" } }, () => undefined, /backup format '9' is unknown/u],
    ["external object storage", { manifest: { objects: "external" } }, () => undefined, /uses external object storage/u],
    ["an existing .env", {}, (f: Fixture) => writeFileSync(f.file(".env"), "KEEP=1\n"), /\.env exists; restore only fills an empty installation/u],
    ["existing containers", {}, (f: Fixture) => { f.rules.unshift({ match: "^ps -aq --filter label=com.docker.compose.project=aiqsa-test$", stdout: "c1\n" }); },
      /already has containers/u],
    ["an existing volume", {}, (f: Fixture) => { f.rules.unshift({ match: "^volume inspect aiqsa-test_postgres18_data", exit: 0 }); },
      /volumes of the Compose project aiqsa-test already exist: +aiqsa-test_postgres18_data/u]
  ])("refuses %s with exit 4 before any change", (_name, options, setup, message) => {
    const fixture = new Fixture();
    const { directory } = makeBackup(fixture, options);
    setup(fixture);
    const before = existsSync(fixture.file(".env")) ? readFileSync(fixture.file(".env"), "utf8") : null;
    const result = fixture.run(["restore", directory]);
    expect(result.stderr).toMatch(message);
    expect(result.status).toBe(4);
    expect(fixture.dockerLog).not.toMatch(/ (create|up|run|exec|down) /u);
    expect(existsSync(fixture.file(".env")) ? readFileSync(fixture.file(".env"), "utf8") : null).toBe(before);
  });
});
