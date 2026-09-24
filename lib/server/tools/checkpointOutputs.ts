import type { RunTool } from "./types";

export const CHECKPOINT_OUTPUTS_TOOL_NAME = "checkpoint_outputs";
export const WORKSPACE_CHECKPOINT_LIMITS = Object.freeze({ files: 8, perRun: 16, descriptionCharacters: 300 });
export const checkpointOutputsTool: RunTool = {
  capability: "workspace", name: CHECKPOINT_OUTPUTS_TOOL_NAME, strict: false,
  description: "Save selected deliverables as downloadable intermediate results before a long or risky next step and before your final answer. " +
    "Choose exact files under /workspace/project/ or this run's /workspace/output/ directory. Inbox, hidden files and temporary/service directories are excluded. " +
    "Success confirms immutable stored bytes, not visual quality or task completion. The files remain available if this answer later fails or stops. " +
    "A later version requires a new checkpoint; equal filenames do not identify the same version. If reusing an existing capture, supply its exact capture_id and the same files.",
  inputSchema: { type: "object", additionalProperties: false, required: ["files", "description"], properties: {
    files: { type: "array", minItems: 1, maxItems: WORKSPACE_CHECKPOINT_LIMITS.files,
      items: { type: "string", minLength: 1, maxLength: 512 } },
    description: { type: "string", minLength: 1, maxLength: WORKSPACE_CHECKPOINT_LIMITS.descriptionCharacters },
    capture_id: { type: "string", pattern: "^[a-f0-9]{32}$",
      description: "Omit for a new capture. For reuse, copy the exact capture_id from an earlier successful tool result; never invent an identifier." }
  } }
};

export const WORKSPACE_CHECKPOINT_GUIDANCE = "Use checkpoint_outputs to save a useful intermediate deliverable before long or risky work and before the final answer. " +
  "Only a successful checkpoint result confirms durable downloadable bytes. A file on guest disk alone may be lost. " +
  "Checkpoints preserve exact versions independently of this answer's outcome; saving is not a quality check. " +
  "Continue from the exact authorized saved attachment when needed, without repeating completed preparation merely to recreate it.";
