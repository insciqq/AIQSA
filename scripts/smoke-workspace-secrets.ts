import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { Sandbox, SandboxNotFoundError } from "microsandbox";
import { workspaceSandboxName, type WorkspaceMcpToolName } from "@/lib/domain/workspace";
import { workspaceSecretAssetPath } from "@/lib/contracts/workspaceSecrets";
import { getWorkspaceConfig } from "@/lib/server/workspace/config";
import { MicrosandboxWorkspaceRuntime } from "@/lib/server/workspace/microsandboxRuntime";
import { RemoteWorkspaceRuntime } from "@/lib/server/workspace/remoteRuntime";
import { WorkspaceRuntimeError } from "@/lib/server/workspace/runtime";
import type { AcceptedWorkspaceSecret } from "@/lib/server/workspace/secrets/store";
import { validateWorkspaceSshKey } from "@/lib/server/workspace/secrets/sshKey";

// Sole command of an isolated KVM runner. No application/provider credentials.
// Fixture services live in a tracked guest execution, on guest loopback only.
if (process.env.AIQSA_WORKSPACE_LIVE_E2E !== "DISPOSABLE") throw new Error("workspace_live_e2e_requires_disposable_confirmation");

const token = randomBytes(32).toString("hex");
const environment = { ...process.env, NODE_ENV: "production" as const, AIQSA_TEST_MODE: "0", AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "0",
  AIQSA_WORKSPACE_CPUS: "2", AIQSA_WORKSPACE_MEMORY_MIB: "4096", AIQSA_WORKSPACE_DISK_MIB: "10240",
  AIQSA_WORKSPACE_RUNNER_TOKEN: token, AIQSA_WORKSPACE_SECRET_HOST_CANARY: "synthetic-host-only" };
const config = getWorkspaceConfig({ ...environment, AIQSA_WORKSPACE_RUNNER_TOKEN: undefined, AIQSA_WORKSPACE_RUNNER_URL: undefined });
const local = new MicrosandboxWorkspaceRuntime(config);
let child: ChildProcess | null = null;
let sessionId = `ws_${randomBytes(20).toString("hex")}`;
let sandboxName = workspaceSandboxName(sessionId);
let runtimeSandboxId: string | null = null;
let phase = "runner_start";
let ordinal = 0;
let generation = 1;
let runId = "secrets_fixture_1";
const operation = () => ({ generation, owner: `run:${runId}` });
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function stopReceiver() {
  if (!child) return;
  const current = child; child = null;
  if (current.exitCode === null && current.signalCode === null) {
    const exited = once(current, "exit");
    current.kill("SIGKILL");
    await exited;
  }
}

async function startReceiver(): Promise<RemoteWorkspaceRuntime> {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const receiverEnv = { ...environment, AIQSA_WORKSPACE_RUNNER_HOST: "127.0.0.1", AIQSA_WORKSPACE_RUNNER_PORT: String(port) };
  const receiver = spawn(process.execPath, ["--import", "tsx", "scripts/workspace-runner.ts"], { env: receiverEnv, stdio: "ignore" });
  child = receiver;
  const remote = new RemoteWorkspaceRuntime(getWorkspaceConfig({ ...receiverEnv, AIQSA_WORKSPACE_RUNNER_URL: `http://127.0.0.1:${port}` }));
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    assert.equal(receiver.exitCode, null);
    const health = await remote.health(AbortSignal.timeout(1_000));
    if (health.state === "ready") { assert.equal(health.imageReady, true); return remote; }
    await delay(200);
  }
  throw new Error("workspace_receiver_start_timeout");
}

async function call(remote: RemoteWorkspaceRuntime, originalName: WorkspaceMcpToolName, args: Record<string, unknown>) {
  assert.ok(runtimeSandboxId);
  // Assert command success below while retaining bounded output for content-free diagnostics.
  const argumentsWithOutput = originalName === "sandbox_shell" || originalName === "sandbox_exec"
    ? { ...args, treatNonZeroAsError: false } : args;
  const result = await remote.callBoundTool({ arguments: argumentsWithOutput, modelRunId: runId, modelRunToolCallId: `secrets_call_${ordinal++}`,
    operation: operation(), originalName, runtimeSandboxId, sessionId, signal: AbortSignal.timeout(130_000) });
  let parsed: { ok: boolean; data: Record<string, unknown> } | null = null;
  try { parsed = JSON.parse(result.content[0]?.text ?? "null"); } catch { /* A tool failure may contain only a plain-text error. */ }
  if (result.status !== "complete" || !parsed?.ok || parsed.data?.success === false) {
    const stderr = JSON.stringify(result.content);
    process.stderr.write(JSON.stringify({ phase, commandFailed: true, structuredResult: parsed !== null,
      exitCode: result.exitCode,
      publicKeyDenied: /Permission denied \(publickey\)/u.test(stderr),
      hostKeyRejected: /Host key verification failed/u.test(stderr),
      connectionRefused: /Connection refused/u.test(stderr),
      remoteExecRejected: /exec request failed/u.test(stderr),
      connectionClosed: /Connection closed|Connection reset/u.test(stderr),
      pythonAssertion: /AssertionError/u.test(stderr),
      keyLoadFailed: /Load key|error in libcrypto/u.test(stderr),
      errorMarkers: ["configuration", "option", "algorithm", "signature", "negotiate", "packet", "protocol", "unpack", "index-pack", "permission", "denied", "permitted", "resolve", "refused", "closed", "reset", "timeout", "directory", "exists", "ownership", "identity", "publickey", "authentication", "hostkey", "channel", "remote", "repository", "corrupt", "fatal", "invalid", "bad"]
        .filter((marker) => stderr.toLowerCase().includes(marker)) }) + "\n");
  }
  assert.equal(result.status, "complete");
  assert.equal(result.truncated, false);
  assert.ok(parsed?.ok);
  return parsed.data;
}
async function python(remote: RemoteWorkspaceRuntime, source: string) {
  const result = await call(remote, "sandbox_exec", { command: "/usr/bin/python3", args: ["-c", source], treatNonZeroAsError: true });
  assert.equal(result.success, true);
}
async function ensure(remote: RemoteWorkspaceRuntime) {
  runtimeSandboxId = (await remote.ensureSession({ cpus: config.cpus, diskMiB: config.diskMiB, imageRef: config.imageRef,
    internetEnabled: true, memoryMiB: config.memoryMiB, operation: operation(), runtimeSandboxId, sandboxName, sessionId,
    signal: AbortSignal.timeout(120_000) })).runtimeSandboxId;
}
function sync(remote: RemoteWorkspaceRuntime, secrets: readonly AcceptedWorkspaceSecret[]) {
  assert.ok(runtimeSandboxId);
  return remote.syncPersonalSecrets({ modelRunId: runId, operation: operation(), runtimeSandboxId, sessionId, secrets, signal: AbortSignal.timeout(110_000) });
}

async function main() {
  let remote: RemoteWorkspaceRuntime | null = null;
  let owned = false;
  try {
    remote = await startReceiver();
    assert.equal((await Sandbox.list()).sandboxes.length, 0, "workspace_secret_smoke_requires_an_empty_runner");
    owned = true;
    phase = "guest_start";
    await ensure(remote);
    await remote.loadBoundTools({ runtimeSandboxId: runtimeSandboxId!, sessionId, operation: operation() });
    const pairs = [0, 1].map(() => generateKeyPairSync("rsa", { modulusLength: 2048 }));
    const privateKeys = pairs.map(({ privateKey }, index) => privateKey.export({ type: "pkcs1", format: "pem",
      ...(index === 1 ? { cipher: "aes-256-cbc", passphrase: "synthetic key passphrase" } : {}) }).toString());
    const exact = "synthetic '\"$HOME`touch /workspace/project/INJECTED`\nПривет\tvalue";
    const textToken = "synthetic-text-token", fileToken = "synthetic-file-token";
    const original = Buffer.from(`{\r\n  "token": "${fileToken}", "unicode": "Привет"\r\n}\n`);
    const secrets: AcceptedWorkspaceSecret[] = [
      ...privateKeys.map((privateKey, index): AcceptedWorkspaceSecret => ({ id: randomUUID(), versionId: randomUUID(),
        name: index ? "Work Git key" : "Personal Git key", description: "Two accounts on the same SSH host",
        value: { kind: "ssh_key", privateKey, passphrase: index ? "synthetic key passphrase" : "" } })),
      { id: randomUUID(), versionId: randomUUID(), name: "API and Basic Auth", description: "Fixture services", value: { kind: "env", entries: [
        { name: "SERVICE_TOKEN", value: "synthetic-api-token" }, { name: "BASIC_LOGIN", value: "synthetic-login" },
        { name: "BASIC_PASSWORD", value: "synthetic-password" }, { name: "EXACT_VALUE", value: exact }
      ] } },
      { id: randomUUID(), versionId: randomUUID(), name: "Website token", description: "Fixture text access", value: { kind: "text", text: textToken } },
      { id: randomUUID(), versionId: randomUUID(), name: "Credentials original", description: "Fixture JSON access", value: { kind: "file", originalName: "credentials.json", base64: original.toString("base64") } }
    ];
    phase = "key_parser";
    await validateWorkspaceSshKey(privateKeys[0]!, "");
    await validateWorkspaceSshKey(privateKeys[1]!, "synthetic key passphrase");
    assert.equal((await call(remote, "sandbox_shell", { command: "mkdir -p /workspace/tmp && ssh-keygen -q -t ed25519 -a 16 -N synthetic-ed25519-passphrase -f /workspace/tmp/ed25519-fixture", treatNonZeroAsError: true })).success, true);
    const openSsh = await call(remote, "sandbox_fs_read", { path: "/workspace/tmp/ed25519-fixture" });
    assert.equal(typeof openSsh.content, "string");
    await validateWorkspaceSshKey(String(openSsh.content), "synthetic-ed25519-passphrase");
    secrets.push({ id: randomUUID(), versionId: randomUUID(), name: "Encrypted OpenSSH key", description: "Ed25519 fixture",
      value: { kind: "ssh_key", privateKey: String(openSsh.content), passphrase: "synthetic-ed25519-passphrase" } });
    const binary = Buffer.alloc(512 * 1024, 0xa5);
    binary[0] = 0; binary[binary.length - 1] = 255;
    const binaryPaths: string[] = [];
    for (let index = 0; index < 5; index++) {
      const id = randomUUID();
      binaryPaths.push(workspaceSecretAssetPath(id, "file"));
      secrets.push({ id, versionId: randomUUID(), name: `Binary boundary ${index}`, description: "Original bytes at the supported file limit",
        value: { kind: "file", originalName: "fixture.bin", base64: binary.toString("base64") } });
    }
    phase = "secret_preparation";
    await sync(remote, secrets);
    await python(remote, `import hashlib,pathlib\nfor path in ${JSON.stringify(binaryPaths)}:\n data=pathlib.Path(path).read_bytes()\n assert len(data)==524288 and hashlib.sha256(data).hexdigest()==${JSON.stringify(createHash("sha256").update(binary).digest("hex"))}`);
    await python(remote, `import subprocess\nresult=subprocess.run(['ssh-keygen','-y','-P','','-f',${JSON.stringify(workspaceSecretAssetPath(secrets[5]!.id, "ssh_key"))}],capture_output=True,timeout=5)\nassert result.returncode==0 and result.stdout.startswith(b'ssh-ed25519 ')`);
    const envProof = `import base64,os,pathlib\nassert base64.b64encode(os.environ['EXACT_VALUE'].encode()).decode() == ${JSON.stringify(Buffer.from(exact).toString("base64"))}\nassert 'AIQSA_WORKSPACE_SECRET_HOST_CANARY' not in os.environ\nassert not pathlib.Path('/workspace/project/INJECTED').exists()`;
    await python(remote, envProof);
    assert.equal((await call(remote, "sandbox_shell", { command: `python3 <<'PY'\n${envProof}\nPY`, treatNonZeroAsError: true })).success, true);
    const filePath = workspaceSecretAssetPath(secrets[4]!.id, "file");
    await python(remote, `import hashlib,pathlib\nassert hashlib.sha256(pathlib.Path(${JSON.stringify(filePath)}).read_bytes()).hexdigest() == ${JSON.stringify(createHash("sha256").update(original).digest("hex"))}\nassert ${JSON.stringify(textToken)} in pathlib.Path('/workspace/SECRETS.md').read_text()`);

    phase = "fixture_install";
    assert.equal((await call(remote, "sandbox_shell", { command: "mkdir -p /workspace/tmp/access-fixture && npm install --ignore-scripts --omit=optional --no-audit --no-fund --prefix /workspace/tmp/access-fixture ssh2@1.17.0", treatNonZeroAsError: true })).success, true);
    await call(remote, "sandbox_fs_write", { path: "/workspace/tmp/access-fixture/server.cjs", content: await readFile("tests/fixtures/workspace-access-service.cjs", "utf8") });
    await call(remote, "sandbox_fs_write", { path: "/workspace/tmp/access-fixture/fixture.json", content: JSON.stringify({
      keys: pairs.map(({ publicKey }) => publicKey.export({ format: "jwk" })), token: "synthetic-api-token",
      login: "synthetic-login", password: "synthetic-password", textToken, fileToken
    }) });
    const server = await call(remote, "sandbox_exec_start", { command: "cd /workspace/tmp/access-fixture && exec node server.cjs", shell: true,
      env: { AIQSA_WORKSPACE_ACCESS_FIXTURE: "DISPOSABLE" } });
    assert.equal(typeof server.execSessionId, "string");
    await python(remote, "import pathlib,time\np=pathlib.Path('/workspace/tmp/access-fixture/ready')\nend=time.monotonic()+15\nwhile not p.exists() and time.monotonic()<end: time.sleep(.05)\nassert p.exists()");

    phase = "git_personal_access";
    const workKeyPath = workspaceSecretAssetPath(secrets[1]!.id, "ssh_key");
    assert.equal((await call(remote, "sandbox_shell", { command: "git clone --quiet ssh://git@127.0.0.1:22022/personal.git /workspace/project/personal", treatNonZeroAsError: true })).success, true);
    phase = "git_work_access";
    assert.equal((await call(remote, "sandbox_shell", { command: "git clone --quiet ssh://git@127.0.0.1:22022/work.git /workspace/project/work", treatNonZeroAsError: true,
      env: { GIT_SSH_COMMAND: `ssh -F /dev/null -i ${workKeyPath} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new` } })).success, true);
    phase = "http_access";
    await python(remote, `import base64,json,os,pathlib,re,urllib.request\nguide=pathlib.Path('/workspace/SECRETS.md').read_text()\nmatch=re.search(r'Text secret:\\n(\x60{3,})\\n(.*?)\\n\\1',guide,re.S)\nassert match is not None\ntext_access=match.group(2)\nroot='http://127.0.0.1:28080'\ncredentials=[('/token','Bearer '+os.environ['SERVICE_TOKEN']),('/basic','Basic '+base64.b64encode((os.environ['BASIC_LOGIN']+':'+os.environ['BASIC_PASSWORD']).encode()).decode()),('/file','Bearer '+json.loads(pathlib.Path(${JSON.stringify(filePath)}).read_bytes())['token']),('/text','Bearer '+text_access)]\nassert ${JSON.stringify(textToken)} in pathlib.Path('/workspace/SECRETS.md').read_text()\nfor path,authorization in credentials:\n with urllib.request.urlopen(urllib.request.Request(root+path,headers={'Authorization':authorization}),timeout=5) as response: assert json.load(response)=={'ok':True}\nfor name in ['personal','work']: assert pathlib.Path('/workspace/project/'+name+'/README.txt').read_text()=='synthetic '+name+' repository\\n'`);

    phase = "receiver_restart";
    const originalRuntime = runtimeSandboxId;
    await stopReceiver();
    remote = await startReceiver();
    assert.equal((await Sandbox.get(sandboxName)).status, "running");
    await python(remote, envProof);
    assert.equal(runtimeSandboxId, originalRuntime);

    phase = "stop_quiescence";
    const delayed = await call(remote, "sandbox_exec_start", { command: "sleep 8; printf late > /workspace/project/after-stop.txt", shell: true });
    const terminations = await remote.terminateExecutions({ operation: operation(), runtimeSandboxId: runtimeSandboxId!, sessionId,
      executions: [server, delayed].map((execution) => ({ modelRunId: runId, runtimeExecSessionId: String(execution.execSessionId) })) });
    assert.equal(terminations.length, 2);
    await remote.stopSession({ operation: operation(), runtimeSandboxId, sessionId });
    assert.equal((await Sandbox.get(sandboxName)).status, "stopped");
    generation++; runId = "secrets_fixture_2";
    await ensure(remote);
    await sync(remote, []);
    await assert.rejects(remote.syncPersonalSecrets({ modelRunId: "secrets_fixture_1", operation: { generation: 1, owner: "run:secrets_fixture_1" },
      runtimeSandboxId: runtimeSandboxId!, sessionId, secrets }), (error: unknown) => error instanceof WorkspaceRuntimeError && error.code === "workspace_operation_stale");
    await delay(9_000);
    await python(remote, "import os,pathlib\nassert 'EXACT_VALUE' not in os.environ\nassert not pathlib.Path('/workspace/project/after-stop.txt').exists()\nassert not list(pathlib.Path('/workspace/secrets/ssh').iterdir())\nassert not list(pathlib.Path('/workspace/secrets/files').iterdir())\nassert 'IdentityFile' not in pathlib.Path('/workspace/secrets/ssh_config').read_text()\nassert 'synthetic-text-token' not in pathlib.Path('/workspace/SECRETS.md').read_text()");

    phase = "archive_boundary";
    await sync(remote, secrets);
    const archive = await remote.createProjectArchive({ operation: operation(), runtimeSandboxId: runtimeSandboxId!, sessionId });
    const tar = gunzipSync(Buffer.from(await new Response(archive.body).arrayBuffer()));
    assert.equal(tar.includes(Buffer.from("SECRETS.md")), false);
    assert.equal(tar.includes(Buffer.from(textToken)), false);
    assert.equal(tar.includes(Buffer.from("PRIVATE KEY")), false);
    assert.equal(tar.includes(Buffer.from(fileToken)), false);
    assert.equal(tar.includes(Buffer.from("synthetic personal repository")), true);
    const outputs = await remote.collectOutputs({ modelRunId: runId, outputDirectory: `/workspace/output/${runId}`, operation: operation(), runtimeSandboxId: runtimeSandboxId!, sessionId });
    assert.equal(outputs.length, 0);

    phase = "reset_restore";
    const previousName = sandboxName;
    await remote.removeSession({ operation: operation(), runtimeSandboxId, sessionId });
    await assert.rejects(Sandbox.get(previousName), (error: unknown) => error instanceof SandboxNotFoundError);
    sessionId = `ws_${randomBytes(20).toString("hex")}`; sandboxName = workspaceSandboxName(sessionId);
    runtimeSandboxId = null; generation = 1; runId = "secrets_fixture_reset";
    await ensure(remote); await sync(remote, secrets);
    await python(remote, envProof);
    await python(remote, `import hashlib,pathlib\nassert hashlib.sha256(pathlib.Path(${JSON.stringify(filePath)}).read_bytes()).hexdigest()==${JSON.stringify(createHash("sha256").update(original).digest("hex"))}\nassert not pathlib.Path('/workspace/project/personal').exists()`);
    phase = "cleanup";
    await remote.removeSession({ operation: operation(), runtimeSandboxId, sessionId });
    runtimeSandboxId = null;
    assert.equal((await Sandbox.list()).sandboxes.length, 0);
    process.stdout.write(JSON.stringify({ status: "passed", gitAccounts: 2, protectedKey: true, api: true, basicAuth: true,
      openSshEd25519: true, exactEnv: true, originalBytes: true, receiverRestart: true, stop: true, resetRestore: true, archiveBoundary: true, cleanup: true }) + "\n");
  } finally {
    if (owned && runtimeSandboxId) await local.removeSession({ runtimeSandboxId, sessionId }).catch(() => undefined);
    await stopReceiver();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(JSON.stringify({ status: "failed", phase, code: error instanceof WorkspaceRuntimeError ? error.code : "workspace_secret_proof_failed" }) + "\n");
  process.exitCode = 1;
});
