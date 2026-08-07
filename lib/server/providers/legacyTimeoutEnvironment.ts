const ignoredProviderTimeoutEnvironmentNames = Object.freeze([
  "AIQSA_OPENAI_BACKGROUND_POLL_TIMEOUT_MS",
  "AIQSA_PROVIDER_STREAM_IDLE_TIMEOUT_MS",
  "AIQSA_PROVIDER_STREAM_MAX_DURATION_MS",
  "AIQSA_PROVIDER_TIMEOUT_MS"
]);

let reported = false;

export function warnIgnoredProviderTimeoutEnvironmentOnce(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  warn: (message: string) => void = console.warn
): void {
  if (reported) return;

  const variables = ignoredProviderTimeoutEnvironmentNames.filter((name) =>
    typeof environment[name] === "string" && environment[name]!.trim().length > 0
  );
  if (variables.length === 0) return;

  reported = true;
  warn(JSON.stringify({
    code: "provider_timeout_environment_ignored",
    variables
  }));
}

export function resetIgnoredProviderTimeoutEnvironmentWarningForTests(): void {
  reported = false;
}
