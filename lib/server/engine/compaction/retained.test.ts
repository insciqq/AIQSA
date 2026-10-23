import { describe, expect, it } from "vitest";
import { WORKSPACE_MCP_TOOL_ALLOWLIST } from "../../../domain/workspace";
import { namespacedMcpToolName } from "../../mcp/runPlan";
import { ARTIFACT_TOOL_NAME } from "../../tools/artifact";
import { READ_TOOL_RESULT_NAME } from "../../tools/readToolResult";
import { CREATE_SCHEDULED_TASK_TOOL_NAME } from "../../tools/scheduledTaskCreation";
import { MANAGE_SCHEDULED_TASK_TOOL_NAME } from "../../tools/scheduledTaskManagement";
import { LOAD_SKILL_TOOL_NAME, READ_SKILL_FILE_TOOL_NAME } from "../../tools/skill";
import { SAVE_SKILL_TOOL_NAME } from "../../tools/skillSave";
import { namespacedWorkspaceToolName } from "../../workspace/toolCatalog";
import { charTokens, handleFor, transcriptBuilder } from "./compaction.testFixtures";
import { toolOutputExcerpt } from "../toolResults";
import { APPROVAL_PENDING_TEXT } from "./items";
import {
  buildRetainedContext,
  buildStateBlock,
  COMPACTION_PRODUCT_TOOLS,
  defaultCompactionToolKind,
  defaultResultHandle,
  describeArguments,
  earlierUserMessages,
  estimateRetainedTokens,
  RETAINED_PREAMBLE,
  skillsInUse
} from "./retained";

const kind = (name: string, args: Record<string, unknown> = {}) => defaultCompactionToolKind({ arguments: JSON.stringify(args), name });
const workspace = namespacedWorkspaceToolName;

describe("default tool kinds", () => {
  it("names the product tools exactly as the tool modules do", () => {
    expect(COMPACTION_PRODUCT_TOOLS).toEqual({
      artifact: ARTIFACT_TOOL_NAME,
      loadSkill: LOAD_SKILL_TOOL_NAME,
      manageScheduledTask: MANAGE_SCHEDULED_TASK_TOOL_NAME,
      readSkillFile: READ_SKILL_FILE_TOOL_NAME,
      readToolResult: READ_TOOL_RESULT_NAME,
      saveSkill: SAVE_SKILL_TOOL_NAME,
      scheduledTask: CREATE_SCHEDULED_TASK_TOOL_NAME
    });
  });

  it("classifies every Workspace tool by its provider-facing alias and its original name", () => {
    const expected: Record<string, string> = {
      sandbox_exec: "workspace_command", sandbox_exec_start: "workspace_command", sandbox_shell: "workspace_command",
      sandbox_fs_copy: "workspace_write", sandbox_fs_mkdir: "workspace_write", sandbox_fs_remove: "workspace_write",
      sandbox_fs_rename: "workspace_write", sandbox_fs_write: "workspace_write",
      sandbox_fs_exists: "workspace_read", sandbox_fs_list: "workspace_read", sandbox_fs_read: "workspace_read",
      sandbox_fs_stat: "workspace_read"
    };
    for (const name of WORKSPACE_MCP_TOOL_ALLOWLIST) {
      expect(kind(workspace(name)), name).toBe(expected[name] ?? "other");
      expect(kind(name), name).toBe(expected[name] ?? "other");
    }
    expect(kind("sandbox_fs_teleport")).toBe("other");
  });

  it("classifies product tools, data-changing MCP tools, and secrets, Assistants and settings by verb", () => {
    expect(kind(ARTIFACT_TOOL_NAME)).toBe("artifact");
    expect(kind(LOAD_SKILL_TOOL_NAME)).toBe("skill_load");
    expect(kind(SAVE_SKILL_TOOL_NAME)).toBe("skill_change");
    expect(kind(CREATE_SCHEDULED_TASK_TOOL_NAME)).toBe("scheduled_task");
    expect(kind(MANAGE_SCHEDULED_TASK_TOOL_NAME, { action: "pause" })).toBe("scheduled_task");
    expect(kind(MANAGE_SCHEDULED_TASK_TOOL_NAME, { action: "list" })).toBe("other");
    expect(kind(namespacedMcpToolName("crm", "create_ticket"))).toBe("external_write");
    expect(kind(namespacedMcpToolName("crm", "searchTickets"))).toBe("other");
    expect(kind(namespacedMcpToolName("vault", "set_secret"))).toBe("secret");
    expect(kind(namespacedMcpToolName("vault", "list_secrets"))).toBe("other");
    expect(kind("update_assistant")).toBe("assistant");
    expect(kind("save_preferences")).toBe("settings");
    expect(kind("write_file")).toBe("workspace_write");
    expect(kind("fetch_url")).toBe("other");
  });

  it("describes arguments by identity, never by bodies or secret values", () => {
    expect(describeArguments(JSON.stringify({ content: "BODY", path: "/a.py", value: "sk_live_1", title: "T", tags: ["a", "b"] })))
      .toBe("path=\"/a.py\" title=\"T\" tags=\"a, b\"");
    expect(describeArguments("not json")).toBe("");
    // A long value keeps its end, where a query's filter or a path's file name sits.
    const query = "SELECT warehouse, region, gross, net_margin, units, share FROM settlements WHERE region = 'north' AND month = '2026-03'";
    expect(describeArguments(JSON.stringify({ query }))).toMatch(/^query="SELECT warehouse, region, gros.*….*month = '2026-03'"$/u);
  });
});

describe("state block", () => {
  function workedChat() {
    const chat = transcriptBuilder();
    chat.user("Fix the merge stage");
    chat.tool(workspace("sandbox_fs_read"), { path: "/workspace/project/data/ledger.csv" }, "a,b\n1,2");
    chat.tool(workspace("sandbox_fs_write"), { content: "SECRET-BODY-1", path: "/workspace/project/etl/merge.py" }, "{\"ok\":true}");
    chat.tool(workspace("sandbox_shell"), { command: "pytest -q" }, "{\"exit_code\":1,\"stdout\":\"1 failed\"}");
    chat.tool(workspace("sandbox_fs_write"), { content: "SECRET-BODY-2", path: "/workspace/project/etl/merge.py" }, "{\"ok\":true}");
    chat.tool(workspace("sandbox_fs_rename"), { from: "/workspace/project/old.csv", to: "/workspace/project/new.csv" }, "{}");
    chat.tool(workspace("sandbox_shell"), { command: "pytest -q" }, "{\"exit_code\":0}");
    chat.tool(ARTIFACT_TOOL_NAME, { files: [{ path: "index.html" }], intent: "create", kind: "html", title: "Q1 dashboard" },
      "{\"artifactId\":\"art_42\",\"versionId\":\"ver_7\"}");
    chat.tool(LOAD_SKILL_TOOL_NAME, { skill: "xlsx" }, "XLSX skill instructions");
    chat.tool(SAVE_SKILL_TOOL_NAME, { changeNote: "add totals", target: "ledger-report" }, "{\"skillId\":\"sk_1\"}");
    chat.tool(CREATE_SCHEDULED_TASK_TOOL_NAME, { prompt: "SECRET PROMPT", title: "Weekly margins" }, "{\"taskId\":\"task_9\"}");
    chat.tool(namespacedMcpToolName("crm", "create_ticket"), { title: "Refund 1001" }, "{\"id\":\"T-1001\",\"status\":\"open\"}");
    chat.tool(namespacedMcpToolName("crm", "send_email"), { to: "ops@example.test" }, "The process stopped", "unknown");
    chat.tool(namespacedMcpToolName("vault", "set_secret"), { name: "STRIPE_KEY", value: "sk_live_SECRET" }, "{\"ok\":true}");
    const handle = handleFor("margins");
    chat.tool("run_sql", { query: "SELECT warehouse, net_margin FROM settlements" },
      `| warehouse | net_margin |\n${"| W-1 | 1.00 |\n".repeat(200)}…[omitted; read_tool_result handle ${handle}]…`);
    chat.tool("run_pipeline", { stage: "validate" }, "ERR_SCHEMA_DRIFT_0x3F2: column settled_at type mismatch\nat stage validate", "error");
    chat.call(namespacedMcpToolName("crm", "update_deal"), { deal_id: "D-77" });
    return { chat, handle };
  }

  it("records files, commands, artifacts, Skills, tasks, changes, pending calls, large results and errors from the tool log", () => {
    const { chat, handle } = workedChat();
    const block = buildStateBlock(chat.items);
    expect(block.split("\n")[0]).toBe("## Recorded state (generated by the system from the tool log; exact)");
    for (const line of [
      "- /workspace/project/etl/merge.py: written ×2",
      "- /workspace/project/new.csv: renamed from /workspace/project/old.csv",
      "- /workspace/project/old.csv: renamed to /workspace/project/new.csv",
      "Files read:\n- /workspace/project/data/ledger.csv",
      "Workspace commands (latest 2 of 2):\n- `pytest -q` → exit 1\n- `pytest -q` → exit 0",
      `- ${ARTIFACT_TOOL_NAME} intent="create" kind="html" title="Q1 dashboard" → done (artifactId=art_42, versionId=ver_7)`,
      "Skills loaded:\n- xlsx",
      `- ${SAVE_SKILL_TOOL_NAME} changeNote="add totals" target="ledger-report" → done (skillId=sk_1)`,
      `- ${CREATE_SCHEDULED_TASK_TOOL_NAME} title="Weekly margins" → done (taskId=task_9)`,
      `- ${namespacedMcpToolName("vault", "set_secret")} name="STRIPE_KEY" → done`,
      `- ${namespacedMcpToolName("crm", "create_ticket")} title="Refund 1001" → done (id=T-1001)`,
      `- ${namespacedMcpToolName("crm", "send_email")} to="ops@example.test" → outcome unknown: check its effect before repeating it`,
      `- ${namespacedMcpToolName("crm", "update_deal")} deal_id="D-77" (call call_16): no result recorded yet`,
      `- ${handle}: run_sql query="SELECT warehouse, net_margin FROM settlements" (`,
      "Recent tool errors:\n- run_pipeline stage=\"validate\" → ERR_SCHEMA_DRIFT_0x3F2: column settled_at type mismatch"
    ]) expect(block).toContain(line);
    expect(block).not.toMatch(/SECRET|sk_live/u);
    // Short results are not listed, whatever handle scheme the loop passes.
    const everyHandle = buildStateBlock(chat.items, { resultHandle: (result) => handleFor(result.callId) });
    expect(everyHandle.match(/^- tor1_/gmu)).toHaveLength(1);
  });

  it("reads a call's latest result, as replay does, and lists a call waiting for approval as pending", () => {
    const chat = transcriptBuilder();
    const name = namespacedMcpToolName("crm", "create_ticket");
    const approved = chat.call(name, { title: "Refund 1001" });
    chat.result(approved, name, APPROVAL_PENDING_TEXT, "error");
    chat.result(approved, name, "{\"id\":\"T-1001\"}");
    const waiting = chat.call(name, { title: "Refund 1002" });
    chat.result(waiting, name, APPROVAL_PENDING_TEXT, "error");
    const block = buildStateBlock(chat.items);
    expect(block).toContain(`- ${name} title="Refund 1001" → done (id=T-1001)`);
    expect(block).toContain(`- ${name} title="Refund 1002" (call ${waiting}): waits for the user's approval when this record was made`);
    expect(block).not.toContain("Recent tool errors");
  });

  it("lists a result the engine saved whole by its handle and whole size", () => {
    const chat = transcriptBuilder();
    const handle = handleFor("dump");
    const whole = "row\n".repeat(10_000);
    const callId = chat.call("run_sql", { query: "SELECT * FROM ledger" });
    chat.items.push({ callId, handle, id: "r1", kind: "tool_result", name: "run_sql", outcome: "complete",
      output: toolOutputExcerpt(whole, { handle }).output });
    expect(buildStateBlock(chat.items)).toContain(`- ${handle}: run_sql query="SELECT * FROM ledger" (40,000 characters)`);
  });

  it("takes a result's saved handle from the item before any handle its text quotes", () => {
    expect(defaultResultHandle({ callId: "c", handle: handleFor("saved"), name: "x", output: `see ${handleFor("quoted")}` }))
      .toBe(handleFor("saved"));
    expect(defaultResultHandle({ callId: "c", name: "x", output: `see ${handleFor("quoted")}` })).toBe(handleFor("quoted"));
    expect(defaultResultHandle({ callId: "c", name: "x", output: "plain" })).toBeNull();
  });

  it("records the line of a failed result that names the failure", () => {
    const chat = transcriptBuilder();
    chat.tool("run_pipeline", { stage: "export" },
      "2026-04-11T03:17:40Z INFO job=JOB-1 stage=export rows=10\n2026-04-11T03:17:44Z ERROR job=JOB-7Q4M-2291 failed: upstream timeout\nmore", "error");
    expect(buildStateBlock(chat.items)).toContain("- run_pipeline stage=\"export\" → 2026-04-11T03:17:44Z ERROR job=JOB-7Q4M-2291 failed: upstream timeout");
  });

  it("records nothing for a conversation without tools, and takes the loop's classifier", () => {
    const chat = transcriptBuilder();
    chat.user("hello");
    chat.answer("hi");
    expect(buildStateBlock(chat.items)).toBe("");
    const { chat: worked } = workedChat();
    const quiet = buildStateBlock(worked.items, { classify: () => "other" });
    expect(quiet).not.toContain("Files changed");
    expect(quiet).toContain("Waiting when this record was made:");
    const throwing = buildStateBlock(worked.items, { classify: () => { throw new Error("classifier failed"); } });
    expect(throwing).toContain("Recent tool errors:");
  });
});

describe("earlier user messages and Skills in use", () => {
  it("keeps the newest messages before the cut within the budget, oldest first, cutting the boundary one", () => {
    const chat = transcriptBuilder();
    chat.user(`first ${"1".repeat(2_000)}`);
    chat.user(`second ${"2".repeat(600)}`);
    chat.user("third, while working", true);
    const keep = chat.user("kept in the tail");
    const text = earlierUserMessages(chat.items, keep, 1_200, charTokens);
    const lines = text.split("\n");
    expect(lines[0]).toBe("## Earlier user messages (verbatim, oldest first; later ones follow in the conversation)");
    expect(text).not.toContain("kept in the tail");
    expect(text).toContain("[3, follow-up during the work] third, while working");
    expect(text).toContain(`[2] second ${"2".repeat(600)}`);
    expect(text).toMatch(/\[1\] first 1+\n…\[[\d,]+ characters omitted\]…\n1+\n\[2\] second/u);
    expect(text.indexOf("[1]")).toBeLessThan(text.indexOf("[2]"));
    // A budget too small for the boundary message drops it and says so.
    const tight = earlierUserMessages(chat.items, keep, 700, charTokens);
    expect(tight).toContain("(1 older user message is covered by the summary only.)");
    expect(tight).not.toContain("[1]");
    expect(earlierUserMessages(chat.items, "i1", 1_000, charTokens)).toBe("");
    // Run context the server adds again on every run is not the user's words.
    const withContext = [{ id: "ctx-0", kind: "user" as const, text: "Skills index" }, ...chat.items];
    expect(earlierUserMessages(withContext, keep, 10_000, charTokens)).not.toContain("Skills index");
    expect(earlierUserMessages(withContext, keep, 10_000, charTokens, { runContext: () => false })).toContain("Skills index");
  });

  it("keeps the latest instructions of each Skill loaded before the cut, newest first within the budget", () => {
    const chat = transcriptBuilder();
    chat.tool(LOAD_SKILL_TOOL_NAME, { skill: "xlsx" }, "XLSX v1");
    chat.tool(LOAD_SKILL_TOOL_NAME, { skill: "pdf" }, `PDF ${"p".repeat(500)}`);
    chat.tool(LOAD_SKILL_TOOL_NAME, { skill: "xlsx" }, "XLSX v2");
    chat.tool(LOAD_SKILL_TOOL_NAME, { skill: "broken" }, "not found", "error");
    const keep = chat.user("tail");
    chat.tool(LOAD_SKILL_TOOL_NAME, { skill: "docx" }, "DOCX in the tail");
    const all = skillsInUse(chat.items, keep, 10_000, charTokens);
    expect(all).toContain("### xlsx\nXLSX v2");
    expect(all).not.toMatch(/XLSX v1|DOCX|broken/u);
    expect(all.indexOf("### pdf")).toBeLessThan(all.indexOf("### xlsx"));
    const tight = skillsInUse(chat.items, keep, 100, charTokens);
    expect(tight).toContain("### xlsx\nXLSX v2");
    expect(tight).toContain("Also loaded earlier, not repeated here: pdf (call load_skill again for the instructions).");
  });

  it("assembles the retained text and bounds its tokens for planning", () => {
    const chat = transcriptBuilder();
    chat.user(`question ${"q".repeat(3_000)}`);
    chat.tool(LOAD_SKILL_TOOL_NAME, { skill: "xlsx" }, "x".repeat(4_000));
    chat.tool("write_file", { path: "/workspace/project/a.txt" }, "ok");
    const keep = chat.user("tail");
    const retained = buildRetainedContext({ estimate: charTokens, items: chat.items, keepFromId: keep, skillTokens: 5_000,
      userMessageTokens: 5_000 });
    expect(retained.startsWith(`${RETAINED_PREAMBLE}\n\n## Recorded state`)).toBe(true);
    expect(retained.indexOf("## Skills loaded earlier")).toBeLessThan(retained.indexOf("## Earlier user messages"));
    const bound = estimateRetainedTokens(chat.items, keep, charTokens, { skillTokens: 5_000, stateTokens: 1_000, userMessageTokens: 2_000 });
    expect(bound).toBe(2_000 + (4_000 + 12) + 1_000);
    const empty = transcriptBuilder();
    const only = empty.user("first");
    expect(buildRetainedContext({ estimate: charTokens, items: empty.items, keepFromId: only, skillTokens: 1, userMessageTokens: 1 })).toBe("");
  });
});
