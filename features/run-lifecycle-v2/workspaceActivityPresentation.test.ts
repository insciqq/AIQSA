import { describe, expect, it } from "vitest";
import { decodeThreadWorkspaceActivity, type ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import {
  aggregateWorkspaceActivityV2,
  presentWorkspaceActivityV2,
  visibleWorkspaceActivityV2,
  workspaceActivityLabelV2,
  workspaceBrowserStepPhraseV2,
  workspaceBrowserStepsV2,
  workspaceCodeMcpCopyV2,
  workspaceActiveLabelV2,
  workspaceLiveLabelV2,
  workspaceOutputSkipsCopyV2,
  workspaceOutputStatusCopyV2,
  workspacePlanSummaryV2,
  workspacePlanV2,
  workspaceProcessLabelV2
} from "./workspaceActivityPresentation";

describe("code MCP activity copy", () => {
  it("names tools and counts, unlisted calls, failures and budget refusals", () => {
    expect(workspaceCodeMcpCopyV2({ calls: 12, failed: 2, refused: 3, tools: [
      { calls: 10, failed: 2, toolName: "list_commits" }] })).toBe(
      "MCP calls from code: 12 · list_commits ×10 (2 failed), 2 more · 2 failed · 3 refused, call budget used up");
    expect(workspaceCodeMcpCopyV2({ calls: 0, failed: 0, refused: 1, tools: [] }))
      .toBe("MCP calls from code: 0 · 1 refused, call budget used up");
  });
});

const command = (id: string, phase: ThreadWorkspaceActivityEntry["phase"], preview = "npm test"): ThreadWorkspaceActivityEntry =>
  ({ command: { preview }, id, kind: "command", phase });

describe("browser steps in Workspace activity", () => {
  const browser = (phase: ThreadWorkspaceActivityEntry["phase"], stdoutPreview: string, preview = "aiqsa-browser click 7"): ThreadWorkspaceActivityEntry =>
    ({ command: { preview, stdoutPreview }, id: "browser", kind: "command", phase });

  it("reads the helper's step lines, exactly as aiqsa.browser prints them, and ignores everything else", () => {
    const output = [
      '[browser #3] click: button "Add to cart" @ www.saucedemo.com/inventory.html',
      "URL: https://www.saucedemo.com/inventory.html",
      '[7] button "Add to cart"',
      "[browser #4] open @ www.amazon.es/",
      '[browser #12] type: textbox "Email @ work" (13 characters) @ 127.0.0.1:8080/a%20b',
      "[browser #5] back",
      "[browser #x] click: forged",
      "  [browser #6] click: indented"
    ].join("\n");
    expect(workspaceBrowserStepsV2(browser("succeeded", output))).toEqual([
      { number: 3, action: "click", target: 'button "Add to cart"', where: "www.saucedemo.com/inventory.html" },
      { number: 4, action: "open", where: "www.amazon.es/" },
      { number: 12, action: "type", target: 'textbox "Email @ work" (13 characters)', where: "127.0.0.1:8080/a%20b" },
      { number: 5, action: "back" }
    ]);
    expect(workspaceBrowserStepsV2(command("plain", "succeeded"))).toEqual([]);
  });

  it("labels a finished browser command by what it did, and keeps failures and running commands as commands", () => {
    expect(workspaceActivityLabelV2(browser("succeeded", '[browser #3] click: button "Add to cart" @ shop.example/cart\nURL: x')))
      .toBe('Browser: Clicked button "Add to cart"');
    expect(workspaceActivityLabelV2(browser("succeeded", "[browser #1] open @ shop.example/\n[browser #2] type: textbox \"Login\" (5 characters) @ shop.example/\n[browser #3] save_session: shop.example @ shop.example/account",
      "python3 -c 'from aiqsa import browser'"))).toBe("Browser: 3 steps, last: Saved the sign-in for shop.example");
    expect(workspaceActivityLabelV2(browser("failed", "[browser #3] click: button \"X\" @ a.example/"))).toBe("aiqsa-browser click 7 failed");
    expect(workspaceActivityLabelV2(browser("running", ""))).toBe("Running aiqsa-browser click 7…");
    expect(workspaceBrowserStepPhraseV2({ number: 1, action: "open", where: "www.amazon.es/" })).toBe("Opened www.amazon.es/");
    expect(workspaceBrowserStepPhraseV2({ number: 2, action: "select", target: '"2" in combobox "Quantity"' }))
      .toBe('Selected "2" in combobox "Quantity"');
    expect(workspaceBrowserStepPhraseV2({ number: 3, action: "screenshot", target: "page" })).toBe("Took a screenshot");
    expect(workspaceBrowserStepPhraseV2({ number: 4, action: "teleport" })).toBe("Browser step: teleport");
  });
});

describe("workspace activity presentation", () => {
  it("hides successful empty lifecycle bookkeeping without changing the source receipts", () => {
    const activity = { entries: [
      { id: "start", kind: "workspace_start", phase: "succeeded" },
      { id: "empty-export", kind: "outputs_export", phase: "succeeded", count: 0 },
      { id: "closed", kind: "execution_status", phase: "closed" }
    ], outputStatus: { state: "complete" } } as const;
    expect(visibleWorkspaceActivityV2(activity)).toBeNull();
    expect(visibleWorkspaceActivityV2({ entries: [], outputStatus: { state: "complete" } })).toBeNull();
    expect(activity.entries).toHaveLength(3);
    expect(workspaceLiveLabelV2(activity)).toBeNull();
  });

  it("keeps real steps, exported files, and unresolved outcomes visible", () => {
    const closed = { id: "closed", kind: "execution_status", phase: "closed" } as const;
    const command = { id: "command", kind: "command", phase: "failed", command: { preview: "run.sh" } } as const;
    const activity = { entries: [command, closed], outputStatus: { state: "complete" } } as const;
    expect(visibleWorkspaceActivityV2(activity)?.entries).toEqual([command]);
    expect(visibleWorkspaceActivityV2({ entries: [closed], outputStatus: { state: "complete" } }, 1)?.entries).toEqual([]);
    expect(visibleWorkspaceActivityV2({ entries: [{ id: "export", kind: "outputs_export", phase: "succeeded", count: 1 }] }))
      .not.toBeNull();
    expect(visibleWorkspaceActivityV2({ entries: [{ id: "unknown", kind: "execution_status", phase: "unknown" }] }))
      .not.toBeNull();
    expect(visibleWorkspaceActivityV2({ entries: [{ id: "failed", kind: "workspace_start", phase: "failed" }] }))
      .not.toBeNull();
    expect(visibleWorkspaceActivityV2({ entries: [], outputStatus: { state: "failed" } })).not.toBeNull();
  });

  it("keeps an export that skipped links or special files visible and says what was left out", () => {
    const linksOnly = { count: 0, id: "export", kind: "outputs_export", phase: "succeeded", skipped: { link: 1 } } as const;
    expect(visibleWorkspaceActivityV2({ entries: [linksOnly], outputStatus: { state: "complete" } })?.entries).toEqual([linksOnly]);
    expect(workspaceActivityLabelV2(linksOnly)).toBe("No files exported");
    expect(workspaceActivityLabelV2({ ...linksOnly, count: 1 })).toBe("Exported 1 file");
    expect(workspaceOutputSkipsCopyV2(linksOnly.skipped)).toBe("1 link not exported");
    expect(workspaceOutputSkipsCopyV2({ link: 2, special: 1 })).toBe("2 links and 1 special file not exported");
    expect(workspaceOutputSkipsCopyV2({ special: 3 })).toBe("3 special files not exported");
    expect(workspaceOutputSkipsCopyV2(undefined)).toBeNull();
  });

  it("shows a failed discovery instead of claiming tools were found", () => {
    const failed = { id: "discovery", kind: "mcp_call", phase: "failed", mcp: { discovery: true, toolName: "find_tools" } } as const;
    expect(workspaceActivityLabelV2(failed)).toBe("Tool discovery failed");
  });

  it("keeps output freshness when a cold terminal update arrives before its output snapshots", () => {
    const updates = [
      { ...command("a", "running"), command: { preview: "npm test", stdoutPreview: "old" }, sequence: 1 },
      { ...command("a", "running"), command: { preview: "…", stdoutPreview: "latest" }, sequence: 2 },
      { ...command("a", "succeeded"), command: { exitCode: 0, preview: "…" }, sequence: 3 }
    ];
    const event = (payload: ThreadWorkspaceActivityEntry) => ({ data: { artifactType: "workspace_activity", payload }, type: "artifact" });
    const forward = presentWorkspaceActivityV2(updates.map(event));
    const reordered = presentWorkspaceActivityV2([updates[2]!, updates[0]!, updates[1]!].map(event));
    expect(reordered).toEqual(forward);
    expect(reordered?.entries[0]?.command?.stdoutPreview).toBe("latest");
    const snapshot = presentWorkspaceActivityV2([updates[2]!, updates[0]!].map(event));
    expect(presentWorkspaceActivityV2([event(updates[1]!)], decodeThreadWorkspaceActivity(snapshot))).toEqual(forward);
  });

  it("restores original row order after reordered starts and later completion of the first command", () => {
    const updates = [
      { ...command("a", "running"), sequence: 1 },
      { ...command("b", "running"), sequence: 2 },
      { ...command("a", "succeeded"), sequence: 3 }
    ];
    const events = [updates[1]!, updates[2]!, updates[0]!].map((payload) => ({ data: { artifactType: "workspace_activity", payload }, type: "artifact" }));
    expect(presentWorkspaceActivityV2(events)?.entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("uses durable sequence in both merge directions and preserves command facts on replay", () => {
    const running = { ...command("a", "running"), command: { cwd: "project", preview: "npm test" }, sequence: 3, startedAt: "2026-09-04T10:00:00.000Z" };
    const terminal = { ...command("a", "failed", "…"), command: { exitCode: 1, preview: "…", stdoutPreview: "bounded output" }, sequence: 7 };
    const event = (payload: ThreadWorkspaceActivityEntry) => ({ data: { artifactType: "workspace_activity", payload }, type: "artifact" });
    const expected = { entries: [{ ...terminal, command: { ...terminal.command, cwd: "project", outputSequence: 7, preview: "npm test" }, firstSequence: 3, startedAt: running.startedAt }] };
    expect(presentWorkspaceActivityV2([event(terminal)], { entries: [running] })).toEqual(expected);
    expect(presentWorkspaceActivityV2([event(running)], { entries: [terminal] })).toEqual(expected);
    expect(presentWorkspaceActivityV2([event(terminal), event(running), event(terminal)], expected)).toEqual(expected);
    expect(presentWorkspaceActivityV2([event(terminal), event(running)])).toEqual(expected);
    // Freshness also orders conflicting terminal observations, with no phase ranking.
    expect(presentWorkspaceActivityV2([event({ ...terminal, phase: "cancelled", sequence: 9 })], expected)?.entries[0]?.phase).toBe("cancelled");
  });

  it("retains the authoritative run-outcome projection when its underlying running event is replayed", () => {
    const running = { ...command("a", "running"), sequence: 4 };
    const cancelled = { ...running, phase: "cancelled" as const, runOutcome: "cancelled" as const };
    const event = { data: { artifactType: "workspace_activity", payload: running }, type: "artifact" };
    expect(presentWorkspaceActivityV2([event], { entries: [cancelled] })).toEqual({ entries: [{ ...cancelled, firstSequence: 4 }] });
  });

  it("retains one bounded output snapshot across reordered delivery and an update without output", () => {
    const initial = { ...command("a", "running"), command: { preview: "npm test", stderrPreview: "e".repeat(8 * 1024) }, sequence: 1 };
    const terminal = { ...command("a", "succeeded", "…"), command: { exitCode: 0, preview: "…", stdoutPreview: "o".repeat(8 * 1024) }, sequence: 2 };
    const close = { ...terminal, command: { exitCode: 0, preview: "…" }, sequence: 3 };
    const events = [initial, terminal, close, initial].map((payload) => ({ data: { artifactType: "workspace_activity", payload }, type: "artifact" }));
    const activity = presentWorkspaceActivityV2(events);
    expect(decodeThreadWorkspaceActivity(activity)).toEqual(activity);
    expect(activity?.entries[0]?.command).toMatchObject({ exitCode: 0, outputSequence: 2, preview: "npm test" });
    expect(activity?.entries[0]?.command?.stdoutPreview).toBe(terminal.command.stdoutPreview);
    expect(activity?.entries[0]?.command?.stderrPreview).toBeUndefined();
  });
  it("phrases every kind and phase in plain language", () => {
    expect(workspaceActivityLabelV2(command("a", "running"))).toBe("Running npm test…");
    expect(workspaceActivityLabelV2(command("a", "succeeded"))).toBe("Ran npm test");
    expect(workspaceActivityLabelV2(command("a", "failed"))).toBe("npm test failed");
    expect(workspaceActivityLabelV2(command("a", "cancelled"))).toBe("Stopped npm test");
    expect(workspaceActivityLabelV2(command("a", "succeeded", "x".repeat(120)))).toBe(`Ran ${"x".repeat(79)}…`);
    // Inline code reads as its language and a multi-line command as its first line; the card keeps the whole command.
    expect(workspaceActivityLabelV2(command("a", "succeeded", "python -c \"data={\\n'page':'''557a947a'''}\""))).toBe("Ran Python code");
    expect(workspaceActivityLabelV2(command("a", "running", "cd project && python3 - <<'EOF'\nprint(1)\nEOF"))).toBe("Running Python code…");
    expect(workspaceActivityLabelV2(command("a", "failed", "node -e 'console.log(1)'"))).toBe("JavaScript code failed");
    expect(workspaceActivityLabelV2(command("a", "succeeded", "cat > a.txt <<'EOF'\nhello\nEOF"))).toBe("Ran cat > a.txt <<'EOF' …");
    expect(workspaceActivityLabelV2(command("a", "succeeded", "python script.py"))).toBe("Ran python script.py");
    expect(workspaceActivityLabelV2({ file: { displayPath: "project/a.ts" }, id: "b", kind: "file_read", phase: "succeeded" })).toBe("Read project/a.ts");
    expect(workspaceActivityLabelV2({ file: { displayPath: "inbox/report.xlsx", targetPath: "project/report.xlsx" }, id: "c", kind: "file_copy", phase: "succeeded" }))
      .toBe("Copied inbox/report.xlsx → project/report.xlsx");
    expect(workspaceActivityLabelV2({ file: { displayPath: "project/tmp.txt" }, id: "d", kind: "file_check", phase: "failed" })).toBe("Could not check project/tmp.txt");
    expect(workspaceActivityLabelV2({ count: 3, id: "e", kind: "attachments_prepare", phase: "running" })).toBe("Preparing 3 attachments…");
    expect(workspaceActivityLabelV2({ count: 1, id: "f", kind: "attachments_prepare", phase: "succeeded" })).toBe("Prepared 1 attachment");
    expect(workspaceActivityLabelV2({ count: 2, id: "g", kind: "outputs_export", phase: "running" })).toBe("Exporting 2 files…");
    expect(workspaceActivityLabelV2({ id: "h", kind: "workspace_start", phase: "succeeded" })).toBe("Workspace ready");
    expect(workspaceActivityLabelV2({ id: "i", kind: "workspace_recreated", phase: "succeeded" })).toBe("Workspace was recreated");
    expect(workspaceActivityLabelV2({ id: "j", kind: "workspace_stopped", phase: "cancelled" })).toBe("Workspace work stopped");
  });

  it("says a patch that did not finish changed nothing it claims", () => {
    const one = { changes: [{ action: "add", displayPath: "project/a.ts" }], count: 1, id: "p", kind: "file_change" } as const;
    const two = { changes: [{ action: "update", displayPath: "project/a.ts" }, { action: "delete", displayPath: "project/b.ts" }], count: 2,
      id: "q", kind: "file_change" } as const;
    expect(workspaceActivityLabelV2({ ...one, phase: "running" })).toBe("Changing project/a.ts");
    expect(workspaceActivityLabelV2({ ...one, phase: "succeeded" })).toBe("Created project/a.ts");
    expect(workspaceActivityLabelV2({ ...one, phase: "failed" })).toBe("Could not finish changing project/a.ts");
    expect(workspaceActivityLabelV2({ ...two, phase: "succeeded" })).toBe("Edited 2 files");
    expect(workspaceActivityLabelV2({ ...two, phase: "failed" })).toBe("Could not finish changing 2 files");
    expect(workspaceActivityLabelV2({ ...two, phase: "cancelled" })).toBe("Changing 2 files stopped");
  });

  it("keeps the answer's plan out of the Workspace feed and offers its latest version", () => {
    const plan = { id: "plan:run", items: [{ completed: true, text: "Read" }, { active: true, completed: false, text: "Chart" }], kind: "plan",
      phase: "running" } as const;
    const onlyPlan = { entries: [plan] };
    expect(visibleWorkspaceActivityV2(onlyPlan)).toBeNull();
    expect(workspaceLiveLabelV2(onlyPlan)).toBeNull();
    expect(workspacePlanV2(onlyPlan)).toEqual(plan);
    expect(workspacePlanSummaryV2(plan)).toBe("Plan · 1 of 2 complete");
    const withWork = { entries: [plan, command("c", "running")] };
    expect(visibleWorkspaceActivityV2(withWork)?.entries).toEqual([command("c", "running")]);
    expect(workspaceLiveLabelV2(withWork)).toBe("Running npm test…");
    expect(workspacePlanV2({ entries: [{ ...plan, items: [] }] })).toBeNull();
    expect(workspacePlanV2(null)).toBeNull();
  });

  it("retains newer persisted entries and adds unseen live steps", () => {
    const events = [
      { data: { artifactType: "workspace_activity", payload: command("a", "running") }, type: "artifact" },
      { data: { artifactType: "workspace_activity", payload: command("b", "running", "pytest") }, type: "artifact" },
      { data: { artifactType: "tool_call", payload: { serverName: "Workspace", status: "requested" } }, type: "artifact" }
    ];
    expect(presentWorkspaceActivityV2(events, null)).toEqual({
      entries: [command("a", "running"), command("b", "running", "pytest")]
    });
    expect(presentWorkspaceActivityV2(events, {
      entries: [{ ...command("a", "succeeded"), sequence: 1 }],
      outputStatus: { state: "complete" }
    })).toEqual({
      entries: [{ ...command("a", "succeeded"), firstSequence: 1, sequence: 1 }, command("b", "running", "pytest")],
      outputStatus: { state: "complete" }
    });
    expect(presentWorkspaceActivityV2([], null)).toBeNull();
    expect(workspaceLiveLabelV2(presentWorkspaceActivityV2(events, null))).toBe("Running pytest…");
    expect(workspaceLiveLabelV2({ entries: [command("a", "succeeded")] })).toBe("Working in Workspace…");
    expect(workspaceActiveLabelV2(presentWorkspaceActivityV2(events, null))).toBe("Running pytest…");
    expect(workspaceActiveLabelV2({ entries: [command("a", "succeeded")] })).toBeNull();
  });

  it("aggregates consecutive successful checks and keeps failures visible", () => {
    const check = (id: string, phase: ThreadWorkspaceActivityEntry["phase"]): ThreadWorkspaceActivityEntry =>
      ({ durationMs: 10, file: { displayPath: `project/${id}.txt` }, id, kind: "file_check", phase });
    const rows = aggregateWorkspaceActivityV2([check("a", "succeeded"), check("b", "succeeded"), check("c", "failed"), check("d", "succeeded")]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ count: 2, durationMs: 20, id: "a" });
    expect(workspaceActivityLabelV2(rows[0]!)).toBe("Checked 2 files");
    expect(rows[1]).toMatchObject({ id: "c", phase: "failed" });
    expect(workspaceActivityLabelV2(rows[2]!)).toBe("Checked project/d.txt");
  });

  it("labels the fold and the output status", () => {
    expect(workspaceProcessLabelV2({ live: true, workDurationMs: 1_000 })).toBe("Working in Workspace…");
    expect(workspaceProcessLabelV2({ live: false, workDurationMs: 42_000 })).toBe("Worked in Workspace for 42s");
    expect(workspaceOutputStatusCopyV2({ state: "exporting" }, 2)).toBe("Exporting 2 files…");
    expect(workspaceOutputStatusCopyV2({ state: "retrying" })).toContain("still being prepared");
    expect(workspaceOutputStatusCopyV2({ state: "failed" })).toContain("could not be prepared");
    expect(workspaceOutputStatusCopyV2({ state: "complete" })).toBeNull();
    expect(workspaceOutputStatusCopyV2(undefined)).toBeNull();
  });
});
