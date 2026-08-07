import { randomBytes } from "node:crypto";
import type {
  McpJsonObject,
  McpSlotValue,
  McpToolInventoryEntry
} from "@/lib/contracts/mcp";
import { McpClientSessionError } from "./clientSession";
import { hashCanonicalMcpValue, validateMcpSlotValue } from "./definitions";
import type {
  McpDraftValidationOutcome,
  McpDraftValidator
} from "./draftValidator";
import { McpDraftValidationAbortedError } from "./draftValidator";
import {
  localResolvedArtifactJson,
  parseMcpLocalResolvedArtifact,
  type McpLocalResolvedArtifact
} from "./localArtifact";
import {
  getDefaultInFlightValidationWorkloadRegistry,
  type InFlightValidationWorkloadRegistry
} from "./inFlightValidationWorkloads";
import {
  createMcpLocalPackageResolver,
  type McpPackageResolution
} from "./localPackageResolver";
import type {
  McpRuntimeInventoryTool,
  McpRuntimeSession,
  McpRuntimeSessionFactory
} from "./runtimeCoordinator";
import {
  TOOLHIVE_EXPECTED_VERSION,
  ToolHiveClientError,
  type ToolHiveClient
} from "./toolhiveClient";
import {
  ToolHiveRuntimeError,
  type ToolHiveMcpRuntimeDriver
} from "./toolhiveRuntimeDriver";

const MAX_EVIDENCE_TOOLS = 256;
const MAX_DESCRIPTION_LENGTH = 2_048;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/u;
const DEFINITION_HASH_PATTERN = /^[a-f0-9]{64}$/u;

type LocalValidationClient = Pick<ToolHiveClient, "getWorkload" | "getWorkloadLogs">;
type LocalValidationDriver = Pick<
  ToolHiveMcpRuntimeDriver,
  "deleteOwnedWorkload" | "workloadName"
>;

export type McpLocalDraftValidatorOptions = Readonly<{
  client: LocalValidationClient;
  driver: LocalValidationDriver;
  packageResolver?: ReturnType<typeof createMcpLocalPackageResolver>;
  randomToken?: () => string;
  retentionRegistry?: InFlightValidationWorkloadRegistry;
  sessions: McpRuntimeSessionFactory;
}>;

function invalid(code: string, path: string): McpDraftValidationOutcome {
  return { issues: [{ code, path }], kind: "invalid" };
}

function environmentValue(value: McpSlotValue): string {
  return typeof value === "string" ? value : String(value);
}

function environmentForDraft(
  draft: Parameters<McpDraftValidator["validate"]>[0]["draft"],
  values: Readonly<Record<string, McpSlotValue>>
): { envVars: Record<string, string>; outcome: null } | {
  envVars: null;
  outcome: McpDraftValidationOutcome;
} {
  const envVars: Record<string, string> = {};
  const targets = new Set<string>();
  for (const [index, slot] of draft.slots.entries()) {
    if (slot.target.kind !== "environment") {
      return {
        envVars: null,
        outcome: invalid("mcp_local_environment_required", `slots.${index}.target`)
      };
    }
    if (targets.has(slot.target.name)) {
      return {
        envVars: null,
        outcome: invalid("mcp_local_environment_duplicate", `slots.${index}.target.name`)
      };
    }
    const value = values[slot.slotKey];
    if (typeof value === "undefined" || !validateMcpSlotValue(slot, value)) {
      return {
        envVars: null,
        outcome: invalid("mcp_effective_value_required", `values.${slot.slotKey}`)
      };
    }
    targets.add(slot.target.name);
    envVars[slot.target.name] = environmentValue(value);
  }
  return { envVars, outcome: null };
}

function sensitiveValues(
  draft: Parameters<McpDraftValidator["validate"]>[0]["draft"],
  values: Readonly<Record<string, McpSlotValue>>
): readonly string[] {
  return [...new Set(draft.slots.flatMap((slot) => {
    const value = values[slot.slotKey];
    return slot.sensitive && typeof value === "string" && value ? [value] : [];
  }))];
}

function inventoryFor(
  tools: readonly McpRuntimeInventoryTool[],
  secrets: readonly string[]
): { inventory: McpToolInventoryEntry[]; issue: null } | {
  inventory: [];
  issue: { code: string; path: string };
} {
  if (tools.length > MAX_EVIDENCE_TOOLS) {
    return { inventory: [], issue: { code: "mcp_local_inventory_limit", path: "tools" } };
  }
  const names = new Set<string>();
  const inventory: McpToolInventoryEntry[] = [];
  for (const [index, tool] of tools.entries()) {
    if (!TOOL_NAME_PATTERN.test(tool.name) || names.has(tool.name) ||
      !DEFINITION_HASH_PATTERN.test(tool.definitionHash) ||
      secrets.some((secret) => tool.name.includes(secret))) {
      return {
        inventory: [],
        issue: { code: "mcp_local_inventory_invalid", path: `tools.${index}` }
      };
    }
    const description = tool.description && !secrets.some((secret) => tool.description?.includes(secret))
      ? tool.description.slice(0, MAX_DESCRIPTION_LENGTH)
      : null;
    names.add(tool.name);
    inventory.push({ description, name: tool.name });
  }
  return { inventory, issue: null };
}

function packageArtifact(
  resolution: Extract<McpPackageResolution, { kind: "ok" }>["value"],
  imageRef: string
): McpLocalResolvedArtifact {
  return {
    exactVersion: resolution.exactVersion,
    imageRef,
    imageReferenceKind: "toolhive_generated_tag",
    kind: "toolhive_local",
    materializer: resolution.materializer,
    packageName: resolution.packageName,
    registryArtifactUrl: resolution.artifactUrl,
    registryIntegrity: resolution.integrity,
    sourceKind: resolution.sourceKind,
    toolhiveVersion: TOOLHIVE_EXPECTED_VERSION
  };
}

function safeFailure(error: unknown): McpDraftValidationOutcome {
  if (error instanceof McpClientSessionError) {
    return invalid(error.code, error.operation === "list_tools" ? "tools" : "source");
  }
  return invalid("mcp_local_validation_failed", "source");
}

const MISSING_ENVIRONMENT_PATTERNS = [
  /\bmissing(?:\s+required)?(?:\s+environment(?:\s+variable)?|\s+env(?:ironment)?(?:\s+variable)?)?\s*[:=-]?\s+([A-Z][A-Z0-9_]{1,127})\b/u,
  /\benvironment(?:\s+variable)?\s+([A-Z][A-Z0-9_]{1,127})\s+(?:is\s+)?(?:missing|required|not\s+set)\b/u,
  /\b([A-Z][A-Z0-9_]{1,127})(?:\s+environment\s+variable)?\s+(?:is\s+)?(?:missing|required|not\s+set)\b/u
] as const;

function missingEnvironmentName(logs: string): string | null {
  for (const pattern of MISSING_ENVIRONMENT_PATTERNS) {
    const match = pattern.exec(logs);
    if (match?.[1]) return match[1];
  }
  return null;
}

function environmentIssuePath(
  draft: Parameters<McpDraftValidator["validate"]>[0]["draft"],
  environmentName: string
): string {
  const index = draft.slots.findIndex((slot) =>
    slot.target.kind === "environment" && slot.target.name === environmentName
  );
  return index >= 0 ? `slots.${index}` : `slots.${environmentName}`;
}

async function localFailure(
  error: unknown,
  input: Readonly<{
    client: LocalValidationClient;
    draft: Parameters<McpDraftValidator["validate"]>[0]["draft"];
    exactKnownSecrets: readonly string[];
    workloadName: string;
  }>
): Promise<McpDraftValidationOutcome> {
  let logs = "";
  try {
    logs = await input.client.getWorkloadLogs(input.workloadName);
  } catch {
    // Workload output is optional evidence. Preserve the stable original error below.
  }

  const environmentName = missingEnvironmentName(logs);
  if (environmentName && !input.exactKnownSecrets.some((secret) =>
    secret.length > 0 && environmentName.includes(secret)
  )) {
    return invalid(
      "mcp_local_environment_missing",
      environmentIssuePath(input.draft, environmentName)
    );
  }
  if (logs.trim()) return invalid("mcp_local_process_failed", "source");
  if (error instanceof ToolHiveClientError || error instanceof ToolHiveRuntimeError) {
    return invalid(error.code, "source");
  }
  return safeFailure(error);
}

export function createLocalMcpDraftValidator(
  options: McpLocalDraftValidatorOptions
): McpDraftValidator {
  const resolvePackage = options.packageResolver ?? createMcpLocalPackageResolver();
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString("hex"));
  const retentionRegistry = options.retentionRegistry ??
    getDefaultInFlightValidationWorkloadRegistry();

  return {
    async validate(input) {
      const source = input.draft.source;
      if (source.kind === "remote") return invalid("mcp_local_source_required", "source.kind");
      if (input.draft.transport !== "stdio") return invalid("mcp_local_transport_required", "transport");
      if (input.draft.auth.mode === "oauth") return invalid("mcp_local_oauth_unsupported", "auth.mode");
      if (source.kind === "oci" && source.command?.length) {
        return invalid("oci_command_override_unsupported", "source.command");
      }

      const environment = environmentForDraft(input.draft, input.values);
      if (environment.envVars === null) return environment.outcome;

      if (source.kind !== "oci") await input.onProgress?.("resolving");
      const resolution = source.kind === "oci" ? null : await resolvePackage(source);
      if (resolution?.kind === "invalid") {
        return { issues: [resolution.issue], kind: "invalid" };
      }
      const launchImage = source.kind === "oci" ? source.image : resolution!.value.protocolImage;
      const generationToken = input.workloadToken ?? randomToken();
      if (!/^[a-z0-9]{24,64}$/u.test(generationToken)) {
        return invalid("mcp_local_validation_identity_invalid", "source");
      }

      const registration = retentionRegistry.register(generationToken);
      let session: McpRuntimeSession | null = null;
      try {
        await input.onProgress?.("preparing_runtime");
        session = await options.sessions.create({
          callTimeoutMs: input.draft.runtime.callTimeoutMs,
          fingerprint: generationToken.padEnd(64, "0").slice(0, 64),
          generationId: `validation-${generationToken}`,
          headers: {},
          onConnecting: () => input.onProgress?.("connecting") ?? Promise.resolve(),
          onToolsChanged() {},
          redactionValues: sensitiveValues(input.draft, input.values),
          retryAt: null,
          startupTimeoutMs: input.draft.runtime.startupTimeoutMs,
          toolHive: {
            cmdArguments: source.args,
            envVars: environment.envVars,
            generationToken,
            image: launchImage
          }
        });
        await input.onProgress?.("discovering_tools");
        const tools = await session.listTools();
        const secrets = sensitiveValues(input.draft, input.values);
        const serializedTools = JSON.stringify(tools);
        if (secrets.some((secret) => serializedTools.includes(secret))) {
          return invalid("mcp_local_inventory_unsafe", "tools");
        }
        const inventory = inventoryFor(tools, secrets);
        if (inventory.issue) return { issues: [inventory.issue], kind: "invalid" };

        const detail = await options.client.getWorkload(options.driver.workloadName(generationToken));
        const artifact: McpLocalResolvedArtifact = source.kind === "oci"
          ? {
              imageRef: source.image,
              imageReferenceKind: "oci_digest" as const,
              kind: "toolhive_local" as const,
              materializer: "oci" as const,
              sourceKind: "oci" as const,
              toolhiveVersion: TOOLHIVE_EXPECTED_VERSION
            }
          : packageArtifact(resolution!.value, detail.image);
        if (detail.image !== artifact.imageRef || !parseMcpLocalResolvedArtifact(artifact, source)) {
          return invalid("mcp_local_artifact_invalid", "source");
        }

        const definitionHashes = tools.map((tool) => tool.definitionHash).sort();
        const artifactJson = localResolvedArtifactJson(artifact);
        const evidence: McpJsonObject = {
          artifactIdentityHash: hashCanonicalMcpValue(artifactJson),
          materializer: artifact.materializer,
          toolCount: tools.length,
          toolDefinitionHashes: definitionHashes,
          toolInventoryHash: hashCanonicalMcpValue(
            tools.map((tool) => ({ definitionHash: tool.definitionHash, name: tool.name }))
              .sort((left, right) => left.name.localeCompare(right.name))
          ),
          transport: "stdio"
        };
        return {
          evidence,
          kind: "ok",
          resolvedArtifact: artifactJson,
          toolInventory: inventory.inventory
        };
      } catch (error) {
        if (error instanceof McpDraftValidationAbortedError) throw error;
        return await localFailure(error, {
          client: options.client,
          draft: input.draft,
          exactKnownSecrets: sensitiveValues(input.draft, input.values),
          workloadName: options.driver.workloadName(generationToken)
        });
      } finally {
        await session?.close().catch(() => undefined);
        await options.driver.deleteOwnedWorkload(generationToken).catch(() => undefined);
        registration.release();
      }
    }
  };
}
