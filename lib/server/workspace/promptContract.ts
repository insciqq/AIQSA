import type { WorkspaceRunAdmissionPlan } from "./admission";
import { WORKSPACE_WEBSITE_ACTION_SAFETY } from "./browserGuidance";
import { WORKSPACE_GUIDE_PATHS } from "./guides";
import { WORKSPACE_BROWSER_SESSION_USER_PATH } from "./secrets/manifest";

export const WORKSPACE_GUIDANCE_VERSION = 1 as const;

/** Every Workspace run, with or without files, receives this. */
export const WORKSPACE_NO_REPLAY_SAFETY = "Historical context, including an unanswered question, does not authorize repeating settled or uncertain external actions. Check durable tool outcomes; never replay an ambiguous action automatically.";

/**
 * Facts come from admission and the authorized inbox query, never user flags.
 * The caller places other stable guidance between the two parts.
 */
export function workspacePromptContract(input: Readonly<{
  workspace: WorkspaceRunAdmissionPlan;
  currentAttachmentCount: number;
  hasIndexedFiles: boolean;
  hasEarlierExports: boolean;
  searchEnabled: boolean;
  fileContext: string;
}>): Readonly<{ stable: string; turn: string }> {
  const { workspace } = input;
  const toolName = (originalName: string) => workspace.toolDefinitions.find(tool => tool.originalName === originalName)?.namespacedName ?? originalName;
  // Keep common capabilities, rules and references before turn-specific paths
  // and optional context so provider caches can reuse the common prefix.
  const stable = [
    "A Workspace is available in this chat: a private Linux sandbox with a persistent disk, shell, Python, package managers, a headless browser and Office/PDF/image libraries. It starts on first use.",
    "Use it when the task needs real execution or files:",
    "- running or testing code, calculations on real data;",
    "- reading, converting or editing files (attachments are in /workspace/inbox);",
    "- producing a file for download;",
    "- working with a website or saved accesses.",
    "When correctness depends on a computation, run it rather than guess.",
    "Answer directly when the request is conversation, explanation, advice, writing or editing text, or a short snippet the user only needs to read.",
    "Try to answer directly first; if you find that you need to execute or verify something, use the Workspace.",
    `Working directory: ${workspace.normalized.projectDirectory}`,
    "Original attachments: /workspace/inbox",
    `Attachment index: ${workspace.normalized.inboxIndexPath}`,
    "Do not modify originals in inbox; copy files that need changes into project.",
    "You may install required packages through available package managers.",
    "Put user-downloadable files only in this turn's output directory.",
    "Links and special files in the output directory are not exported; put real files there (cp -L copies a link's target).",
    "After changing code or files in the Workspace, run appropriate tests or checks.",
    "Do not claim that a file was created or a check passed until a tool verified it.",
    `Use ${toolName("sandbox_shell")} for pipelines, redirects, &&, ||, globbing and heredocs; ${toolName("sandbox_exec")} runs one program directly without shell parsing.`,
    "Saved personal Workspace accesses are prepared automatically for personal chats; shared Projects do not receive personal secrets. SSH is configured for noninteractive use, and saved environment variables are available in each command and its child processes. Read /workspace/SECRETS.md for text secrets, environment names and exact original file/key paths. Use the accesses needed for the user's task. Values are not automatically included in this prompt. Do not copy managed secrets or the guide into project files or downloads unless the user requests it.",
    `Before creating or editing XLSX, DOCX or PPTX files, read ${WORKSPACE_GUIDE_PATHS.office}.`,
    `Before driving a website, read ${WORKSPACE_GUIDE_PATHS.browser}.`,
    WORKSPACE_BROWSER_SESSION_USER_PATH,
    `Before working with PSD files, read ${WORKSPACE_GUIDE_PATHS.psd}.`,
    `Before building, changing or saving a reusable script Skill, read ${WORKSPACE_GUIDE_PATHS.skills}.`,
    WORKSPACE_WEBSITE_ACTION_SAFETY,
    WORKSPACE_NO_REPLAY_SAFETY,
    "When you create a user-facing file, mention its filename in the answer. Do not create sandbox:, file: or local filesystem download links and do not repeat a \"Files for download\" list: the interface lists successfully exported files as downloads automatically."
  ];
  const conditional = [
    `This turn's output directory: ${workspace.normalized.outputDirectory}.`,
    `Internet inside the workspace: ${workspace.normalized.internetEnabled ? "enabled (public destinations only)" : "disabled"}.`,
    ...(input.currentAttachmentCount > 0 ? [`Current message manifest: ${workspace.normalized.messageManifestPath}`] : []),
    ...(input.hasIndexedFiles && input.fileContext ? [input.fileContext] : []),
    ...(input.hasEarlierExports ? ["The inbox index also lists earlier completed exports from this conversation, marked source=export with their producing message and date. Read that index to find the requested earlier result; the current output directory starts fresh and does not describe export history. Use the indexed canonical copy when revising an earlier export, then write a new result to the current output directory. Never claim previous exports are lost solely because the current output directory is empty."] : []),
    ...(input.searchEnabled ? ["Web search is available in this chat as its own tool. Use it to look things up. Use the Workspace browser when you need to work with a specific site: sign in, fill in a form, go through several pages."] : [])
  ];
  return { stable: stable.join("\n"), turn: conditional.join("\n") };
}
