import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { CODEX_HOME_DIRECTORY, CODEX_VERSION, renderCodexManagedProfile } from "@/lib/server/agents/codexProfile";
import { INSTALL_CODEX_PROFILE } from "@/lib/server/agents/guest";
import { tarGzipStream } from "@/lib/server/chats/tarArchive";
import type { WorkspaceRuntime, WorkspaceSkillBundleRef, WorkspaceSkillRunIdentity } from "@/lib/server/workspace/runtime";
import { workspaceRunOutputDirectory } from "@/lib/domain/workspace";

const pinnedAlias = "aiqsa-native-live-pinned";
const availableAlias = "aiqsa-native-live-available";
const sourceCanary = "AIQSA_MANAGED_SKILL_SOURCE_EXCLUDED";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function requireFact(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
function shellQuote(value: string): string { return `'${value.replace(/'/gu, `'\\''`)}'`; }

/** No turn/start or model invocation. Child stdout is parsed privately and never forwarded. */
const NATIVE_SKILL_DISCOVERY_PROBE = String.raw`
import base64, json, os, pathlib, selectors, signal, subprocess, sys, time

def check(value, code):
    if not value: raise RuntimeError(code)

def native_skills():
    version = subprocess.run(['/usr/local/bin/codex', '--version'], capture_output=True, timeout=5)
    check(version.returncode == 0 and version.stdout.decode().strip().split()[-1] == data['version'], 'codex_version_mismatch')
    process = subprocess.Popen(['/usr/local/bin/codex', 'app-server'], cwd='/workspace/project',
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    pending = b''
    received = 0
    deadline = time.monotonic() + 20
    def send(value):
        process.stdin.write((json.dumps(value) + '\n').encode())
        process.stdin.flush()
    def response(identifier):
        nonlocal pending, received
        while True:
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                if not line: continue
                value = json.loads(line)
                check(isinstance(value, dict), 'codex_protocol_invalid')
                if value.get('id') == identifier:
                    check('error' not in value and isinstance(value.get('result'), dict), 'codex_request_failed')
                    return value['result']
            remaining = deadline - time.monotonic()
            check(remaining > 0, 'codex_discovery_timeout')
            check(bool(selector.select(remaining)), 'codex_discovery_timeout')
            chunk = os.read(process.stdout.fileno(), 65536)
            check(bool(chunk), 'codex_protocol_incomplete')
            received += len(chunk)
            check(received <= 524288, 'codex_discovery_limit')
            pending += chunk
    try:
        send({'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'aiqsa-live-probe', 'title': 'AIQSA live probe', 'version': '1'}}})
        response(1)
        send({'method': 'initialized'})
        send({'id': 2, 'method': 'skills/list', 'params': {'cwds': ['/workspace/project'], 'forceReload': True}})
        result = response(2)
        rows = result.get('data')
        check(isinstance(rows, list) and len(rows) == 1 and rows[0].get('cwd') == '/workspace/project', 'codex_catalog_invalid')
        check(rows[0].get('errors') == [] and isinstance(rows[0].get('skills'), list), 'codex_catalog_invalid')
        return rows[0]['skills']
    finally:
        selector.close()
        try: os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=3)
        process.stdin.close()
        process.stdout.close()

try:
    data = json.loads(base64.b64decode(sys.argv[1], validate=True))
    check(os.environ.get('HOME') == '/root' and os.environ.get('CODEX_HOME') == '/workspace/.aiqsa/codex', 'codex_environment_invalid')
    managed = pathlib.Path('/workspace/.aiqsa/skills')
    discovery = pathlib.Path('/root/.agents/skills')
    project = pathlib.Path('/workspace/project')
    project_skills = [(project / '.agents/skills/aiqsa-project-agents-live', 'aiqsa-project-agents-live'),
                      (project / '.codex/skills/aiqsa-project-codex-live', 'aiqsa-project-codex-live')]
    if data['phase'] == 'setup':
        installed = subprocess.run(['/usr/bin/python3', '-I', '-c', data['installer']],
            input=json.dumps({'config': data['config']}).encode(), capture_output=True, timeout=10)
        check(installed.returncode == 0, 'codex_profile_install_failed')
        for folder, name in project_skills:
            check(not folder.exists(), 'codex_project_fixture_conflict')
            folder.mkdir(parents=True)
            (folder / 'SKILL.md').write_text('---\nname: ' + name + '\ndescription: Project-owned native discovery fixture.\n---\nUse only for the synthetic probe.\n')
        print(json.dumps({'ok': True}))
    elif data['phase'] == 'empty':
        check(not managed.exists() or list(managed.iterdir()) == [], 'codex_new_run_stale_bundle')
        check(not discovery.exists() or list(discovery.iterdir()) == [], 'codex_new_run_stale_link')
        check(all((folder / 'SKILL.md').is_file() for folder, _ in project_skills), 'codex_project_skill_removed')
        print(json.dumps({'ok': True}))
    else:
        expected = data['bundles']
        check(sorted(path.name for path in managed.iterdir()) == sorted(item['alias'] for item in expected), 'codex_managed_set_mismatch')
        check(sorted(path.name for path in discovery.iterdir()) == sorted(item['alias'] for item in expected if item['discover']), 'codex_discovery_link_mismatch')
        for item in expected:
            folder = managed / item['alias']
            check(folder.is_dir() and not folder.is_symlink(), 'codex_bundle_missing')
            check((folder.stat().st_mode & 0o777) == 0o755 and ((folder / 'SKILL.md').stat().st_mode & 0o777) == 0o644, 'codex_bundle_mode_invalid')
            executable = folder / 'scripts/run.sh'
            check((executable.stat().st_mode & 0o777) == 0o755, 'codex_executable_mode_invalid')
            executed = subprocess.run([str(executable)], capture_output=True, timeout=3)
            check(executed.returncode == 0 and executed.stdout.decode().strip() == item['marker'], 'codex_executable_failed')
            link = discovery / item['alias']
            check((link.is_symlink() and os.readlink(link) == str(folder)) if item['discover'] else not link.exists(), 'codex_discovery_link_mismatch')
        stale = managed / data['pinnedAlias'] / 'retained-by-same-run.txt'
        check(stale.exists() == data['expectStale'], 'codex_same_run_state_mismatch')
        skills = native_skills()
        expected_names = [item['alias'] for item in expected if item['discover']] + [name for _, name in project_skills]
        check(len(skills) == len(expected_names) and sorted(item.get('name', '') for item in skills) == sorted(expected_names), 'codex_unexpected_skill_discovery')
        for item in expected:
            matches = [skill for skill in skills if skill.get('name') == item['alias']]
            check(len(matches) == (1 if item['discover'] else 0), 'codex_pinned_discovery_mismatch')
            if matches:
                check(matches[0].get('enabled') is True and matches[0].get('scope') == 'user' and
                    matches[0].get('path') == str(managed / item['alias'] / 'SKILL.md'), 'codex_user_discovery_mismatch')
        for folder, name in project_skills:
            matches = [skill for skill in skills if skill.get('name') == name]
            check(len(matches) == 1 and matches[0].get('enabled') is True and
                matches[0].get('path') == str(folder / 'SKILL.md'), 'codex_project_discovery_mismatch')
        check(all(item.get('scope') != 'system' and '/.system/' not in item.get('path', '') for item in skills), 'codex_bundled_discovery_enabled')
        if data.get('writeStale'): stale.write_text('Same-run edits survive preparation.\n')
        if data.get('outputDirectory'):
            output = pathlib.Path(data['outputDirectory'])
            check(output.parent == pathlib.Path('/workspace/output'), 'codex_probe_output_invalid')
            output.mkdir(parents=True, exist_ok=True)
            (output / 'skill-probe-result.txt').write_text('AIQSA probe deliverable\n')
        print(json.dumps({'ok': True, 'availableCount': sum(item['discover'] for item in expected),
            'projectCount': len(project_skills), 'bundledCount': 0, 'pinnedDiscoveries': 0, 'executable': True}))
except BaseException as error:
    code = str(error) if isinstance(error, RuntimeError) and str(error).startswith('codex_') else 'codex_discovery_probe_failed'
    print(json.dumps({'ok': False, 'code': code}))
    sys.exit(1)
`;

export function nativeSkillDiscoveryCommand(payload: Record<string, unknown>): string {
  return `python3 -I -c ${shellQuote(NATIVE_SKILL_DISCOVERY_PROBE)} ${shellQuote(Buffer.from(JSON.stringify(payload)).toString("base64"))}`;
}

export function nativeSkillDiscoveryReceipt(value: unknown): { availableCount: number; projectCount: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || record.executable !== true || record.bundledCount !== 0 || record.pinnedDiscoveries !== 0 ||
    !Number.isSafeInteger(record.availableCount) || Number(record.availableCount) < 0 || Number(record.availableCount) > 100 ||
    record.projectCount !== 2 || Object.keys(record).some(key => !["ok", "availableCount", "projectCount", "bundledCount", "pinnedDiscoveries", "executable"].includes(key))) return null;
  return { availableCount: Number(record.availableCount), projectCount: 2 };
}

async function bytes(body: ReadableStream<Uint8Array>, limit = 4 * 1024 * 1024): Promise<Buffer> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(parts, length);
      length += next.value.byteLength;
      requireFact(length <= limit, "workspace_skill_probe_stream_limit");
      parts.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

async function fixture(alias: string, revision: number, discover: boolean) {
  const marker = `skill-revision-${revision}`;
  const archive = await bytes(tarGzipStream((async function* () {
    yield { path: "SKILL.md", mtime: new Date(0), content: `---\nname: ${alias}\ndescription: Synthetic native discovery qualification.\n---\n${sourceCanary}\nRead scripts/run.sh only for this probe.\n` };
    yield { path: "scripts/run.sh", mtime: new Date(0), mode: 0o755 as const, content: `#!/bin/sh\nprintf '%s\\n' '${marker}'\n` };
  })()));
  const checksum = sha256(archive);
  return { marker, archive, checksum, bundle: { alias, revisionId: `${alias}-${revision}`, bundleDigest: checksum, discover } satisfies WorkspaceSkillBundleRef };
}

/** Caller owns a fresh disposable offline guest and its unconditional cleanup. */
export async function probeWorkspaceSkillDiscovery(input: {
  runtime: WorkspaceRuntime; sessionId: string; runtimeSandboxId: string; runIdPrefix: string;
}) {
  const { runtime, sessionId, runtimeSandboxId } = input;
  let calls = 0;
  let nativeProbes = 0;
  const pinned = await fixture(pinnedAlias, 1, false);
  const available = await fixture(availableAlias, 1, true);
  const replaced = await fixture(availableAlias, 2, true);
  const identity = (suffix: string, bundles: readonly Awaited<ReturnType<typeof fixture>>[]): WorkspaceSkillRunIdentity => ({
    sessionId, runtimeSandboxId, modelRunId: `${input.runIdPrefix}-${suffix}`,
    manifestHash: sha256(Buffer.from(JSON.stringify(bundles.map(item => item.bundle))))
  });
  const run = async (current: WorkspaceSkillRunIdentity, payload: Record<string, unknown>) => {
    const result = await runtime.callBoundTool({ ...current, modelRunToolCallId: `${current.modelRunId}-probe-${++calls}`,
      originalName: "sandbox_shell", arguments: { command: nativeSkillDiscoveryCommand({ version: CODEX_VERSION, ...payload }),
        env: { HOME: "/root", CODEX_HOME: CODEX_HOME_DIRECTORY }, treatNonZeroAsError: false } });
    requireFact(result.status === "complete" && !result.truncated, "workspace_skill_probe_transport_failed");
    const outer: unknown = JSON.parse(result.content[0]?.text ?? "null");
    requireFact(outer && typeof outer === "object" && "data" in outer && outer.data && typeof outer.data === "object", "workspace_skill_probe_transport_invalid");
    const data = outer.data as Record<string, unknown>;
    requireFact(typeof data.stdout === "string" && Buffer.byteLength(data.stdout) <= 1024, "workspace_skill_probe_receipt_invalid");
    const receipt: unknown = JSON.parse(data.stdout);
    if (receipt && typeof receipt === "object" && "ok" in receipt && receipt.ok === false && "code" in receipt &&
      typeof receipt.code === "string" && /^codex_[a-z0-9_]{1,80}$/u.test(receipt.code)) throw new Error(receipt.code);
    requireFact(receipt && typeof receipt === "object" && "ok" in receipt && receipt.ok === true && data.success === true, "workspace_skill_probe_failed");
    return receipt;
  };
  const install = async (current: WorkspaceSkillRunIdentity, item: Awaited<ReturnType<typeof fixture>>) => {
    const installed = await runtime.installSkillBundle({ ...current, bundle: item.bundle, byteSize: item.archive.byteLength,
      checksum: item.checksum, archive: new ReadableStream({ start(controller) { controller.enqueue(item.archive); controller.close(); } }) });
    requireFact(installed.workspacePath === `/workspace/.aiqsa/skills/${item.bundle.alias}`, "workspace_skill_probe_install_path_invalid");
  };
  const inspect = async (current: WorkspaceSkillRunIdentity, bundles: readonly Awaited<ReturnType<typeof fixture>>[], expectStale: boolean, writeStale = false, outputDirectory?: string) => {
    const result = nativeSkillDiscoveryReceipt(await run(current, { phase: "inspect", pinnedAlias, expectStale, writeStale,
      ...(outputDirectory ? { outputDirectory } : {}),
      bundles: bundles.map(item => ({ alias: item.bundle.alias, discover: item.bundle.discover, marker: item.marker })) }));
    requireFact(result && result.availableCount === bundles.filter(item => item.bundle.discover).length, "workspace_skill_probe_receipt_invalid");
    nativeProbes++;
  };
  try {
    const first = identity("initial", [pinned, available]);
    await run(first, { phase: "setup", installer: INSTALL_CODEX_PROFILE, config: renderCodexManagedProfile({
      gatewayOrigin: "http://127.0.0.1:9", modelId: "synthetic-no-model-probe", contextWindowTokens: 128000,
      maxOutputTokens: 16000, mcpMode: "off", mcpTimeoutSeconds: 10, developerInstructions: "Synthetic discovery probe; no model is invoked."
    }) });
    requireFact((await runtime.prepareSkillRun({ ...first, initial: [pinned.bundle, available.bundle] })).state === "preparing", "workspace_skill_probe_initial_state_invalid");
    await install(first, pinned); await install(first, available); await runtime.completeSkillRunPreparation(first);
    await inspect(first, [pinned, available], false, true);
    requireFact((await runtime.prepareSkillRun({ ...first, initial: [pinned.bundle, available.bundle] })).state === "ready", "workspace_skill_probe_recovery_state_invalid");
    await inspect(first, [pinned, available], true);

    const second = identity("replacement", [pinned, replaced]);
    requireFact((await runtime.prepareSkillRun({ ...second, initial: [pinned.bundle, replaced.bundle] })).state === "preparing", "workspace_skill_probe_replacement_state_invalid");
    await run(second, { phase: "empty" });
    await install(second, pinned); await install(second, replaced); await runtime.completeSkillRunPreparation(second);
    const outputDirectory = workspaceRunOutputDirectory(second.modelRunId);
    await inspect(second, [pinned, replaced], false, false, outputDirectory);

    const project = await runtime.createProjectArchive({ sessionId, runtimeSandboxId });
    const projectBytes = await bytes(project.body);
    const projectTar = gunzipSync(projectBytes, { maxOutputLength: 16 * 1024 * 1024 });
    requireFact(sha256(projectBytes) === project.checksum && projectTar.includes(Buffer.from("Project-owned native discovery fixture.")) &&
      !projectTar.includes(Buffer.from(sourceCanary)), "workspace_skill_probe_archive_leak");
    const outputs = await runtime.collectOutputs({ ...second, outputDirectory });
    requireFact(outputs.length === 1 && outputs[0]!.relativePath === "skill-probe-result.txt", "workspace_skill_probe_output_leak");
    const outputBytes = await bytes(outputs[0]!.body, 1024);
    requireFact(sha256(outputBytes) === outputs[0]!.checksum && outputBytes.toString("utf8") === "AIQSA probe deliverable\n", "workspace_skill_probe_output_invalid");

    const off = identity("off", [pinned]);
    requireFact((await runtime.prepareSkillRun({ ...off, initial: [pinned.bundle] })).state === "preparing", "workspace_skill_probe_off_state_invalid");
    await run(off, { phase: "empty" });
    await install(off, pinned); await runtime.completeSkillRunPreparation(off);
    await inspect(off, [pinned], false);
    return { codexVersion: CODEX_VERSION, nativeProbes, projectSkillsPreserved: 2, bundledDiscoveries: 0,
      pinnedDiscoveries: 0, executablePassed: true, sameRunPreserved: true, replacementPassed: true,
      offCleanupPassed: true, archiveExcluded: true, outputsExcluded: true };
  } catch (error) {
    throw new Error(error instanceof Error && /^(?:workspace_skill_|codex_)[a-z0-9_]{1,80}$/u.test(error.message)
      ? error.message : "workspace_skill_discovery_probe_failed");
  }
}
