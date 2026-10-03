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
    detail: "Preparing the connection to this MCP server.",
    label: "Preparing"
  },
  publishing: {
    detail: "Applying the checked configuration for use in chats.",
    label: "Applying"
  },
  queued: {
    detail: "The activation request was accepted and setup is starting in the background.",
    label: "Starting"
  },
  resolving: {
    detail: "Checking the saved configuration before connecting.",
    label: "Checking configuration"
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

  // Stages outside the remote sequence come only from jobs written by an earlier release.
  const index = Math.max(REMOTE_STAGES.indexOf(activation.stage), 0);
  const copy = STAGE_COPY[activation.stage];

  return {
    ...copy,
    step: index + 1,
    total: REMOTE_STAGES.length
  };
}
