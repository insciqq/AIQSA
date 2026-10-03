import type { AdminMcpServer } from "@/lib/contracts/mcp";

type Activation = NonNullable<AdminMcpServer["activation"]>;
type ActivationStage = Activation["stage"];
type TransientStage = Exclude<ActivationStage, "failed" | "ready">;
type PendingActivation = Activation & { stage: TransientStage };

const TRANSIENT_STAGES: readonly TransientStage[] = [
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
  publishing: {
    detail: "Applying the checked configuration for use in chats.",
    label: "Applying"
  },
  queued: {
    detail: "The activation request was accepted and setup is starting in the background.",
    label: "Starting"
  }
};

export function isAdminMcpActivationPending(
  activation: AdminMcpServer["activation"]
): activation is PendingActivation {
  return Boolean(activation && activation.stage !== "ready" && activation.stage !== "failed");
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

  const index = TRANSIENT_STAGES.indexOf(activation.stage);
  const copy = STAGE_COPY[activation.stage];

  return {
    ...copy,
    step: index + 1,
    total: TRANSIENT_STAGES.length
  };
}
