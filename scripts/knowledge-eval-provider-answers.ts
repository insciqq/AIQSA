import { existsSync, readFileSync } from "node:fs";
import {
  createProviderSafeFetch,
  ProviderSafeFetchError
} from "../lib/server/providers/providerSafeFetch";
import {
  ProviderRequestTimeoutError,
  ProviderResponseTooLargeError
} from "../lib/server/providers/network";
import {
  createProviderRuntimeBinding,
  type ProviderRuntimeBinding
} from "../lib/server/providers/runtimeFactory";
import type { ProviderRunResult } from "../lib/server/providers/types";
import {
  KNOWLEDGE_PROVIDER_ANSWER_EVAL_VERSION,
  ProviderAnswerCallFailure,
  ProviderAnswerEvalError,
  parseProviderAnswerEvalCli,
  providerAnswerEvalExecutionSnapshot,
  runProviderAnswerEval,
  type ProviderAnswerEvalProfile,
  type ProviderAnswerExecutor
} from "../tests/knowledge-evals/providerAnswerEval";

type CredentialEnvironmentName = ProviderAnswerEvalProfile["credentialEnvironmentName"];

const credentialEnvironmentNames = Object.freeze([
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY"
] as const satisfies readonly CredentialEnvironmentName[]);

function unquoteEnvironmentValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function credentialsFromLocalEnvironment(): Readonly<
  Partial<Record<CredentialEnvironmentName, string>>
> {
  const credentials = new Map<CredentialEnvironmentName, string>();
  for (const name of credentialEnvironmentNames) {
    const value = process.env[name]?.trim();
    if (value) credentials.set(name, value);
  }
  if (credentials.size < credentialEnvironmentNames.length && existsSync(".env")) {
    const allowed = new Set<string>(credentialEnvironmentNames);
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const name = trimmed.slice(0, separator).trim();
      if (!allowed.has(name) || credentials.has(name as CredentialEnvironmentName)) continue;
      const value = unquoteEnvironmentValue(trimmed.slice(separator + 1));
      if (value) credentials.set(name as CredentialEnvironmentName, value);
    }
  }
  return Object.freeze(Object.fromEntries(credentials));
}

function runtimeKey(profile: ProviderAnswerEvalProfile): string {
  return `${profile.provider}:${profile.modelId}`;
}

function collectProviderResult(
  runtime: ProviderRuntimeBinding,
  request: Parameters<ProviderRuntimeBinding["adapter"]["stream"]>[0],
  options: Parameters<ProviderRuntimeBinding["adapter"]["stream"]>[1]
): Promise<ProviderRunResult> {
  return (async () => {
    const stream = runtime.adapter.stream(request, options);
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    return next.value;
  })();
}

function nativeProviderExecutor(
  profiles: readonly ProviderAnswerEvalProfile[]
): ProviderAnswerExecutor {
  const credentials = credentialsFromLocalEnvironment();
  const runtimes = new Map<string, Readonly<{
    observation: { httpStatus: number | null };
    runtime: ProviderRuntimeBinding | null;
  }>>();
  for (const profile of profiles) {
    const snapshot = providerAnswerEvalExecutionSnapshot(profile);
    const credential = credentials[profile.credentialEnvironmentName];
    const observation = { httpStatus: null as number | null };
    if (!credential) {
      runtimes.set(runtimeKey(profile), { observation, runtime: null });
      continue;
    }
    const safeFetch = createProviderSafeFetch({ configuration: snapshot.connection });
    const observingFetch: typeof fetch = async (request, init) => {
      const response = await safeFetch(request, init);
      observation.httpStatus = response.status;
      return response;
    };
    const runtime = createProviderRuntimeBinding({
      options: {
        allowFake: false,
        fetchFn: observingFetch
      },
      secret: credential,
      snapshot
    });
    runtimes.set(runtimeKey(profile), { observation, runtime });
  }
  if (runtimes.size !== profiles.length) {
    throw new Error("knowledge_provider_answer_eval_runtime_contract_invalid");
  }

  return async ({ profile, request, signal, timeoutMs }) => {
    const entry = runtimes.get(runtimeKey(profile));
    if (!entry) throw new ProviderAnswerCallFailure("provider_protocol_error");
    if (!entry.runtime) {
      throw new ProviderAnswerCallFailure("provider_credential_missing");
    }
    entry.observation.httpStatus = null;
    try {
      const result = await collectProviderResult(
        entry.runtime,
        request,
        { signal, timeoutMs }
      );
      if ((result.toolCalls?.length ?? 0) > 0 ||
        result.providerToolCallMessage !== undefined) {
        throw new ProviderAnswerCallFailure("provider_tool_call_unexpected");
      }
      return { answer: result.finalText, usage: result.usage };
    } catch (error) {
      if (error instanceof ProviderAnswerCallFailure) throw error;
      if (entry.observation.httpStatus !== null &&
        entry.observation.httpStatus >= 400) {
        throw new ProviderAnswerCallFailure(
          "provider_http_error",
          entry.observation.httpStatus
        );
      }
      if (error instanceof ProviderSafeFetchError) {
        throw new ProviderAnswerCallFailure("provider_network_error");
      }
      if (error instanceof ProviderRequestTimeoutError || signal.aborted) {
        throw new ProviderAnswerCallFailure("provider_call_timeout");
      }
      if (error instanceof ProviderResponseTooLargeError) {
        throw new ProviderAnswerCallFailure("provider_response_too_large");
      }
      throw new ProviderAnswerCallFailure("provider_protocol_error");
    }
  };
}

async function main(): Promise<void> {
  const options = parseProviderAnswerEvalCli(process.argv.slice(2));
  const report = await runProviderAnswerEval({
    executePaid: options.executePaid,
    prepareExecutor: nativeProviderExecutor,
    reviewDirectory: options.reviewDirectory,
    selectedProvider: options.provider
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.status === "failed") process.exitCode = 1;
}

void main().catch((error: unknown) => {
  const failureCode = error instanceof ProviderAnswerEvalError
    ? error.code
    : "knowledge_provider_answer_eval_failed";
  process.stdout.write(`${JSON.stringify({
    failureCode,
    reportVersion: KNOWLEDGE_PROVIDER_ANSWER_EVAL_VERSION,
    status: "failed"
  })}\n`);
  process.exitCode = 1;
});
