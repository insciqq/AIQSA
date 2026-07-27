import type { AdminMcpServer } from "@/lib/contracts/mcp";

type Activation = NonNullable<AdminMcpServer["activation"]>;
type ActivationStage = Activation["stage"];
type TransientStage = Exclude<ActivationStage, "failed" | "ready">;
type PendingActivation = Activation & { stage: TransientStage };

const TRANSIENT_STAGES: ReadonlySet<ActivationStage> = new Set([
  "queued",
  "resolving",
  "preparing_runtime",
  "connecting",
  "discovering_tools",
  "publishing"
]);

const REMOTE_STAGES: readonly ActivationStage[] = [
  "queued",
  "connecting",
  "discovering_tools",
  "publishing"
];

const LOCAL_STAGES: readonly ActivationStage[] = [
  "queued",
  "resolving",
  "preparing_runtime",
  "connecting",
  "discovering_tools",
  "publishing"
];

const OCI_STAGES: readonly ActivationStage[] = [
  "queued",
  "preparing_runtime",
  "connecting",
  "discovering_tools",
  "publishing"
];

const STAGE_COPY: Record<TransientStage, Readonly<{
  detail: string;
  label: string;
}>> = {
  connecting: {
    detail: "Opening the MCP transport and completing its protocol handshake.",
    label: "Connecting"
  },
  discovering_tools: {
    detail: "Reading and validating the complete tool inventory exposed by this server.",
    label: "Discovering tools"
  },
  preparing_runtime: {
    detail: "Preparing the isolated runtime that will host this local MCP server.",
    label: "Preparing runtime"
  },
  publishing: {
    detail: "Publishing the tested immutable revision for use by AIQSA.",
    label: "Publishing revision"
  },
  queued: {
    detail: "The activation request was accepted and setup is starting in the background.",
    label: "Starting"
  },
  resolving: {
    detail: "Resolving the exact package or image artifact for this installation.",
    label: "Resolving artifact"
  }
};

export function isAdminMcpActivationPending(
  activation: AdminMcpServer["activation"]
): activation is PendingActivation {
  return Boolean(activation && TRANSIENT_STAGES.has(activation.stage));
}

export function adminMcpActivationVerb(server: AdminMcpServer): "Activating" | "Updating" {
  return server.activeRevision ? "Updating" : "Activating";
}

export function adminMcpActivationStage(server: AdminMcpServer): Readonly<{
  detail: string;
  label: string;
  step: number;
  total: number;
}> | null {
  const activation = server.activation;
  if (!activation || !isAdminMcpActivationPending(activation)) return null;

  const stages = server.draft.source.kind === "remote"
    ? REMOTE_STAGES
    : server.draft.source.kind === "oci"
      ? OCI_STAGES
      : LOCAL_STAGES;
  const stageIndex = stages.indexOf(activation.stage);
  const fallbackIndex = LOCAL_STAGES.indexOf(activation.stage);
  const index = stageIndex >= 0 ? stageIndex : Math.max(fallbackIndex, 0);
  const copy = STAGE_COPY[activation.stage];

  return {
    ...copy,
    step: Math.min(index + 1, stages.length),
    total: stages.length
  };
}
