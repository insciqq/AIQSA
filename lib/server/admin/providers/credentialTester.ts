import {
  providerResponseMaxBytes,
  readBoundedResponseText,
  withTimeoutSignal
} from "../../providers/network";
import {
  normalizeProviderConnectionConfiguration,
  providerAuthenticationMode,
  type ProviderConnectionConfiguration,
  type ProviderFamily
} from "../../providers/providerConfiguration";
import {
  resolveProviderCredentialSource,
  type ProviderCredentialSource
} from "../../providers/providerCredentialSource";
import {
  createProviderSafeFetch,
  type ProviderSafeFetchOptions
} from "../../providers/providerSafeFetch";

const MAX_CREDENTIAL_TEST_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_ID_LENGTH = 256;

export const MAX_PROVIDER_CREDENTIAL_TEST_MODELS = 1_000;

export type AdminProviderCredentialTesterInput = Readonly<{
  connection: ProviderConnectionConfiguration;
  family: ProviderFamily;
  secret: ProviderCredentialSource | null;
  signal?: AbortSignal;
}>;

export type AdminProviderCredentialTestOutcome = Readonly<{
  method: "models_catalog";
  modelIds: string[];
}>;

export type AdminProviderCredentialTester = Readonly<{
  test(input: AdminProviderCredentialTesterInput): Promise<AdminProviderCredentialTestOutcome>;
}>;

export class AdminProviderCredentialTestError extends Error {
  readonly code = "provider_credential_test_failed" as const;

  constructor() {
    super("provider_credential_test_failed");
    this.name = "AdminProviderCredentialTestError";
  }
}

type CredentialTesterOptions = Readonly<{
  network?: Omit<ProviderSafeFetchOptions, "configuration">;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized &&
    normalized.length <= MAX_MODEL_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function modelIdsFromCatalog(value: unknown, family: ProviderFamily): string[] {
  if (!isRecord(value)) {
    throw new AdminProviderCredentialTestError();
  }

  const entries = family === "gemini" ? value.models : value.data;
  if (!Array.isArray(entries) || entries.length > MAX_PROVIDER_CREDENTIAL_TEST_MODELS) {
    throw new AdminProviderCredentialTestError();
  }
  if (family === "gemini" && value.nextPageToken !== undefined) {
    throw new AdminProviderCredentialTestError();
  }

  const output: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const rawId = isRecord(entry)
      ? modelId(family === "gemini" ? entry.name : entry.id)
      : null;
    const id = family === "gemini" && rawId?.startsWith("models/")
      ? modelId(rawId.slice("models/".length))
      : rawId;
    if (!id) throw new AdminProviderCredentialTestError();
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(id);
  }
  return output;
}

function catalogPath(family: ProviderFamily): string {
  if (family === "openrouter") return "models/user";
  return family === "gemini" ? "models?pageSize=1000" : "models";
}

function authenticationHeaders(family: ProviderFamily, secret: string | null): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (secret === null) return headers;
  if (family === "anthropic") {
    headers.set("anthropic-version", "2023-06-01");
    headers.set("x-api-key", secret);
  } else if (family === "gemini") {
    headers.set("x-goog-api-key", secret);
  } else {
    headers.set("authorization", `Bearer ${secret}`);
  }
  return headers;
}

export function createAdminProviderCredentialTester(
  options: CredentialTesterOptions = {}
): AdminProviderCredentialTester {
  return {
    async test(input) {
      try {
        const connection = normalizeProviderConnectionConfiguration(input.connection);
        const authenticationMode = providerAuthenticationMode(connection);
        const secret = authenticationMode === "none"
          ? input.secret === null
            ? null
            : (() => { throw new AdminProviderCredentialTestError(); })()
          : input.secret === null
            ? (() => { throw new AdminProviderCredentialTestError(); })()
            : await resolveProviderCredentialSource(
                input.secret,
                "provider_credential_test_failed"
              );
        const fetchFn = createProviderSafeFetch({
          configuration: connection,
          ...options.network
        });
        const timeout = withTimeoutSignal(input.signal);
        try {
          const response = await fetchFn(`${connection.apiRoot}/${catalogPath(input.family)}`, {
            headers: authenticationHeaders(input.family, secret),
            method: "GET",
            redirect: "error",
            signal: timeout.signal
          });
          const text = await readBoundedResponseText(response, {
            maxBytes: Math.min(providerResponseMaxBytes(), MAX_CREDENTIAL_TEST_BODY_BYTES),
            signal: timeout.signal
          });
          if (!response.ok) throw new AdminProviderCredentialTestError();

          let catalog: unknown;
          try {
            catalog = JSON.parse(text) as unknown;
          } catch {
            throw new AdminProviderCredentialTestError();
          }
          return {
            method: "models_catalog",
            modelIds: modelIdsFromCatalog(catalog, input.family)
          };
        } finally {
          timeout.clear();
        }
      } catch {
        // Provider bodies, transport details, and credential-source errors are never surfaced.
        throw new AdminProviderCredentialTestError();
      }
    }
  };
}
