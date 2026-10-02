import { syntheticImagePlan } from "@/tests/support/imagePlan";
import { describe, expect, it } from "vitest";
import type { ProviderRunRequest } from "../providers/types";
import { textMessageContent } from "@/lib/domain/content";
import { agentPrompts } from "./prompt";
import { mcpToolIndexGuidance } from "../mcp/discovery";
import { withSelectedSkillContext } from "../skills/userContext";
import type { WorkspaceRunAdmissionPlan } from "../workspace/admission";
import { WORKSPACE_NO_REPLAY_SAFETY, workspacePromptContract } from "../workspace/promptContract";
import { WORKSPACE_CHECKPOINT_GUIDANCE } from "../tools/checkpointOutputs";
import { visionAnalysisGuidance } from "../tools/analyzeImage";
import { toolHistoryMessage, type ToolHistoryBlock } from "../runs/toolHistory";

describe("Codex conversation delivery", () => {
  it("offers first-party analysis to text-only Agent without claiming to see pixels", () => {
    const request = { content: textMessageContent("Inspect the file"), attachments: [], prompt: { system: "baseline" },
      workspace: {}, agent: { mcpMode: "off", imageInput: false },
      visionAnalysis: { version: 1, available: false, code: "vision_model_absent" } } as unknown as ProviderRunRequest;
    expect(agentPrompts(request).developerInstructions).toContain("do not claim to see their pixels yourself");
    expect(agentPrompts(request).developerInstructions).toContain("even when external MCP is Off");
    expect(agentPrompts({ ...request, agent: { ...request.agent!, imageInput: true } }).developerInstructions).toContain("direct image viewer first");
  });
  it("explains authorized image reuse and forbids regenerating an unconfirmed paid result", () => {
    const request = { content: textMessageContent("Create a picture"), attachments: [], prompt: { system: "baseline" },
      imagePlan: syntheticImagePlan() } as unknown as ProviderRunRequest;
    const prompt = agentPrompts(request).developerInstructions;
    expect(prompt).toContain("workspace_path");
    expect(prompt).toContain("image_id as asset_ref");
    expect(prompt).toContain("Do not regenerate");
    expect(prompt).not.toContain(request.imagePlan!.authority.credentialId);
  });
  it("explains explicit Workspace bundle submission only when artifacts were admitted", () => {
    const request = { content: textMessageContent("Build a page"), attachments: [], prompt: { system: "baseline" } } as unknown as ProviderRunRequest;
    expect(agentPrompts(request).developerInstructions).not.toContain("files[].text");
    const prompt = agentPrompts({ ...request, artifactTool: true }).developerInstructions;
    expect(prompt).toContain("files[].text");
    expect(prompt).toContain("do not authorize host file reads");
    expect(prompt).toContain("external MCP is Off");
  });
  it("keeps pinned bundles at user authority and delegates available discovery to Codex on start and resume", () => {
    const messages = withSelectedSkillContext([
      { id: "earlier", role: "assistant", content: textMessageContent("Earlier answer") },
      { id: "current", role: "user", content: textMessageContent("Use the reference when needed") }
    ], [{ skillId: "pin", revisionId: "revision", name: "Pinned guide", instructions: "PINNED_BODY_CANARY",
      alias: "pinned-guide", workspacePath: "/workspace/.aiqsa/skills/pinned-guide", fileCount: 1,
      files: [{ path: "references/guide.txt", byteSize: 23, executable: false, kind: "text" }] }], {
      catalog: "<available_skills>ORDINARY_CATALOG_CANARY</available_skills>"
    });
    const request = { content: textMessageContent("Use the reference when needed"), attachments: [],
      prompt: { system: "baseline" }, context: { messages } } as unknown as ProviderRunRequest;
    const result = agentPrompts(request);
    expect(result.previousAssistantMessageId).toBe("earlier");
    for (const prompt of [result.prompt, result.resumePrompt]) {
      expect(prompt.match(/PINNED_BODY_CANARY/gu)).toHaveLength(1);
      expect(prompt).toContain('bundle_path=\\"/workspace/.aiqsa/skills/pinned-guide\\"');
      expect(prompt).toContain('"role":"user"');
      expect(prompt).not.toContain("ORDINARY_CATALOG_CANARY");
      expect(prompt).not.toMatch(/load_skill|read_skill_file/u);
    }
    expect(result.developerInstructions).not.toContain("PINNED_BODY_CANARY");
    expect(result.developerInstructions).not.toContain("references/guide.txt");
    expect(result.developerInstructions).toContain("current native Codex catalog");
    expect(result.developerInstructions).toContain("user-level guidance");
    expect(result.developerInstructions).not.toMatch(/load_skill|read_skill_file|ORDINARY_CATALOG_CANARY/u);
  });
  it("does not advertise a missing message manifest on attachment-free turns", () => {
    const request = { content: textMessageContent("Read an issue"), attachments: [], prompt: { system: "baseline" },
      workspace: { outputDirectory: "/workspace/output/current", inboxIndexPath: "/workspace/inbox/index.json",
        messageManifestPath: "/workspace/inbox/messages/current/manifest.json" } } as unknown as ProviderRunRequest;
    const result = agentPrompts(request);
    for (const prompt of [result.prompt, result.resumePrompt]) {
      expect(prompt).not.toContain("messageManifestPath");
      expect(prompt).toContain('"inboxIndexPath":"/workspace/inbox/index.json"');
      expect(prompt).toContain('"attachments":[]');
      expect(prompt).toContain("No attachments on this turn does not mean earlier sources are absent");
      expect(prompt).toContain("never filename alone");
    }
  });

  it.each([
    { currentFile: false, earlierFiles: false, search: false },
    { currentFile: false, earlierFiles: false, search: true },
    { currentFile: false, earlierFiles: true, search: false },
    { currentFile: true, earlierFiles: false, search: true }
  ])("delivers the admitted modern Workspace contract once on start and resume: %j", ({ currentFile, earlierFiles, search }) => {
    const workspace = { guidanceVersion: 1, outputDirectory: "/workspace/output/current",
      inboxIndexPath: "/workspace/inbox/index.json", messageManifestPath: "/workspace/inbox/messages/current/manifest.json",
      projectDirectory: "/workspace/project", internetEnabled: true } as const;
    const hasIndexedFiles = currentFile || earlierFiles;
    const visionAnalysis = { version: 1, available: false, code: "vision_model_absent" } as const;
    const admittedContract = workspacePromptContract({
      workspace: { normalized: workspace, toolDefinitions: [] } as unknown as WorkspaceRunAdmissionPlan,
      agent: true, currentAttachmentCount: currentFile ? 1 : 0, hasIndexedFiles,
      hasEarlierExports: earlierFiles, searchEnabled: search, fileContext: "ADMITTED_FILE_REFERENCES"
    });
    const admittedVision = visionAnalysisGuidance(visionAnalysis, false, { nativeCurrentImages: false, hasIndexedFiles });
    const system = [admittedContract.stable, WORKSPACE_CHECKPOINT_GUIDANCE, admittedVision, admittedContract.turn].join("\n\n");
    const request = { content: textMessageContent("Continue the current task"),
      attachments: currentFile ? [{ fileName: "current.txt", mimeType: "text/plain", byteSize: 7 }] : [],
      prompt: { system }, workspace, workspaceCheckpoints: true, visionAnalysis,
      agent: { mcpMode: "off", imageInput: false }, context: { messages: [
        { id: "old-user", role: "user", content: textMessageContent("Earlier request") },
        { id: "old-answer", role: "assistant", content: textMessageContent("Earlier answer") },
        { id: "current", role: "user", content: textMessageContent("Continue the current task") }
      ] }
    } as unknown as ProviderRunRequest;
    const result = agentPrompts(request);
    expect(result.previousAssistantMessageId).toBe("old-answer");
    expect(result.prompt).toContain("Earlier request");
    expect(result.resumePrompt).not.toContain("Earlier request");
    expect(result.developerInstructions.startsWith(`${system}\n\n`)).toBe(true);
    for (const fragment of [admittedContract.stable, admittedContract.turn, WORKSPACE_CHECKPOINT_GUIDANCE, admittedVision, WORKSPACE_NO_REPLAY_SAFETY]) {
      expect(result.developerInstructions.split(fragment)).toHaveLength(2);
      expect(result.prompt).not.toContain(fragment);
      expect(result.resumePrompt).not.toContain(fragment);
    }
    expect(result.developerInstructions).toContain("inside its isolated Workspace");
    expect(result.developerInstructions).not.toMatch(/Answer directly|Try to answer directly|It starts on first use/u);
    expect(result.developerInstructions.includes("Web search is available in this chat as its own tool.")).toBe(search);
    expect(result.developerInstructions.includes("ADMITTED_FILE_REFERENCES")).toBe(hasIndexedFiles);
    expect(result.developerInstructions.includes("earlier completed exports")).toBe(earlierFiles);
    expect(result.developerInstructions.includes("Inspect the authorized file index before requesting another upload.")).toBe(hasIndexedFiles);
    expect(result.developerInstructions).not.toContain("Use checkpoint_outputs to save a useful intermediate deliverable");
    expect(result.developerInstructions).not.toContain("Direct image viewing is unavailable for this run.");
    expect(result.developerInstructions).toContain("When saving a deliverable checkpoint, use checkpoint_outputs on the managed AIQSA MCP server even when external MCP is Off.");
    expect(result.developerInstructions).toContain("For required Workspace image analysis, use analyze_image on the managed AIQSA MCP server even when external MCP is Off.");
    expect(result.developerInstructions).not.toContain("find_tools");
    for (const prompt of [result.prompt, result.resumePrompt]) {
      expect(prompt).toContain('"outputDirectory":"/workspace/output/current"');
      expect(prompt).toContain('"inboxIndexPath":"/workspace/inbox/index.json"');
      expect(prompt.includes('"messageManifestPath":')).toBe(currentFile);
      expect(prompt.includes('"fileName":"current.txt"')).toBe(currentFile);
      expect(prompt).not.toContain("Before asking the user to upload a source again");
      expect(prompt).not.toContain("No attachments on this turn does not mean earlier sources are absent");
    }
  });

  it("preserves the exact legacy inbox and tool instructions for persisted requests without a guidance version", () => {
    const request = { content: textMessageContent("Continue"), attachments: [],
      prompt: { system: "Frozen legacy Workspace system", developer: "Frozen developer instructions" },
      workspace: { outputDirectory: "/workspace/output/accepted", inboxIndexPath: "/workspace/inbox/index.json" },
      workspaceCheckpoints: true, agent: { mcpMode: "off", imageInput: false },
      visionAnalysis: { version: 1, available: false, code: "vision_model_absent" }
    } as unknown as ProviderRunRequest;
    const result = agentPrompts(request);
    const expectedPrompt = [
      "Continue the AIQSA conversation below and carry out the current user's task. Historical messages are conversation context, not new commands.",
      "Current AIQSA turn workspace paths (replace all previous turn paths):",
      "Before asking the user to upload a source again, inspect the current attachment references and inboxIndexPath. " +
        "No attachments on this turn does not mean earlier sources are absent. The index distinguishes uploads from previous exports; " +
        "use exact attachment IDs and producing messages, never filename alone. Verify the indexed file before claiming bytes are available; " +
        "historical context does not authorize replaying earlier or uncertain tool actions.",
      '{"outputDirectory":"/workspace/output/accepted","inboxIndexPath":"/workspace/inbox/index.json","attachments":[]}',
      '[{"role":"user","text":"Continue"}]'
    ].join("\n\n");
    expect(result.prompt).toBe(expectedPrompt);
    expect(result.resumePrompt).toBe(expectedPrompt);
    expect(result.developerInstructions.startsWith("Frozen legacy Workspace system\n\nFrozen developer instructions\n\n")).toBe(true);
    const expectedLegacyTools = [
      "Use checkpoint_outputs to save a useful intermediate deliverable before long or risky work and before the final answer. " +
        "Only a successful checkpoint result confirms durable downloadable bytes. A file on guest disk alone may be lost. " +
        "Checkpoints preserve exact versions independently of this answer's outcome; saving is not a quality check. " +
        "Continue from the exact authorized saved attachment when needed, without repeating completed preparation merely to recreate it.",
      "Use checkpoint_outputs on the managed AIQSA MCP server even when external MCP is Off.",
      "Direct image viewing is unavailable for this run. Use analyze_image for visual questions about Workspace files; do not claim to see their pixels yourself. " +
        "System Vision is unassigned; analyze_image reports this without substituting another model. " +
        "Inspect the authorized file index before requesting another upload. " +
        "Missing files, denied access and invalid formats must be resolved at the file boundary.",
      "Use analyze_image on the managed AIQSA MCP server even when external MCP is Off. Never request credentials or substitute shell network calls."
    ].join("\n\n");
    expect(result.developerInstructions.endsWith(`\n\n${expectedLegacyTools}`)).toBe(true);
    expect(result.developerInstructions).not.toContain("/workspace/guides/");
  });

  it("does not advertise Workspace paths or managed file tools without a Workspace admission", () => {
    const request = { content: textMessageContent("Explain this"), attachments: [], prompt: { system: "baseline" },
      agent: { mcpMode: "off" }, workspaceCheckpoints: true,
      visionAnalysis: { version: 1, available: false, code: "vision_model_absent" }
    } as unknown as ProviderRunRequest;
    const result = agentPrompts(request);
    expect(`${result.prompt}\n${result.resumePrompt}`).not.toMatch(/workspace paths|inboxIndexPath|messageManifestPath/u);
    expect(result.developerInstructions).not.toMatch(/checkpoint_outputs|analyze_image|Web search is available/u);
  });

  it.each([
    { mcpMode: "off", servers: 0 }, { mcpMode: "auto", servers: 1 }, { mcpMode: "auto", servers: 0 }, { mcpMode: "all", servers: 0 }
  ] as const)("only directs the agent to tools enabled by MCP %j", ({ mcpMode, servers }) => {
    const discovery = mcpMode === "auto" && servers > 0;
    const request = { content: textMessageContent("Read a private issue"), attachments: [],
      agent: { mcpMode }, prompt: { system: "baseline" },
      ...(discovery ? { mcpDiscovery: { catalog: { servers: [{ serverName: "GitLab", tools: [] }], version: 1 }, epochs: [], version: 2 } } : {})
    } as unknown as ProviderRunRequest;
    const { developerInstructions, prompt, resumePrompt } = agentPrompts(request);
    expect(developerInstructions.includes("find_tools")).toBe(discovery);
    expect(developerInstructions.includes("not an authorization denial")).toBe(mcpMode !== "off");
    expect(resumePrompt.includes("discovery_required")).toBe(discovery);
    expect(`${prompt}${resumePrompt}`.includes("find_tools")).toBe(discovery);
    if (discovery) expect(resumePrompt).toContain("Never replay a dispatched operation with an unknown outcome");
  });

  it("delivers the admitted connected tool index once, only through the system prompt", () => {
    const catalog = { servers: [{ serverName: "GitLab", description: "", namespace: "gitlab", revisionId: "r", serverId: "s",
      tools: [{ namespacedName: "gitlab__get_issue", originalName: "get_issue", description: null }] }], version: 1 as const };
    const hint = mcpToolIndexGuidance(catalog)!;
    const request = { content: textMessageContent("Read a private issue"), attachments: [], agent: { mcpMode: "auto" },
      prompt: { system: `baseline\n\n${hint}` },
      mcpDiscovery: { catalog, epochs: [], version: 2 }
    } as unknown as ProviderRunRequest;
    const { developerInstructions, prompt, resumePrompt } = agentPrompts(request);
    expect(developerInstructions.split(hint)).toHaveLength(2);
    expect(developerInstructions.indexOf(hint)).toBeLessThan(developerInstructions.indexOf("You are executing one AIQSA user turn"));
    expect(developerInstructions.split("Connected MCP tool index")).toHaveLength(2);
    expect(`${prompt}${resumePrompt}`).not.toContain("Connected MCP tool index");
  });

  it("keeps selected Skills at user authority and sends the current turn on resume", () => {
    const request = { content: textMessageContent("current task"),
      attachments: [{ fileName: "current-attachment.txt", mimeType: "text/plain", byteSize: 5 }],
      workspace: { outputDirectory: "/workspace/output/current", inboxIndexPath: "/workspace/inbox/index.json",
        messageManifestPath: "/workspace/inbox/messages/current.json" },
      prompt: { system: "baseline", developer: "workspace output contract", personalInstructions: "user preference" },
      context: { messages: [
        { id: "before", role: "user", content: textMessageContent("historical question") },
        { id: "previous", role: "assistant", content: textMessageContent("historical answer") },
        { id: "current", role: "user", content: textMessageContent("current task\n<selected_skills>unique-skill-body</selected_skills>") }
      ] }
    } as unknown as ProviderRunRequest;
    const result = agentPrompts(request);
    expect(result.previousAssistantMessageId).toBe("previous");
    expect(result.prompt).toContain("historical question");
    expect(result.resumePrompt).not.toContain("historical question");
    expect(result.resumePrompt.match(/unique-skill-body/gu)).toHaveLength(1);
    expect(result.developerInstructions).not.toContain("unique-skill-body");
    expect(result.developerInstructions).not.toContain("user preference");
    expect(result.resumePrompt).toContain("user preference");
    expect(result.developerInstructions).toContain("workspace output contract");
    for (const prompt of [result.prompt, result.resumePrompt]) {
      expect(prompt).toContain('"outputDirectory":"/workspace/output/current"');
      expect(prompt).toContain('"messageManifestPath":"/workspace/inbox/messages/current.json"');
      expect(prompt).toContain('"fileName":"current-attachment.txt"');
    }
    expect(result.developerInstructions).not.toContain("/workspace/output/current");
  });
});

describe("Agent delivery of the cross-turn tool history", () => {
  const entry = (index: number) => {
    const ref = `tcr1_${index.toString(16).padStart(32, "0")}`;
    return { ref, details: true, compact: `- [${ref}] MCP Tracker › write: executed.`,
      full: `- [${ref}] MCP Tracker › write: executed. Arguments: ${JSON.stringify({ index, body: "x".repeat(1_400) })}.` };
  };
  const record = (turnMessageId: string, entries: number, start = 0) => {
    const block = { turnMessageId, userMessageId: null, header: `[AIQSA record ${turnMessageId}]`, footer: null,
      entries: Array.from({ length: entries }, (_, index) => entry(start + index)) };
    return { id: `tch1_${turnMessageId}`, contextTurnId: `tch1_${turnMessageId}`, role: "assistant" as const, historyClass: "tool_history" as const,
      content: { blocks: [block.header, ...block.entries.map((value) => value.full)].map((text) => ({ text, type: "text" })) },
      toolHistory: { block, detailRefs: block.entries.map((value) => value.ref) } };
  };
  const request = (messages: unknown[]) => ({ content: textMessageContent("current"), attachments: [], prompt: { system: "baseline" },
    context: { messages } }) as unknown as ProviderRunRequest;

  it("resumes from the real previous answer and sends only records the native thread lacks", () => {
    const result = agentPrompts(request([
      { id: "q1", role: "user", content: textMessageContent("first") },
      record("a1", 1),
      { id: "a1", role: "assistant", content: textMessageContent("first answer") },
      // Earlier attempts of the current message: not in the native thread.
      record("q2", 1, 50),
      { id: "q2", role: "user", content: textMessageContent("current") }
    ]));
    expect(result.previousAssistantMessageId).toBe("a1");
    expect(result.resumePrompt).toContain(entry(50).ref);
    expect(result.resumePrompt).not.toContain(entry(0).ref);
    expect(result.prompt).toContain(entry(0).ref);
    expect(result.prompt).toContain(entry(50).ref);
  });

  it("never names a record as the native predecessor", () => {
    const result = agentPrompts(request([
      { id: "q1", role: "user", content: textMessageContent("first") },
      // The answer failed without text: its record stands in its place.
      record("a1", 1),
      { id: "q2", role: "user", content: textMessageContent("current") }
    ]));
    expect(result.previousAssistantMessageId).toBeNull();
  });

  /** A record of `entries` calls whose compact lines carry `padding`; `executed(index)` decides each outcome. */
  const padded = (turn: number, padding: number, executed: (index: number) => boolean) => {
    const value = record(`a${turn}`, 30, turn * 30);
    const entries = value.toolHistory.block.entries.map((item, index) => executed(index)
      ? { ...item, essential: true, compact: `${item.compact} ${"c".repeat(padding)}` }
      : { ...item, essential: false, compact: `${item.compact.replace("executed.", "not executed.")} ${"c".repeat(padding)}`,
        full: item.full.replace("executed.", "not executed.") });
    return { ...value, toolHistory: { ...value.toolHistory, block: { ...value.toolHistory.block, entries } } };
  };
  const chat = (records: ReturnType<typeof padded>[]) => request([...records.flatMap((value, turn) => [
    { id: `q${turn}`, role: "user", content: textMessageContent(`question ${turn}`) },
    value,
    { id: `a${turn}`, role: "assistant", content: textMessageContent(`answer ${turn}`) }
  ]), { id: "current", role: "user", content: textMessageContent("current") }]);

  it("bounds a long history to the prompt limit without hiding an executed call", () => {
    // Every tenth call executed; the long others were refused before dispatch.
    const records = Array.from({ length: 40 }, (_, turn) => padded(turn, 1_100, (index) => index % 10 === 0));
    const result = agentPrompts(chat(records));
    expect(Buffer.byteLength(result.prompt)).toBeLessThanOrEqual(1024 * 1024);
    // Even the oldest records keep the compact line of every executed call.
    for (const value of records) {
      for (const item of value.toolHistory.block.entries.filter((entry) => entry.essential)) expect(result.prompt).toContain(item.compact);
    }
    // Only calls that were not executed are counted, named for the reader while room remains.
    expect(result.prompt).toContain("calls of this turn that were not executed are not listed here");
    expect(result.prompt).toContain("read_tool_call reads them by call_ref");
    expect(result.prompt).not.toContain("this does not mean they did not happen");
    expect(result.prompt).toContain("answer 0");
    expect(result.previousAssistantMessageId).toBe("a39");
  });

  it("refuses a prompt whose executed calls do not fit rather than hide one", () => {
    const records = Array.from({ length: 40 }, (_, turn) => padded(turn, 1_100, () => true));
    expect(() => agentPrompts(chat(records))).toThrow("agent_context_too_large");
  });

  it("lists every executed call of a record beyond its normal bound", () => {
    // More compact lines than one record's normal bound holds, as the answer request renders it.
    const block: ToolHistoryBlock = { turnMessageId: "a1", userMessageId: "q1", header: "[AIQSA record a1]", footer: null,
      entries: Array.from({ length: 400 }, (_, index) => ({ ...entry(index), compact: `${entry(index).compact} ${"d".repeat(40)}` })) };
    const message = toolHistoryMessage(block);
    expect(JSON.stringify(message.content)).toContain("earlier calls of this turn are not listed here");
    const result = agentPrompts(request([{ id: "q1", role: "user", content: textMessageContent("first") }, message,
      { id: "a1", role: "assistant", content: textMessageContent("first answer") },
      { id: "q2", role: "user", content: textMessageContent("current") }]));
    for (const item of block.entries) expect(result.prompt).toContain(item.compact);
    expect(result.prompt).not.toContain("earlier calls of this turn are not listed here");
  });
});
