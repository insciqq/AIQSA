import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import {
  Image,
  Sandbox,
  SandboxNotFoundError,
  isInstalled
} from "microsandbox";
import {
  type WorkspaceMcpToolName,
  workspaceAttachmentPath,
  workspaceRunOutputDirectory,
  workspaceSandboxName,
  WORKSPACE_INBOX_INDEX_VERSION,
  WORKSPACE_MCP_TOOL_ALLOWLIST
} from "@/lib/domain/workspace";
import { getWorkspaceConfig } from "@/lib/server/workspace/config";
import { ensureBundledMicrosandboxRuntime } from "@/lib/server/workspace/microsandboxInstall";
import { MicrosandboxWorkspaceRuntime } from "@/lib/server/workspace/microsandboxRuntime";
import {
  WorkspaceRuntimeError,
  type WorkspaceRuntime,
  type WorkspaceToolResult
} from "@/lib/server/workspace/runtime";

if (process.env.AIQSA_WORKSPACE_LIVE_E2E !== "DISPOSABLE") {
  throw new Error("workspace_live_e2e_requires_disposable_confirmation");
}

const config = getWorkspaceConfig({
  ...process.env,
  AIQSA_TEST_MODE: "0",
  AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "0",
  AIQSA_WORKSPACE_RUNNER_TOKEN: undefined,
  AIQSA_WORKSPACE_RUNNER_URL: undefined,
  NODE_ENV: "production"
});
const runtime = new MicrosandboxWorkspaceRuntime(config);
const prefix = `live-${randomUUID()}`;
const onlineSessionId = `${prefix}-on`;
const offlineSessionId = `${prefix}-off`;
const onlineSandboxName = workspaceSandboxName(onlineSessionId);
const offlineSandboxName = workspaceSandboxName(offlineSessionId);
let onlineRuntimeId: string | null = null;
let offlineRuntimeId: string | null = null;
let toolCallSequence = 0;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function stream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    }
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function resultData<T>(result: WorkspaceToolResult): T {
  assert.equal(result.status, "complete", result.content[0]?.text ?? "workspace tool failed");
  assert.equal(result.truncated, false);
  const parsed = JSON.parse(result.content[0]?.text ?? "null") as {
    data?: unknown;
    ok?: unknown;
  };
  assert.equal(parsed.ok, true);
  assert.notEqual(parsed.data, undefined);
  return parsed.data as T;
}

async function call<T = Record<string, unknown>>(
  sessionId: string,
  runtimeSandboxId: string,
  modelRunId: string,
  originalName: WorkspaceMcpToolName,
  args: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  toolCallSequence += 1;
  const result = await runtime.callBoundTool({
    arguments: args,
    modelRunId,
    modelRunToolCallId: `${modelRunId}-call-${toolCallSequence}`,
    originalName,
    runtimeSandboxId,
    sessionId,
    ...(signal ? { signal } : {})
  });
  return resultData<T>(result);
}

async function ensureImage(): Promise<void> {
  await ensureBundledMicrosandboxRuntime();
  assert.equal(isInstalled(), true, "pinned Microsandbox runtime is not installed");
  await Sandbox.list();
  try {
    await Image.get(config.imageRef);
    return;
  } catch {
    const archive = process.env.AIQSA_WORKSPACE_IMAGE_ARCHIVE?.trim();
    if (!archive) throw new Error("workspace_live_image_archive_required");
    await access(archive);
    await Image.load(archive, { tag: config.imageRef });
    await Image.get(config.imageRef);
  }
}

function tarContains(bytes: Uint8Array, expected: string): boolean {
  for (let offset = 0; offset + 512 <= bytes.byteLength;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) return false;
    const name = Buffer.from(header.subarray(0, 100))
      .toString("utf8")
      .replace(/\0.*$/u, "");
    const sizeText = Buffer.from(header.subarray(124, 136))
      .toString("ascii")
      .replace(/\0.*$/u, "")
      .trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (name === expected || name === `./${expected}`) return true;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return false;
}

async function absent(name: string): Promise<void> {
  await assert.rejects(
    Sandbox.get(name),
    (error: unknown) => error instanceof SandboxNotFoundError
  );
}

async function cleanup(): Promise<void> {
  await runtime.removeSession({
    runtimeSandboxId: onlineRuntimeId,
    sessionId: onlineSessionId
  }).catch(() => undefined);
  await runtime.removeSession({
    runtimeSandboxId: offlineRuntimeId,
    sessionId: offlineSessionId
  }).catch(() => undefined);
}

async function main(): Promise<void> {
try {
  await ensureImage();
  const health = await runtime.health();
  assert.deepEqual(health, {
    imageReady: true,
    mcpVersion: "0.6.16",
    runtimeVersion: "0.6.16",
    state: "ready",
    virtualizationReady: true
  });

  const online = await runtime.ensureSession({
    cpus: config.cpus,
    diskMiB: config.diskMiB,
    imageRef: config.imageRef,
    internetEnabled: true,
    memoryMiB: config.memoryMiB,
    runtimeSandboxId: null,
    sandboxName: onlineSandboxName,
    sessionId: onlineSessionId
  });
  onlineRuntimeId = online.runtimeSandboxId;
  const catalog = await runtime.loadBoundTools({
    runtimeSandboxId: onlineRuntimeId,
    sessionId: onlineSessionId
  });
  assert.deepEqual(
    catalog.tools.map((tool) => tool.originalName),
    WORKSPACE_MCP_TOOL_ALLOWLIST
  );

  const messageId = `${prefix}-message`;
  const text = Buffer.from("AIQSA live text attachment\n", "utf8");
  const binary = Buffer.from(Array.from({ length: 4_096 }, (_, index) => index % 251));
  const tinyZip = Buffer.from(
    "UEsDBBQAAAAAAAAAIQDtsuv+JQAAACUAAAAKAAAAcmVzdWx0LnR4dEFJUVNBIGRldGVybWluaXN0aWMgd29ya3NwYWNlIHJlc3VsdApQSwECFAMUAAAAAAAAACEA7bLr/iUAAAAlAAAACgAAAAAAAAAAAAAApIEAAAAAcmVzdWx0LnR4dFBLBQYAAAAAAQABADgAAABNAAAAAAA=",
    "base64"
  );
  const staged = [
    { bytes: text, id: `${prefix}-text`, kind: "document" as const, mime: "text/plain", name: "notes.txt" },
    { bytes: binary, id: `${prefix}-binary`, kind: "file" as const, mime: "application/octet-stream", name: "unknown.bin" },
    { bytes: tinyZip, id: `${prefix}-archive`, kind: "file" as const, mime: "application/zip", name: "sample.zip" }
  ];
  await runtime.stageAttachments({
    attachments: staged.map((attachment) => ({
      attachmentId: attachment.id,
      body: stream(attachment.bytes),
      byteSize: attachment.bytes.byteLength,
      checksum: sha256(attachment.bytes),
      kind: attachment.kind,
      messageId,
      mimeType: attachment.mime,
      originalName: attachment.name,
      sandboxPath: workspaceAttachmentPath({
        attachmentId: attachment.id,
        messageId,
        originalName: attachment.name
      })
    })),
    inboxIndex: {
      attachments: staged.map((attachment) => ({
        attachmentId: attachment.id,
        byteSize: attachment.bytes.byteLength,
        checksum: sha256(attachment.bytes),
        mimeType: attachment.mime,
        originalName: attachment.name,
        sandboxPath: workspaceAttachmentPath({
          attachmentId: attachment.id,
          messageId,
          originalName: attachment.name
        })
      })),
      version: WORKSPACE_INBOX_INDEX_VERSION
    },
    manifests: [{
      body: {
        attachments: staged.map((attachment) => ({
          attachmentId: attachment.id,
          byteSize: attachment.bytes.byteLength,
          checksum: sha256(attachment.bytes),
          mimeType: attachment.mime,
          originalName: attachment.name,
          sandboxPath: workspaceAttachmentPath({
            attachmentId: attachment.id,
            messageId,
            originalName: attachment.name
          })
        })),
        messageId
      },
      messageId
    }],
    outputDirectory: workspaceRunOutputDirectory(`${prefix}-run`),
    runtimeSandboxId: onlineRuntimeId,
    sessionId: onlineSessionId
  });

  const runId = `${prefix}-run`;
  const textPath = workspaceAttachmentPath({
    attachmentId: staged[0]!.id,
    messageId,
    originalName: staged[0]!.name
  });
  const binaryPath = workspaceAttachmentPath({
    attachmentId: staged[1]!.id,
    messageId,
    originalName: staged[1]!.name
  });
  const listed = await call<unknown[]>(onlineSessionId, onlineRuntimeId, runId, "sandbox_fs_list", {
    path: `/workspace/inbox/messages/${messageId}`
  });
  assert(Array.isArray(listed));
  const readText = await call(onlineSessionId, onlineRuntimeId, runId, "sandbox_fs_read", {
    path: textPath
  });
  assert.equal(readText.content, text.toString("utf8"));
  await call(onlineSessionId, onlineRuntimeId, runId, "sandbox_fs_copy", {
    from: binaryPath,
    to: "/workspace/project/copied.bin"
  });
  const copied = await call(onlineSessionId, onlineRuntimeId, runId, "sandbox_fs_read", {
    encoding: "base64",
    path: "/workspace/project/copied.bin"
  });
  assert.equal(sha256(Buffer.from(String(copied.content), "base64")), sha256(binary));

  const basics = await call(onlineSessionId, onlineRuntimeId, runId, "sandbox_shell", {
    command: [
      "set -eu",
      "test \"$(pwd)\" = /workspace/project",
      "bash --version >/dev/null",
      "python3 -c 'print(\"python-ok\")'",
      "node -e 'console.log(\"node-ok\")'",
      "if env | grep -Eq '^(AIQSA_|DATABASE_URL|S3_|OPENAI_)'; then exit 91; fi"
    ].join("\n"),
    treatNonZeroAsError: true
  });
  assert.equal(basics.success, true);

  const packages = await call(onlineSessionId, onlineRuntimeId, runId, "sandbox_shell", {
    command: [
      "set -eu",
      "python3 -m venv .live-venv",
      ".live-venv/bin/pip install --disable-pip-version-check --no-cache-dir idna==3.10 >/dev/null",
      ".live-venv/bin/python -c 'import idna; assert idna.__version__ == \"3.10\"'",
      "mkdir -p live-node && cd live-node",
      "npm init -y >/dev/null",
      "npm install --save-exact --no-audit --no-fund is-number@7.0.0 >/dev/null",
      "node -e 'if (!require(\"is-number\")(7)) process.exit(1)'",
      "cd /workspace/project",
      "apt-get update -qq",
      "apt-get install -y -qq --no-install-recommends tree >/dev/null",
      "tree --version >/dev/null",
      "curl -fsS --max-time 15 https://example.com >/dev/null",
      "if curl -fsS --max-time 3 http://10.255.255.1 >/dev/null 2>&1; then exit 92; fi",
      "if curl -fsS --max-time 3 http://169.254.169.254/latest/meta-data/ >/dev/null 2>&1; then exit 93; fi",
      "printf 'AIQSA live persisted marker\\n' > marker.txt",
      `mkdir -p ${workspaceRunOutputDirectory(runId)}`,
      `tar -czf ${workspaceRunOutputDirectory(runId)}/result.tar.gz marker.txt copied.bin`
    ].join("\n"),
    treatNonZeroAsError: true
  });
  assert.equal(packages.success, true);

  const outputs = await runtime.collectOutputs({
    modelRunId: runId,
    outputDirectory: workspaceRunOutputDirectory(runId),
    runtimeSandboxId: onlineRuntimeId,
    sessionId: onlineSessionId
  });
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]!.relativePath, "result.tar.gz");
  const downloaded = await collect(outputs[0]!.body);
  assert.equal(downloaded.byteLength, outputs[0]!.byteSize);
  assert.equal(sha256(downloaded), outputs[0]!.checksum);
  const unpackedTar = gunzipSync(downloaded);
  assert.equal(tarContains(unpackedTar, "marker.txt"), true);
  assert.equal(tarContains(unpackedTar, "copied.bin"), true);

  await runtime.stopSession({
    runtimeSandboxId: onlineRuntimeId,
    sessionId: onlineSessionId
  });
  const restarted = await runtime.ensureSession({
    cpus: config.cpus,
    diskMiB: config.diskMiB,
    imageRef: config.imageRef,
    internetEnabled: true,
    memoryMiB: config.memoryMiB,
    runtimeSandboxId: onlineRuntimeId,
    sandboxName: onlineSandboxName,
    sessionId: onlineSessionId
  });
  assert.equal(restarted.runtimeSandboxId, onlineRuntimeId);
  const persisted = await call(onlineSessionId, onlineRuntimeId, `${prefix}-followup`, "sandbox_shell", {
    command: [
      "set -eu",
      "grep -q 'AIQSA live persisted marker' marker.txt",
      ".live-venv/bin/python -c 'import idna; assert idna.__version__ == \"3.10\"'",
      "node -e 'if (!require(\"./live-node/node_modules/is-number\")(9)) process.exit(1)'",
      "tree --version >/dev/null"
    ].join("\n"),
    treatNonZeroAsError: true
  });
  assert.equal(persisted.success, true);

  const longRunId = `${prefix}-long`;
  const started = await call(onlineSessionId, onlineRuntimeId, longRunId, "sandbox_exec_start", {
    command: "sleep 300",
    shell: true
  });
  const execSessionId = String(started.execSessionId ?? "");
  assert(execSessionId.length > 0);
  await runtime.cancelToolCall({
    modelRunId: longRunId,
    modelRunToolCallId: `${longRunId}-stop`,
    runtimeSandboxId: onlineRuntimeId,
    sessionId: onlineSessionId
  });
  // Cancellation terminates and closes the run's executions, so the official
  // exec id is gone afterwards; a poll that still answers must report done.
  let cancelled = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    toolCallSequence += 1;
    const polled = await runtime.callBoundTool({
      arguments: { execSessionId },
      modelRunId: longRunId,
      modelRunToolCallId: `${longRunId}-poll-${toolCallSequence}`,
      originalName: "sandbox_exec_poll",
      runtimeSandboxId: onlineRuntimeId,
      sessionId: onlineSessionId
    });
    const text = polled.content[0]?.text ?? "";
    if (polled.status !== "complete") {
      assert.match(text, /exec session not found/u);
      cancelled = true;
      break;
    }
    const parsed = JSON.parse(text) as { data?: { done?: unknown } };
    if (parsed.data?.done === true) {
      cancelled = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(cancelled, true, "long command was not cancelled");

  // Registry-driven termination: the application addresses executions by
  // their official id, and an id the server no longer knows is `unknown`.
  const quiesceRunId = `${prefix}-quiesce`;
  const quiesced = await call(onlineSessionId, onlineRuntimeId, quiesceRunId, "sandbox_exec_start", {
    command: "sleep 12; echo late > /workspace/project/after-stop.txt",
    shell: true
  });
  const quiesceId = String(quiesced.execSessionId ?? "");
  const terminations = await runtime.terminateExecutions({
    executions: [
      { modelRunId: quiesceRunId, runtimeExecSessionId: quiesceId },
      { modelRunId: quiesceRunId, runtimeExecSessionId: "never-started" }
    ],
    runtimeSandboxId: onlineRuntimeId,
    sessionId: onlineSessionId
  });
  assert.deepEqual(terminations.map((entry) => entry.outcome), ["closed", "unknown"]);
  await new Promise((resolve) => setTimeout(resolve, 13_000));
  const marker = await call(onlineSessionId, onlineRuntimeId, quiesceRunId, "sandbox_fs_exists", {
    path: "/workspace/project/after-stop.txt"
  });
  assert.equal(marker.exists, false, "terminated execution still wrote its marker");

  // Incremental staging: the guest index lists intact originals only.
  const stagedListing = await runtime.listStagedAttachments({
    runtimeSandboxId: onlineRuntimeId,
    sessionId: onlineSessionId
  });
  assert.equal(stagedListing.length, 3);
  assert.equal(
    stagedListing.every((entry) => entry.checksum.length === 64 && entry.byteSize > 0),
    true
  );

  const offline = await runtime.ensureSession({
    cpus: config.cpus,
    diskMiB: config.diskMiB,
    imageRef: config.imageRef,
    internetEnabled: false,
    memoryMiB: config.memoryMiB,
    runtimeSandboxId: null,
    sandboxName: offlineSandboxName,
    sessionId: offlineSessionId
  });
  offlineRuntimeId = offline.runtimeSandboxId;
  await call(offlineSessionId, offlineRuntimeId, `${prefix}-offline`, "sandbox_fs_write", {
    content: "offline filesystem works\n",
    path: "/workspace/project/offline.txt"
  });
  const noNetwork = await call(offlineSessionId, offlineRuntimeId, `${prefix}-offline`, "sandbox_shell", {
    command: [
      "set -eu",
      "grep -q 'offline filesystem works' offline.txt",
      "if curl -fsS --max-time 4 https://example.com >/dev/null 2>&1; then exit 94; fi",
      "python3 -c 'print(\"offline-python-ok\")'"
    ].join("\n"),
    treatNonZeroAsError: true
  });
  assert.equal(noNetwork.success, true);

  const projectArchive = await runtime.createProjectArchive({
    runtimeSandboxId: onlineRuntimeId,
    sessionId: onlineSessionId
  });
  const projectBytes = await collect(projectArchive.body);
  assert.equal(sha256(projectBytes), projectArchive.checksum);
  assert.equal(tarContains(gunzipSync(projectBytes), "marker.txt"), true);

  await cleanup();
  await absent(onlineSandboxName);
  await absent(offlineSandboxName);
  process.stdout.write(JSON.stringify({
    archiveChecksum: projectArchive.checksum,
    catalogHash: catalog.hash,
    outputChecksum: outputs[0]!.checksum,
    outputFile: outputs[0]!.relativePath,
    status: "passed"
  }) + "\n");
} catch (error) {
  await cleanup();
  if (error instanceof WorkspaceRuntimeError) {
    throw new Error(error.code);
  }
  throw error;
}
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : "workspace_live_smoke_failed"}\n`);
  process.exitCode = 1;
});
