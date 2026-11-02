import { describe, expect, it } from "vitest";
import {
  decodeResearchDraft,
  decodeResearchDraftReferences,
  decodeResearchFrame,
  decodeResearchFrameChange,
  decodeResearchPlan,
  decodeResearchPlanAction,
  decodeResearchPlanAnswer,
  decodeResearchPlanEdit,
  decodeResearchPlanProposal,
  decodeResearchRecord,
  decodeResearchStart,
  RESEARCH_EVIDENCE_LIMITS,
  RESEARCH_FRAME_LIMITS,
  RESEARCH_LIMITS,
  RESEARCH_PLAN_LIMITS,
  RESEARCH_TIME_MS,
  researchFrameFromPlan,
  researchPhaseAt,
  researchPlanAnswerDocument,
  researchPlanFromProposal,
  researchPlanProposalDocument,
  researchPlanWithEdit,
  type DecodedResearch,
  type ResearchFrame,
  type ResearchPlanProposal
} from "./research";

const RECORD_ID = "3f2c1a54-8d7e-4b1a-9c55-0a1b2c3d4e5f";

const PROPOSAL = {
  assumptions: ["The sleeper weighs about 80 kg."],
  branches: [{ cases: [{ key: "light", label: "up to 70 kg" }, { key: "heavy", label: "heavier" }], key: "weight", unknown: "The sleeper's weight" }],
  criteria: [{ criterion: "Firmness after a year", key: "firmness", why: "Foam softens and the back stops being held." }],
  questions: [{ question: "What lasts?", sites: [], source_classes: ["primary_official", "independent_tests", "owner_reviews", "action_channel"] }],
  rows: [{ key: "x1", label: "X1" }],
  skipped_source_classes: [],
  steps: ["Read how mattresses are chosen", "Find candidates", "Read owners' reviews", "Compare"],
  understood: "A mattress for two, under a budget."
};

const refusal = <T>(decoded: DecodedResearch<T>) => decoded.ok ? null : decoded.message;
const value = <T>(decoded: DecodedResearch<T>): T => {
  if (!decoded.ok) throw new Error(decoded.message);
  return decoded.value;
};

const FINDING = { claim: "The X1 holds up.", criterion_key: "firmness", dataset: null, kind: "finding", quote: "held up after 10 years", reason: null, row_key: "x1",
  source_class: "independent_tests", standing: "confirmed", supersedes: null, target: null, url: "https://lab.example/x1" };
const NOT_FOUND = { ...FINDING, claim: null, kind: "not_found", quote: null, reason: "Three lab sites hold nothing on it.", source_class: null, standing: null, url: null };
const UNREACHABLE = { ...FINDING, claim: null, criterion_key: null, kind: "unreachable", quote: null, reason: "It asks to sign in.", row_key: null, standing: null, target: "shop.example", url: null };
const DATASET = { ...FINDING, dataset: { counts: [{ count: 12, label: "sagging" }], examples: [{ quote: "It sagged in a year.", url: "https://shop.example/x1" }],
  left_out: "Reviews of other sizes.", method: "Read every review of the 160x200 size.", sample_size: 40 }, kind: "dataset", quote: null, standing: "claimed" };

describe("the plan proposal", () => {
  it("takes what the model understood, its assumptions, the steps, the criteria with why each matters, and the questions with their classes", () => {
    const proposal = value(decodeResearchPlanProposal(PROPOSAL));
    expect(proposal).toMatchObject({ assumptions: PROPOSAL.assumptions, steps: PROPOSAL.steps, understood: PROPOSAL.understood });
    expect(proposal.criteria[0]).toEqual(PROPOSAL.criteria[0]);
    expect(proposal.questions[0]?.sourceClasses).toEqual(PROPOSAL.questions[0]?.source_classes);
    expect(researchPlanFromProposal("Choose a mattress.", proposal)).toEqual({ goal: "Choose a mattress.", questions: proposal.questions, skipped: [] });
  });

  it("refuses naming the field: steps outside 4 to 6, a criterion with no reason, a repeated key, a class left unassigned", () => {
    const limits = RESEARCH_PLAN_LIMITS;
    const steps = (count: number) => Array.from({ length: count }, (_entry, index) => `Step ${index + 1}`);
    expect(refusal(decodeResearchPlanProposal({ ...PROPOSAL, steps: steps(limits.stepsMin - 1) }))).toContain("steps must list 4 to 6");
    expect(refusal(decodeResearchPlanProposal({ ...PROPOSAL, steps: steps(limits.stepsMax + 1) }))).toContain("steps must list 4 to 6");
    expect(refusal(decodeResearchPlanProposal({ ...PROPOSAL, steps: [...steps(3), "x".repeat(limits.stepCharacters + 1)] }))).toContain("steps[3]");
    expect(refusal(decodeResearchPlanProposal({ ...PROPOSAL, understood: " " }))).toContain("understood");
    expect(refusal(decodeResearchPlanProposal({ ...PROPOSAL, criteria: [] }))).toContain("criteria must list 1 to");
    expect(refusal(decodeResearchPlanProposal({ ...PROPOSAL, criteria: [{ criterion: "Firmness", key: "firmness", why: "" }] }))).toContain("criteria[0].why");
    expect(refusal(decodeResearchPlanProposal({ ...PROPOSAL, criteria: [{ ...PROPOSAL.criteria[0], key: "Жёсткость" }] }))).toContain("criteria[0].key");
    expect(refusal(decodeResearchPlanProposal({ ...PROPOSAL, rows: [{ key: "x1", label: "X1" }, { key: "x1", label: "X1 again" }] }))).toContain("rows[1].key repeats");
    expect(refusal(decodeResearchPlanProposal({ ...PROPOSAL, branches: [{ cases: [{ key: "a", label: "A" }], key: "b", unknown: "Weight" }] }))).toContain("branches[0].cases must list 2 to");
    expect(refusal(decodeResearchPlanProposal({ ...PROPOSAL, questions: [{ ...PROPOSAL.questions[0], source_classes: ["primary_official"] }] }))).toContain("independent_tests");
    expect(refusal(decodeResearchPlanProposal({ ...PROPOSAL, questions: [{ ...PROPOSAL.questions[0], question: "What\u0000 lasts?" }] }))).toContain("NUL");
    expect(refusal(decodeResearchPlanProposal({ ...PROPOSAL, assumptions: undefined }))).toContain("assumptions must list");
  });

  it("reads back from the form a row keeps it in", () => {
    const proposal = value(decodeResearchPlanProposal(PROPOSAL));
    expect(value(decodeResearchPlanProposal(researchPlanProposalDocument(proposal)))).toEqual(proposal);
  });
});

describe("the user's answer", () => {
  const proposal = value(decodeResearchPlanProposal(PROPOSAL)) as ResearchPlanProposal;

  it("keeps what closed the window, the plan that stands and whether the user changed it, through the form a row keeps it in", () => {
    const answer = { changed: true, plan: proposal, releasedBy: "saved_edit" as const };
    expect(value(decodeResearchPlanAnswer(researchPlanAnswerDocument(answer)))).toEqual(answer);
    expect(refusal(decodeResearchPlanAnswer({ ...researchPlanAnswerDocument(answer), released_by: "button" }))).toContain("released_by must be one of");
    expect(refusal(decodeResearchPlanAnswer({ ...researchPlanAnswerDocument(answer), changed: "yes" }))).toContain("changed");
    expect(refusal(decodeResearchPlanAnswer({ ...researchPlanAnswerDocument(answer), plan: {} }))).toContain("plan: understood");
  });

  it("lets a person leave fewer or more steps than a model may propose, under their own bound", () => {
    const edit = { assumptions: [], steps: ["Only this."], understood: proposal.understood };
    expect(value(decodeResearchPlanEdit(edit))).toEqual(edit);
    const { changed, plan } = researchPlanWithEdit(proposal, edit);
    expect(changed).toBe(true);
    expect(plan.criteria).toEqual(proposal.criteria);
    const answer = { changed, plan, releasedBy: "saved_edit" as const };
    expect(value(decodeResearchPlanAnswer(researchPlanAnswerDocument(answer))).plan.steps).toEqual(["Only this."]);
    expect(refusal(decodeResearchPlanEdit({ ...edit, steps: [] }))).toContain("steps must list 1 to");
    expect(refusal(decodeResearchPlanEdit({ ...edit, steps: Array.from({ length: RESEARCH_PLAN_LIMITS.userStepsMax + 1 }, () => "Step") }))).toContain("steps must list");
  });

  it("says nothing changed when an edit left the plan as it was", () => {
    expect(researchPlanWithEdit(proposal, { assumptions: proposal.assumptions, steps: proposal.steps, understood: proposal.understood }).changed).toBe(false);
  });

  it("takes the widget's actions, a save only with its edit", () => {
    expect(value(decodeResearchPlanAction({ action: "start", runId: "run-1" }))).toEqual({ action: "start", runId: "run-1" });
    expect(value(decodeResearchPlanAction({ action: "hold", runId: "run-1" }))).toEqual({ action: "hold", runId: "run-1" });
    expect(value(decodeResearchPlanAction({ action: "save", plan: { assumptions: [], steps: ["One."], understood: "It." }, runId: "run-1" })))
      .toEqual({ action: "save", edit: { assumptions: [], steps: ["One."], understood: "It." }, runId: "run-1" });
    expect(refusal(decodeResearchPlanAction({ action: "save", runId: "run-1" }))).toContain("plan:");
    expect(refusal(decodeResearchPlanAction({ action: "stop", runId: "run-1" }))).toContain("action must be one of");
    expect(refusal(decodeResearchPlanAction({ action: "start" }))).toContain("runId");
  });
});

describe("an evidence record", () => {
  it("takes each kind from the fields it uses", () => {
    expect(value(decodeResearchRecord(FINDING))).toEqual({ claim: FINDING.claim, criterionKey: "firmness", kind: "finding", quote: FINDING.quote, rowKey: "x1",
      sourceClass: "independent_tests", standing: "confirmed", supersedes: null, url: FINDING.url });
    expect(value(decodeResearchRecord(NOT_FOUND))).toEqual({ criterionKey: "firmness", kind: "not_found", reason: NOT_FOUND.reason, rowKey: "x1", sourceClass: null, supersedes: null });
    expect(value(decodeResearchRecord(UNREACHABLE))).toEqual({ criterionKey: null, kind: "unreachable", reason: UNREACHABLE.reason, rowKey: null, sourceClass: "independent_tests",
      supersedes: null, target: "shop.example" });
    expect(value(decodeResearchRecord(DATASET))).toMatchObject({ dataset: { counts: [{ count: 12, label: "sagging" }], leftOut: "Reviews of other sizes.", sampleSize: 40 }, kind: "dataset", rowKey: "x1" });
    expect(value(decodeResearchRecord({ ...FINDING, supersedes: RECORD_ID }))).toMatchObject({ supersedes: RECORD_ID });
  });

  it("requires every field, null where it does not apply: an optional one fails a strict tool schema", () => {
    const { target: _target, ...omitted } = FINDING;
    void _target;
    expect(refusal(decodeResearchRecord(omitted))).toBe("target must be given: pass null when it does not apply.");
  });

  it("refuses naming the field", () => {
    expect(refusal(decodeResearchRecord("record"))).toContain("one object");
    expect(refusal(decodeResearchRecord({ ...FINDING, kind: "guess" }))).toContain("kind must be one of finding, not_found, dataset, unreachable");
    expect(refusal(decodeResearchRecord({ ...FINDING, row_key: "Икс" }))).toContain("row_key");
    expect(refusal(decodeResearchRecord({ ...FINDING, criterion_key: 3 }))).toContain("criterion_key");
    expect(refusal(decodeResearchRecord({ ...FINDING, supersedes: "the last one" }))).toContain("supersedes");
    expect(refusal(decodeResearchRecord({ ...FINDING, source_class: "blog" }))).toContain("source_class");
    expect(refusal(decodeResearchRecord({ ...FINDING, source_class: null }))).toContain("source_class");
    expect(refusal(decodeResearchRecord({ ...FINDING, standing: "sure" }))).toContain("standing");
    expect(refusal(decodeResearchRecord({ ...FINDING, claim: "x".repeat(RESEARCH_LIMITS.claimCharacters + 1) }))).toContain("claim");
    expect(refusal(decodeResearchRecord({ ...FINDING, quote: "x".repeat(RESEARCH_LIMITS.quoteCharacters + 1) }))).toContain("quote");
    expect(refusal(decodeResearchRecord({ ...FINDING, quote: "null\u0000byte" }))).toContain("quote");
    expect(refusal(decodeResearchRecord({ ...FINDING, url: "lab.example/x1" }))).toContain("url must be the http or https link");
    expect(refusal(decodeResearchRecord({ ...FINDING, url: `https://lab.example/${"x".repeat(RESEARCH_LIMITS.urlCharacters)}` }))).toContain("url");
  });

  it("counts a nothing-found cell only when it names the cell and where was looked", () => {
    expect(refusal(decodeResearchRecord({ ...NOT_FOUND, criterion_key: null }))).toContain("row_key and criterion_key");
    expect(refusal(decodeResearchRecord({ ...NOT_FOUND, reason: null }))).toContain("reason must say");
  });

  it("names an unreachable site with its reason", () => {
    expect(refusal(decodeResearchRecord({ ...UNREACHABLE, target: null }))).toContain("target must name the site");
    expect(refusal(decodeResearchRecord({ ...UNREACHABLE, reason: "" }))).toContain("reason must say");
  });

  it("refuses a dataset without its method, sample size, what was left out or examples, and a count past its sample", () => {
    const dataset = (change: Record<string, unknown>) => ({ ...DATASET, dataset: { ...DATASET.dataset, ...change } });
    expect(refusal(decodeResearchRecord({ ...DATASET, dataset: null }))).toContain("dataset must be one object");
    expect(refusal(decodeResearchRecord({ ...DATASET, row_key: null }))).toContain("row_key must name the exact model");
    expect(refusal(decodeResearchRecord(dataset({ method: "" })))).toContain("dataset.method");
    expect(refusal(decodeResearchRecord(dataset({ sample_size: 0 })))).toContain("dataset.sample_size");
    expect(refusal(decodeResearchRecord(dataset({ sample_size: 2.5 })))).toContain("dataset.sample_size");
    expect(refusal(decodeResearchRecord(dataset({ sample_size: RESEARCH_EVIDENCE_LIMITS.sampleSize + 1 })))).toContain("dataset.sample_size");
    expect(refusal(decodeResearchRecord(dataset({ left_out: null })))).toContain("dataset.left_out");
    expect(refusal(decodeResearchRecord(dataset({ examples: [] })))).toContain("dataset.examples must list 1 to");
    expect(refusal(decodeResearchRecord(dataset({ examples: [{ quote: "It sagged.", url: "shop.example" }] })))).toContain("dataset.examples[0]");
    expect(refusal(decodeResearchRecord(dataset({ counts: [{ count: 41, label: "sagging" }] })))).toContain("dataset.counts[0]");
  });
});

describe("the frame", () => {
  const frame: ResearchFrame = researchFrameFromPlan(value(decodeResearchPlanProposal(PROPOSAL)));

  it("opens from the plan with an empty change log, and reads back with what was added and why", () => {
    expect(frame).toMatchObject({ changes: [], criteria: PROPOSAL.criteria, rows: PROPOSAL.rows });
    const grown = { ...frame, changes: [{ at: "2026-11-01T10:00:00.000Z", by: { name: "lab", threadId: "thread-1" }, change: "add_row", key: "x2", reason: "A review names it." },
      { at: "2026-11-01T10:01:00.000Z", by: { name: null, threadId: null }, change: "add_criterion", key: "price", reason: "The user's budget." }] };
    expect(value(decodeResearchFrame(grown))).toEqual(grown);
  });

  it("refuses a frame that is not one, naming the field", () => {
    expect(refusal(decodeResearchFrame([]))).toContain("one object");
    expect(refusal(decodeResearchFrame({ ...frame, criteria: [] }))).toContain("criteria must list 1 to");
    expect(refusal(decodeResearchFrame({ ...frame, rows: Array.from({ length: RESEARCH_FRAME_LIMITS.rows + 1 }, (_entry, index) => ({ key: `r${index}`, label: "Row" })) }))).toContain("rows must list 0 to");
    const change = { at: "2026-11-01T10:00:00.000Z", by: { name: null, threadId: null }, change: "add_row", key: "x2", reason: "Why." };
    expect(refusal(decodeResearchFrame({ ...frame, changes: {} }))).toContain("changes must list");
    expect(refusal(decodeResearchFrame({ ...frame, changes: [{ ...change, at: "yesterday" }] }))).toContain("changes[0].at");
    expect(refusal(decodeResearchFrame({ ...frame, changes: [{ ...change, by: { name: "lab", threadId: null } }] }))).toContain("changes[0].by");
    expect(refusal(decodeResearchFrame({ ...frame, changes: [{ ...change, change: "drop_row" }] }))).toContain("changes[0].change");
    expect(refusal(decodeResearchFrame({ ...frame, changes: [{ ...change, reason: "" }] }))).toContain("changes[0].reason");
  });

  it("takes a change with its reason, every field given and null where its kind has no use for it", () => {
    const change = { cases: null, change: "add_row", key: "x2", label: "X2", reason: "A review names it.", why: null };
    expect(value(decodeResearchFrameChange(change))).toEqual({ change: "add_row", reason: change.reason, row: { key: "x2", label: "X2" } });
    expect(value(decodeResearchFrameChange({ ...change, change: "add_criterion", key: "edge", label: "Edge support", why: "Sleepers roll off a soft edge." })))
      .toEqual({ change: "add_criterion", criterion: { criterion: "Edge support", key: "edge", why: "Sleepers roll off a soft edge." }, reason: change.reason });
    const cases = [{ key: "light", label: "up to 70 kg" }, { key: "heavy", label: "heavier" }];
    expect(value(decodeResearchFrameChange({ ...change, cases, change: "add_branch", key: "weight", label: "Weight" })))
      .toEqual({ branch: { cases, key: "weight", unknown: "Weight" }, change: "add_branch", reason: change.reason });
    expect(refusal(decodeResearchFrameChange({ ...change, reason: "" }))).toContain("reason must say");
    expect(refusal(decodeResearchFrameChange({ ...change, change: "add_criterion", why: null }))).toContain("why must say");
    expect(refusal(decodeResearchFrameChange({ ...change, change: "add_branch" }))).toContain("cases must list 2 to");
    expect(refusal(decodeResearchFrameChange({ ...change, change: "rename" }))).toContain("change must be one of");
    const { why: _why, ...omitted } = change;
    void _why;
    expect(refusal(decodeResearchFrameChange(omitted))).toBe("why must be given: pass null when it does not apply.");
  });
});

describe("a draft's references", () => {
  const references = { branch_picks: [{ branch_key: "weight", case_key: "light", row_key: "x1" }],
    does_not_separate: { row_keys: ["x1", "x2"], statement: "The data does not tell them apart.", would_decide: "Trying them." }, pick_row_key: "x1", record_ids: [RECORD_ID] };
  const draft = { findings: [], report: "# Report", unreachable: [] };

  it("reads the record ids, the pick, the branch picks and a statement that the data does not separate", () => {
    expect(value(decodeResearchDraftReferences(references))).toEqual({ branchPicks: [{ branchKey: "weight", caseKey: "light", rowKey: "x1" }],
      doesNotSeparate: { rowKeys: ["x1", "x2"], statement: references.does_not_separate.statement, wouldDecide: "Trying them." }, pickRowKey: "x1", recordIds: [RECORD_ID] });
    expect(value(decodeResearchDraftReferences({ branch_picks: [], does_not_separate: null, pick_row_key: null, record_ids: [] })))
      .toEqual({ branchPicks: [], doesNotSeparate: null, pickRowKey: null, recordIds: [] });
  });

  it("reads a left-out field as one that does not apply: the tool is not strict, and a model with no branches may well leave branch_picks out", () => {
    expect(value(decodeResearchDraftReferences({}))).toEqual({ branchPicks: [], doesNotSeparate: null, pickRowKey: null, recordIds: [] });
    const { branch_picks: _picks, does_not_separate: _separate, ...partial } = references;
    void _picks;
    void _separate;
    expect(value(decodeResearchDraftReferences(partial))).toEqual({ branchPicks: [], doesNotSeparate: null, pickRowKey: "x1", recordIds: [RECORD_ID] });
    expect(refusal(decodeResearchDraftReferences("not an object"))).toContain("one object");
  });

  it("refuses a value of the wrong shape, naming the field", () => {
    expect(refusal(decodeResearchDraftReferences({ ...references, record_ids: [42] }))).toContain("record_ids");
    expect(refusal(decodeResearchDraftReferences({ ...references, record_ids: ["x".repeat(65)] }))).toContain("record_ids");
    expect(refusal(decodeResearchDraftReferences({ ...references, record_ids: Array.from({ length: 301 }, () => RECORD_ID) }))).toContain("at most 300");
    expect(refusal(decodeResearchDraftReferences({ ...references, pick_row_key: "Лонакс" }))).toContain("pick_row_key");
    expect(refusal(decodeResearchDraftReferences({ ...references, branch_picks: [{ branch_key: "weight" }] }))).toContain("branch_picks[0]");
    expect(refusal(decodeResearchDraftReferences({ ...references, does_not_separate: { row_keys: ["x1"], statement: "Same.", would_decide: "Try." } }))).toContain("row_keys");
    expect(refusal(decodeResearchDraftReferences({ ...references, does_not_separate: { ...references.does_not_separate, would_decide: "" } }))).toContain("would_decide");
  });

  it("reads a draft that refers to records, with no findings of its own: the server fills those from the records", () => {
    const decoded = value(decodeResearchDraft({ ...references, report: "# Report", summary: { row_keys: ["x1"], text: "Take X1." }, unreachable: [] }));
    expect(decoded).toEqual({ branchPicks: [{ branchKey: "weight", caseKey: "light", rowKey: "x1" }],
      doesNotSeparate: { rowKeys: ["x1", "x2"], statement: references.does_not_separate.statement, wouldDecide: "Trying them." }, findings: [], origin: "reserved_call",
      pickRowKey: "x1", recordIds: [RECORD_ID], report: "# Report", summary: { rowKeys: ["x1"], text: "Take X1." }, unreachable: [] });
  });

  it("takes the model's ids over any findings it typed beside them", () => {
    const typed = { claim: "Typed.", quote: "Typed.", source_class: "owner_reviews", standing: "confirmed", url: "https://shop.example/x1" };
    expect(value(decodeResearchDraft({ ...references, findings: [typed], report: "# Report", unreachable: [] })).findings).toEqual([]);
  });

  it("reads an id that was never one as an id, so the report check can say which", () => {
    expect(value(decodeResearchDraft({ ...references, record_ids: ["rec-12", RECORD_ID], report: "# Report", unreachable: [] })).recordIds).toEqual(["rec-12", RECORD_ID]);
  });

  it("never loses a report over its references: what is wrong goes back at the report check, under the cap", () => {
    for (const [wrong, field] of [[{ pick_row_key: "Лонакс" }, "pick_row_key"], [{ record_ids: "not a list" }, "record_ids"], [{ branch_picks: [{ branch_key: "weight" }] }, "branch_picks[0]"]] as const) {
      const decoded = value(decodeResearchDraft({ ...references, ...wrong, report: "# Report", unreachable: [] }));
      expect(decoded).toMatchObject({ findings: [], invalidReferences: expect.stringContaining(field), origin: "reserved_call", report: "# Report" });
      expect(decoded.recordIds).toBeUndefined();
    }
  });

  it("keeps the pick and the ids of a draft that leaves a field out", () => {
    const decoded = value(decodeResearchDraft({ pick_row_key: "x1", record_ids: [RECORD_ID], report: "# Report", unreachable: [] }));
    expect(decoded).toMatchObject({ branchPicks: [], doesNotSeparate: null, pickRowKey: "x1", recordIds: [RECORD_ID] });
    expect(decoded.invalidReferences).toBeUndefined();
    expect(value(decodeResearchDraft({ report: "# Report", unreachable: [] })).invalidReferences).toBeUndefined();
  });

  it("reads an empty findings list as a live draft, so its pick reaches the report check: a stored draft with none loses nothing by it", () => {
    expect(value(decodeResearchDraft({ findings: [], pick_row_key: "x9", report: "# Report", unreachable: [] }))).toMatchObject({ findings: [], pickRowKey: "x9", recordIds: [] });
    expect(value(decodeResearchDraft(draft))).toEqual({ branchPicks: [], doesNotSeparate: null, findings: [], origin: "reserved_call", pickRowKey: null, recordIds: [], report: "# Report", summary: null,
      unreachable: [] });
  });

  it("still refuses a draft whose report or list of what was unreachable cannot be read", () => {
    expect(refusal(decodeResearchDraft({ ...references, report: " ", unreachable: [] }))).toContain("report");
    expect(refusal(decodeResearchDraft({ ...references, report: "# Report", unreachable: "none" }))).toContain("unreachable");
  });

  it("reads null for a list as an empty one, as a missing field's refusal says to pass it", () => {
    expect(value(decodeResearchDraftReferences({ branch_picks: null, does_not_separate: null, pick_row_key: null, record_ids: null })))
      .toEqual({ branchPicks: [], doesNotSeparate: null, pickRowKey: null, recordIds: [] });
  });

  it("keeps decoding a draft stored before drafts referred to records, since persisted chats survive an upgrade", () => {
    const stored = { findings: [{ claim: "It holds.", quote: "held up", source_class: "independent_tests", standing: "confirmed", url: "https://lab.example/x1" }],
      report: "# Report", unreachable: [{ reason: "Blocked.", source_class: null, target: "shop.example" }] };
    expect(value(decodeResearchDraft(stored))).toEqual({ findings: [{ claim: "It holds.", quote: "held up", sourceClass: "independent_tests", standing: "confirmed",
      url: "https://lab.example/x1" }], origin: "reserved_call", report: "# Report", unreachable: [{ reason: "Blocked.", sourceClass: null, target: "shop.example" }] });
  });
});

describe("the start", () => {
  it("takes only the goal as the target contract, while the plan the live tool takes stays as it was", () => {
    expect(value(decodeResearchStart({ goal: "Choose a mattress.", questions: [] }))).toEqual({ goal: "Choose a mattress." });
    expect(refusal(decodeResearchStart({ goal: "" }))).toContain("goal must be 1 to");
    expect(refusal(decodeResearchPlan({ goal: "Choose a mattress.", questions: [] }))).toContain("questions must list 1 to");
  });
});

describe("the time phases", () => {
  it("follow the operator's minutes from the plan's release", () => {
    const minutes = (value: number) => value * 60_000;
    expect(RESEARCH_TIME_MS).toMatchObject({ abandonedEdit: minutes(5), hardEnd: minutes(90), notes: minutes(85), planWindow: minutes(1),
      researcherTurn: minutes(25), scoping: minutes(3), stopRunningResearchers: minutes(70), stopStartingResearchers: minutes(60) });
    expect(researchPhaseAt(0)).toBe("researching");
    expect(researchPhaseAt(minutes(60) - 1)).toBe("researching");
    expect(researchPhaseAt(minutes(60))).toBe("winding_down");
    expect(researchPhaseAt(minutes(70))).toBe("reporting");
    expect(researchPhaseAt(minutes(85))).toBe("notes");
    expect(researchPhaseAt(minutes(90))).toBe("ended");
  });
});
