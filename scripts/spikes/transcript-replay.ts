import { createProviderSafeFetch } from "../../lib/server/providers/providerSafeFetch";
import {
  createSpikeConnection,
  parseSpikeArguments,
  runTranscriptReplaySpike,
  SPIKE_PROVIDER_PROFILES,
  SPIKE_USAGE,
  type SpikeOptions,
  type SpikeProvider
} from "./transcript-replay-support";

/**
 * Spike 1 (native agent engine): transcript replay across providers with real
 * keys from the environment. It never reads `.env` and prints only
 * content-free JSON lines. See `transcript-replay-support.ts` and `--help`.
 */

function connect(options: SpikeOptions, provider: SpikeProvider) {
  const profile = SPIKE_PROVIDER_PROFILES[provider];
  const apiKey = process.env[profile.apiKeyEnv]?.trim();
  const baseUrl = ((profile.baseUrlEnv ? process.env[profile.baseUrlEnv]?.trim() : undefined) || profile.defaultBaseUrl)
    ?.replace(/\/+$/u, "");
  if (!apiKey || !baseUrl) return null;
  // The same pinned, HTTPS-only transport production uses for these endpoints.
  const fetchFn = createProviderSafeFetch({
    configuration: { allowPrivateNetwork: false, apiRoot: baseUrl, authenticationMode: "bearer", responseTimeoutMs: options.timeoutMs }
  });
  return createSpikeConnection(provider, { apiKey, baseUrl, errorDetail: options.errorDetail, fetchFn, timeoutMs: options.timeoutMs });
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseSpikeArguments>;
  try {
    parsed = parseSpikeArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "spike_argument_invalid"}\n${SPIKE_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if ("help" in parsed) {
    process.stdout.write(`${SPIKE_USAGE}\n`);
    return;
  }
  const options = parsed;
  const summary = await runTranscriptReplaySpike(options, {
    connect: (provider) => connect(options, provider),
    emit: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  });
  process.exitCode = summary.pass ? 0 : 1;
}

main().catch((error: unknown) => {
  // Content-free: an unexpected failure names only its class.
  process.stderr.write(`transcript_replay_spike_failed:${error instanceof Error ? error.name : "unknown"}\n`);
  process.exitCode = 1;
});
