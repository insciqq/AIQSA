import { textFromContentBlocks, type ModelRunSseEvent } from "../../domain/modelRunEvents";
import { conversationPreview, textConversationForRequest } from "./context";
import type { ModelToolCall, RunTool } from "../tools/types";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "./types";

const DETERMINISTIC_RESULT_ZIP_BASE64 =
  "UEsDBBQAAAAAAAAAIQDtsuv+JQAAACUAAAAKAAAAcmVzdWx0LnR4dEFJUVNBIGRldGVybWluaXN0aWMgd29ya3NwYWNlIHJlc3VsdApQSwECFAMUAAAAAAAAACEA7bLr/iUAAAAlAAAACgAAAAAAAAAAAAAApIEAAAAAcmVzdWx0LnR4dFBLBQYAAAAAAQABADgAAABNAAAAAAA=";
const WORKSPACE_TEST_DIRECTIVE =
  /^\[AIQSA_WORKSPACE_E2E:(activity_probe|async_stop|descendant_stop|export_fault|forget_executions_stop|deterministic_prepare|live_async_stop|live_marker_probe|live_prepare|live_quiesce_probe|live_staging_probe|long_command|lose_session|marker_probe|network_off_probe|recreate_probe|reset_probe|resume_probe|staging_probe|state_probe)\]$/u;

type FakeToolResultMessage = Readonly<{
  content: readonly Readonly<{ text?: string; type: "json" | "text"; value?: unknown }>[];
  status: "complete" | "error";
  type: "fake_tool_result";
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fakeToolResults(request: ProviderRunRequest): FakeToolResultMessage[] {
  return (request.providerToolMessages ?? []).filter((value): value is FakeToolResultMessage =>
    isRecord(value) && value.type === "fake_tool_result" &&
    (value.status === "complete" || value.status === "error") && Array.isArray(value.content));
}

function workspaceTool(request: ProviderRunRequest, originalName: string): RunTool | null {
  return request.tools?.find((tool) =>
    tool.capability === "workspace" && tool.name.includes(`_${originalName.slice(0, 24)}_`)) ?? null;
}

function toolCall(
  request: ProviderRunRequest,
  originalName: string,
  step: number,
  argumentsValue: Record<string, unknown>
): ModelToolCall | null {
  const tool = workspaceTool(request, originalName);
  return tool ? {
    arguments: argumentsValue,
    id: `workspace-e2e-${step}-${originalName}`,
    name: tool.name
  } : null;
}

function lastToolDataAt(results: readonly FakeToolResultMessage[], index: number): Record<string, unknown> | null {
  const entry = results[index]?.content.find((content) => content.type === "text")?.text;
  if (!entry) return null;
  try {
    const parsed = JSON.parse(entry) as unknown;
    return isRecord(parsed) && isRecord(parsed.data) ? parsed.data : null;
  } catch {
    return null;
  }
}

function lastToolData(results: readonly FakeToolResultMessage[]): unknown {
  const entry = results.at(-1)?.content.find((content) => content.type === "text")?.text;
  if (!entry) return null;
  try {
    const parsed = JSON.parse(entry) as unknown;
    return isRecord(parsed) ? parsed.data : null;
  } catch {
    return null;
  }
}

function stagedAttachmentPath(results: readonly FakeToolResultMessage[]): string | null {
  const data = lastToolData(results);
  if (!isRecord(data) || typeof data.content !== "string") return null;
  try {
    const index = JSON.parse(data.content) as unknown;
    if (!isRecord(index) || !Array.isArray(index.attachments)) return null;
    const first = index.attachments.find((attachment) =>
      isRecord(attachment) && typeof attachment.sandboxPath === "string");
    return isRecord(first) && typeof first.sandboxPath === "string"
      ? first.sandboxPath
      : null;
  } catch {
    return null;
  }
}

function livePreparationCommand(outputDirectory: string): string {
  return [
    "set -eu",
    "test -s /workspace/inbox/index.json",
    "python3 -c \"import hashlib,json; from pathlib import Path; index=json.loads(Path('/workspace/inbox/index.json').read_text()); item=index['attachments'][0]; data=Path(item['sandboxPath']).read_bytes(); assert len(data)==item['byteSize']; assert hashlib.sha256(data).hexdigest()==item['checksum']\"",
    "printf 'workspace-state-v1\\n' > /workspace/project/persisted.txt",
    "python3 -c \"from pathlib import Path; Path('/workspace/project/python.txt').write_text('python-ok\\n')\"",
    "node -e \"require('fs').writeFileSync('/workspace/project/node.txt','node-ok\\n')\"",
    "python3 -m venv /workspace/project/.venv",
    "/workspace/project/.venv/bin/pip install --disable-pip-version-check --no-cache-dir idna==3.10 >/dev/null",
    "/workspace/project/.venv/bin/python -c \"import idna; open('/workspace/project/pip.txt','w').write(idna.__version__+'\\n')\"",
    "mkdir -p /workspace/project/node-check",
    "cd /workspace/project/node-check",
    "npm init --yes >/dev/null",
    "npm install --ignore-scripts --no-audit --no-fund is-number@7.0.0 >/dev/null",
    "node -e \"require('fs').writeFileSync('/workspace/project/npm.txt',require('is-number')('42')?'npm-ok\\n':'npm-failed\\n')\"",
    "ln -s /etc/passwd /workspace/project/archive-symlink-must-not-export",
    "mkfifo /workspace/project/archive-fifo-must-not-export",
    "curl -fsS --max-time 15 https://example.com/ >/dev/null",
    "printf 'public-ok\\n' > /workspace/project/public.txt",
    "if curl -fsS --max-time 3 http://169.254.169.254/latest/meta-data/ >/dev/null 2>&1; then exit 41; fi",
    "printf 'private-blocked\\n' > /workspace/project/private-blocked.txt",
    "printf 'initial\\n' > /workspace/project/finalize-probe.txt",
    `mkdir -p '${outputDirectory}'`,
    `tar -czf '${outputDirectory}/result.tar.gz' -C /workspace/project persisted.txt python.txt node.txt pip.txt npm.txt public.txt private-blocked.txt`
  ].join(" && ");
}

function scriptedWorkspaceResult(
  request: ProviderRunRequest,
  question: string
): ProviderRunResult | null {
  const match = WORKSPACE_TEST_DIRECTIVE.exec(question);
  if (!match || !request.workspace) return null;
  const scenario = match[1]!;
  const results = fakeToolResults(request);
  const step = results.length;
  let call: ModelToolCall | null = null;
  let finalText = "";

  if (scenario === "deterministic_prepare") {
    if (step === 0) {
      call = toolCall(request, "sandbox_fs_read", step, {
        encoding: "utf8",
        path: request.workspace.inboxIndexPath
      });
    } else if (step === 1) {
      const path = stagedAttachmentPath(results);
      call = path ? toolCall(request, "sandbox_fs_read", step, { encoding: "base64", path }) : null;
      if (!path) finalText = "Workspace input manifest was empty.";
    } else if (step === 2) {
      call = toolCall(request, "sandbox_fs_write", step, {
        content: "workspace-state-v1\n",
        encoding: "utf8",
        path: "/workspace/project/persisted.txt"
      });
    } else if (step === 3) {
      call = toolCall(request, "sandbox_fs_write", step, {
        content: DETERMINISTIC_RESULT_ZIP_BASE64,
        encoding: "base64",
        path: `${request.workspace.outputDirectory}/result.zip`
      });
    } else {
      finalText = "Workspace read the staged input and created result.zip.";
    }
  } else if (scenario === "live_prepare") {
    if (step === 0) {
      call = toolCall(request, "sandbox_shell", step, {
        command: livePreparationCommand(request.workspace.outputDirectory)
      });
    } else if (step === 1) {
      call = toolCall(request, "sandbox_exec_start", step, {
        command: "while :; do date +%s%N > /workspace/project/finalize-probe.txt; sleep 0.2; done",
        shell: true
      });
    } else if (step === 2) {
      const data = lastToolData(results);
      call = isRecord(data) && typeof data.execSessionId === "string"
        ? toolCall(request, "sandbox_exec_poll", step, {
            execSessionId: data.execSessionId,
            limit: 10
          })
        : null;
      if (!call) finalText = "Live Workspace long exec did not start.";
    } else {
      const polled = lastToolData(results);
      finalText = results.every((result) => result.status === "complete") &&
        isRecord(polled) && polled.done === false
        ? "Live Workspace completed shell, Python, Node, pip, npm, network, and archive checks."
        : "Live Workspace preparation failed.";
    }
  } else if (scenario === "live_quiesce_probe") {
    if (step === 0) {
      call = toolCall(request, "sandbox_shell", step, {
        command: "set -eu; before=$(cat /workspace/project/finalize-probe.txt); sleep 1; after=$(cat /workspace/project/finalize-probe.txt); test \"$before\" = \"$after\""
      });
    } else {
      finalText = results[0]?.status === "complete"
        ? "Workspace finalization stopped the long-running command."
        : "Workspace finalization left the long-running command active.";
    }
  } else if (scenario === "long_command") {
    if (step === 0) {
      call = toolCall(request, "sandbox_shell", step, { command: "sleep 300" });
    } else {
      finalText = "The long Workspace command ended.";
    }
  } else if (scenario === "activity_probe") {
    // Human-readable timeline: a shell command, a direct-exec mistake the
    // server rejects with an actionable error, a read, a write, an output,
    // and a model-written sandbox: link the renderer must resolve exactly.
    if (step === 0) {
      call = toolCall(request, "sandbox_shell", step, { command: "pwd" });
    } else if (step === 1) {
      call = toolCall(request, "sandbox_exec", step, {
        command: "pwd && ls -la && cat > script.py <<'PY'\nprint(1)\nPY"
      });
    } else if (step === 2) {
      call = toolCall(request, "sandbox_fs_read", step, {
        encoding: "utf8",
        path: request.workspace.inboxIndexPath
      });
    } else if (step === 3) {
      call = toolCall(request, "sandbox_fs_write", step, {
        content: "# Report\n\nGenerated by the deterministic Workspace.\n",
        encoding: "utf8",
        path: `${request.workspace.outputDirectory}/report.md`
      });
    } else {
      finalText = `The report is ready: [Report](sandbox:${request.workspace.outputDirectory}/report.md). ` +
        `A missing file would look like [Missing](sandbox:${request.workspace.outputDirectory}/missing.md). ` +
        "Workspace activity probe finished.";
    }
  } else if (scenario === "staging_probe") {
    if (step === 0) {
      call = toolCall(request, "sandbox_shell", step, { command: "aiqsa-test metrics" });
    } else {
      const data = lastToolData(results);
      const stdout = isRecord(data) && typeof data.stdout === "string" ? data.stdout : "";
      let metrics: unknown = null;
      try {
        metrics = JSON.parse(stdout) as unknown;
      } catch {
        metrics = null;
      }
      finalText = isRecord(metrics)
        ? `Staging metrics: bodies=${String(metrics.stagedAttachmentBodies)} calls=${String(metrics.stageCalls)} ` +
          `last=${Array.isArray(metrics.lastStagedAttachmentIds) ? metrics.lastStagedAttachmentIds.length : "?"}.`
        : "Staging metrics unavailable.";
    }
  } else if (scenario === "async_stop" || scenario === "forget_executions_stop" || scenario === "descendant_stop") {
    // A long-lived execution whose delayed side effect must never happen
    // after Stop; the trailing synchronous sleep keeps the run stoppable.
    const offset = scenario === "descendant_stop" ? 1 : 0;
    if (scenario === "descendant_stop" && step === 0) {
      call = toolCall(request, "sandbox_shell", step, { command: "aiqsa-test fault descendant-once" });
    } else if (step === offset) {
      call = toolCall(request, "sandbox_exec_start", step, {
        command: "sleep 12 && echo late > /workspace/project/after-stop.txt",
        shell: true
      });
    } else if (step === offset + 1) {
      const data = lastToolData(results);
      call = isRecord(data) && typeof data.execSessionId === "string"
        ? toolCall(request, "sandbox_exec_poll", step, { execSessionId: data.execSessionId, limit: 10 })
        : null;
      if (!call) finalText = "Workspace async execution did not start.";
    } else if (step === 2 && scenario === "forget_executions_stop") {
      call = toolCall(request, "sandbox_shell", step, { command: "aiqsa-test forget-executions" });
    } else if (step === (scenario === "forget_executions_stop" ? 3 : offset + 2)) {
      call = toolCall(request, "sandbox_shell", step, { command: "sleep 300; echo late > /workspace/project/sync-after-stop.txt" });
    } else {
      finalText = "The long Workspace command ended.";
    }
  } else if (scenario === "marker_probe" || scenario === "live_marker_probe") {
    if (step === 0) {
      call = toolCall(request, "sandbox_fs_exists", step, { path: "/workspace/project/after-stop.txt" });
    } else if (step === 1) {
      call = toolCall(request, "sandbox_fs_exists", step, { path: "/workspace/project/sync-after-stop.txt" });
    } else {
      const markersAbsent = results.length === 2 && results.every((result) => {
        const data = lastToolData([result]);
        return isRecord(data) && data.exists === false;
      });
      finalText = markersAbsent ? "Late marker absent after Stop." : "Late marker present after Stop.";
    }
  } else if (scenario === "export_fault") {
    if (step === 0) {
      call = toolCall(request, "sandbox_fs_write", step, {
        content: "first output\n",
        encoding: "utf8",
        path: `${request.workspace.outputDirectory}/first.txt`
      });
    } else if (step === 1) {
      call = toolCall(request, "sandbox_fs_write", step, {
        content: "second output\n",
        encoding: "utf8",
        path: `${request.workspace.outputDirectory}/second.txt`
      });
    } else if (step === 2) {
      call = toolCall(request, "sandbox_shell", step, { command: "aiqsa-test fault export-stream-once" });
    } else {
      finalText = "Two outputs were written; the export fault is armed.";
    }
  } else if (scenario === "resume_probe") {
    if (step === 0) {
      call = toolCall(request, "sandbox_fs_write", step, {
        content: "workspace-state-v1\n", encoding: "utf8", path: "/workspace/project/persisted.txt"
      });
    } else if (step === 1) {
      call = toolCall(request, "sandbox_shell", step, { command: "aiqsa-test stop-session" });
    } else if (step === 2) {
      call = toolCall(request, "sandbox_fs_read", step, { encoding: "utf8", path: "/workspace/project/persisted.txt" });
    } else if (step === 3) {
      call = toolCall(request, "sandbox_fs_read", step, { encoding: "utf8", path: request.workspace.inboxIndexPath });
    } else {
      const originalIndex = lastToolData(results);
      const project = lastToolDataAt(results, 2);
      finalText = results.every((result) => result.status === "complete") &&
        isRecord(project) && project.content === "workspace-state-v1\n" &&
        isRecord(originalIndex) && typeof originalIndex.content === "string" && originalIndex.content.includes("attachmentId")
        ? "Workspace resumed the same disk with its originals."
        : "Workspace resume probe failed.";
    }
  } else if (scenario === "lose_session") {
    if (step === 0) {
      call = toolCall(request, "sandbox_fs_write", step, {
        content: "installed\n",
        encoding: "utf8",
        path: "/workspace/project/dependency.txt"
      });
    } else if (step === 1) {
      call = toolCall(request, "sandbox_shell", step, { command: "aiqsa-test lose-session" });
    } else {
      finalText = "Runtime state was written and the sandbox was lost.";
    }
  } else if (scenario === "recreate_probe") {
    if (step === 0) {
      call = toolCall(request, "sandbox_fs_exists", step, { path: "/workspace/project/dependency.txt" });
    } else if (step === 1) {
      call = toolCall(request, "sandbox_fs_read", step, {
        encoding: "utf8",
        path: request.workspace.inboxIndexPath
      });
    } else {
      const index = lastToolData(results);
      const exists = isRecord(lastToolDataAt(results, 0)) && lastToolDataAt(results, 0)!.exists === true;
      const restored = isRecord(index) && typeof index.content === "string" && index.content.includes("attachmentId");
      finalText = exists
        ? "Runtime state survived unexpectedly."
        : restored
          ? "Runtime state is gone and originals were restored."
          : "Originals were not restored.";
    }
  } else if (scenario === "live_staging_probe") {
    // Content-free evidence that unchanged originals were not rewritten: the
    // guest mtimes of every staged file, identical across turns.
    if (step === 0) {
      call = toolCall(request, "sandbox_shell", step, {
        command: "stat -c '%n %Y' /workspace/inbox/messages/*/*--* | sort"
      });
    } else {
      const data = lastToolData(results);
      const stdout = isRecord(data) && typeof data.stdout === "string" ? data.stdout.trim() : "";
      finalText = stdout ? `Inbox mtimes: ${stdout.replace(/\s+/gu, " ")}` : "Inbox mtimes unavailable.";
    }
  } else if (scenario === "live_async_stop") {
    if (step === 0) {
      call = toolCall(request, "sandbox_exec_start", step, {
        command: "sleep 12; echo late > /workspace/project/after-stop.txt",
        shell: true
      });
    } else if (step === 1) {
      const data = lastToolData(results);
      call = isRecord(data) && typeof data.execSessionId === "string"
        ? toolCall(request, "sandbox_exec_poll", step, { execSessionId: data.execSessionId, limit: 10 })
        : null;
      if (!call) finalText = "Live Workspace async execution did not start.";
    } else if (step === 2) {
      call = toolCall(request, "sandbox_shell", step, { command: "sleep 300; echo late > /workspace/project/sync-after-stop.txt" });
    } else {
      finalText = "The long Workspace command ended.";
    }
  } else if (scenario === "network_off_probe") {
    if (step === 0) {
      call = toolCall(request, "sandbox_shell", step, {
        command: "set -eu; if curl -fsS --max-time 3 https://example.com/ >/dev/null 2>&1; then exit 42; fi; printf 'network-off-ok\\n' > /workspace/project/network-off.txt"
      });
    } else {
      finalText = results[0]?.status === "complete"
        ? "Workspace network is blocked while execution remains available."
        : "Workspace no-network probe failed.";
    }
  } else if (scenario === "state_probe") {
    if (step === 0) {
      call = toolCall(request, "sandbox_fs_read", step, {
        encoding: "utf8",
        path: "/workspace/project/persisted.txt"
      });
    } else {
      const data = lastToolData(results);
      finalText = isRecord(data) && data.content === "workspace-state-v1\n"
        ? "Workspace state persisted."
        : "Workspace state is missing.";
    }
  } else if (scenario === "reset_probe") {
    if (step === 0) {
      call = toolCall(request, "sandbox_fs_exists", step, {
        path: "/workspace/project/persisted.txt"
      });
    } else {
      const data = lastToolData(results);
      finalText = isRecord(data) && data.exists === false
        ? "Workspace reset removed the old state."
        : "Workspace reset did not remove the old state.";
    }
  }

  if (call) {
    return {
      finalProviderResponsePreview: { finishReason: "tool_calls", provider: "fake" },
      finalText: "",
      toolCalls: [call],
      usage: {
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        inputTokens: tokenEstimate(question),
        outputTokens: 1,
        reasoningTokens: 0,
        totalTokens: tokenEstimate(question) + 1
      }
    };
  }
  const outputTokens = tokenEstimate(finalText || "Workspace test could not select a tool.");
  return {
    finalProviderResponsePreview: { finishReason: "stop", provider: "fake" },
    finalText: finalText || "Workspace test could not select a tool.",
    usage: {
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: tokenEstimate(question),
      outputTokens,
      reasoningTokens: 0,
      totalTokens: tokenEstimate(question) + outputTokens
    }
  };
}

function tokenEstimate(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error("provider_run_aborted");
    error.name = "AbortError";
    throw error;
  }
}

function fakeProviderTokenDelayMs(): number {
  const parsed = Number(process.env.AIQSA_FAKE_PROVIDER_TOKEN_DELAY_MS);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }

  return Math.min(Math.round(parsed), 1000);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createFakeProviderAdapter(): ProviderAdapter {
  return {
    buildRequestPreview(request) {
      return {
        model: request.modelId,
        params: request.params,
        prompt: request.prompt,
        provider: "fake",
        replayedContext: conversationPreview(request),
        redactions: ["selected_skill_instructions"],
        searchOptionIds: request.searchPlan.options.map((option) => option.optionId),
        text: textFromContentBlocks(request.content)
      };
    },
    async *stream(request, options = {}): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const question = textFromContentBlocks(request.content) || "empty question";
      const scripted = scriptedWorkspaceResult(request, question);
      if (scripted) {
        throwIfAborted(options.signal);
        if ((scripted.toolCalls?.length ?? 0) === 0) {
          for (const word of scripted.finalText.split(" ")) {
            throwIfAborted(options.signal);
            yield { data: { delta: `${word} ` }, type: "token" };
          }
        }
        return scripted;
      }
      const priorUserMessages = textConversationForRequest(request).filter(
        (message, index, messages) =>
          message.role === "user" &&
          message.purpose === undefined &&
          index < messages.length - 1
      );
      const contextSuffix =
        priorUserMessages.length > 0
          ? `\nContext memory: ${priorUserMessages.map((message) => message.content).join(" | ")}`
          : "";
      const finalText = `Fake answer: ${question}${contextSuffix}`;
      const words = finalText.split(" ");
      const tokenDelayMs = fakeProviderTokenDelayMs();

      throwIfAborted(options.signal);
      yield {
        data: {
          artifactType: "summary",
          payload: {
            searchOptionIds: request.searchPlan.options.map((option) => option.optionId),
            source: "fake-provider"
          }
        },
        type: "artifact"
      };

      for (const word of words) {
        if (tokenDelayMs > 0) {
          await wait(tokenDelayMs);
        }
        throwIfAborted(options.signal);
        yield {
          data: {
            delta: `${word} `
          },
          type: "token"
        };
      }

      const usage = {
        inputTokens: tokenEstimate(question),
        outputTokens: tokenEstimate(finalText),
        reasoningTokens: 0
      };
      const normalizedUsage = {
        ...usage,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        totalTokens: usage.inputTokens + usage.outputTokens
      };

      return {
        finalProviderResponsePreview: {
          finishReason: "stop",
          provider: "fake",
          text: finalText
        },
        finalText,
        usage: normalizedUsage
      };
    }
  };
}
