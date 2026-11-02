import { describe, expect, it } from "vitest";
import { CHANGE_RESEARCH_FRAME_TOOL_NAME, RESEARCH_FRAME_LIMITS, type DecodedResearch, type ResearchAgentRef, type ResearchFrame } from "../../contracts/research";
import {
  researchCandidateKey,
  researchCandidateRow,
  researchCandidatesLine,
  researchFrameEntries,
  researchFrameWithNote,
  researchFrameWithSetAside,
  researchNotedCandidate,
  researchOpenCandidates
} from "./candidates";
import { changedResearchFrame } from "./matrix";

const FRAME: ResearchFrame = {
  branches: [],
  changes: [],
  criteria: [{ criterion: "Firmness", key: "firmness", why: "It decides comfort." }],
  rows: [{ key: "kombi-3", label: "Dreamline Kombi-3 S1000" }, { key: "forma", label: "Askona Balance Forma 160x200" }]
};
const LEAD: ResearchAgentRef = { name: null, threadId: null };
const agent = (name: string): ResearchAgentRef => ({ name, threadId: `thread-${name}` });
const stamp = (by: ResearchAgentRef = agent("marketplaces"), at = "2026-11-03T10:00:00.000Z") => ({ at, by });

const value = (decoded: DecodedResearch<ResearchFrame>): ResearchFrame => {
  if (!decoded.ok) throw new Error(decoded.message);
  return decoded.value;
};
const refusal = (decoded: DecodedResearch<ResearchFrame>): string => decoded.ok ? "" : decoded.message;

/** Each agent notes its name for the option, in turn. */
function noted(frame: ResearchFrame, ...notes: readonly (readonly [string, string])[]): ResearchFrame {
  return notes.reduce((grown, [name, label]) => value(researchFrameWithNote(grown, { label, reason: `Seen by ${name}.` }, stamp(agent(name)))), frame);
}

describe("a candidate's key", () => {
  it("merges one option however three domains write it: a Russian shop's brand, a split CamelCase model, an LLM's name and an S3 system", () => {
    for (const names of [["Аскона", "Askona", "ASKONA"], ["Sleep Dream", "SleepDream", "sleepdream"], ["Qwen3-235B-A22B", "qwen3 235b a22b", "Qwen3 235B-A22B"],
      ["MinIO", "Minio", "MINIO", "min.io"]]) {
      const frame = noted({ ...FRAME, rows: [] }, ...names.map((name, index) => [`agent-${index}`, name] as const));
      expect(frame.candidates).toHaveLength(1);
      expect(frame.candidates![0]).toMatchObject({ label: names[0], notes: names.map((_name, index) => expect.objectContaining({ by: agent(`agent-${index}`) })) });
    }
  });

  it("is the name's words joined by hyphens, in Latin and lowercase, and keeps what tells a model from its sibling", () => {
    expect(researchCandidateKey("Dreamline SleepDream Medium S1000")).toBe("dreamline-sleep-dream-medium-s1000");
    expect(researchCandidateKey("Матрас Орматек «Оптима»")).toBe("matras-ormatek-optima");
    expect(researchCandidateKey("Qwen3-235B-A22B")).toBe("qwen3-235b-a22b");
    expect(researchCandidateKey("MinIO")).toBe("min-io");
    expect(researchCandidateKey("Galaxy S24+")).not.toBe(researchCandidateKey("Galaxy S24"));
    expect(researchCandidateKey("Ｓｌｅｅｐ　Ｄｒｅａｍ")).toBe("sleep-dream");
    expect(researchCandidateKey("—  «»  ")).toBe("");
    expect(researchCandidateKey("Щ".repeat(RESEARCH_FRAME_LIMITS.labelCharacters)).length).toBeLessThanOrEqual(RESEARCH_FRAME_LIMITS.labelCharacters);
  });

  it("is covered by a row whose label holds the name as a run of its words, however either splits it", () => {
    expect(researchCandidateRow(FRAME, researchCandidateKey("Аскона Balance Forma"))).toMatchObject({ key: "forma" });
    expect(researchCandidateRow(FRAME, researchCandidateKey("Dream line Kombi 3"))).toMatchObject({ key: "kombi-3" });
    // Another model of a line a row holds is no row: the option a real run lost.
    expect(researchCandidateRow(FRAME, researchCandidateKey("Dreamline SleepDream Medium S1000"))).toBeNull();
    expect(researchCandidateRow(FRAME, researchCandidateKey("Kombi-3 S1000 Plus"))).toBeNull();
    // Only whole words: "line" is not covered by "Dreamline".
    expect(researchCandidateRow(FRAME, researchCandidateKey("Line"))).toBeNull();
  });
});

describe("noting a candidate", () => {
  it("stores the name as written, who noted it, when and why, and counts each further agent", () => {
    const once = value(researchFrameWithNote(FRAME, { label: "Dreamline SleepDream Medium S1000", reason: "Ozon lists it at 59 521 ₽." }, stamp()));
    expect(once.candidates).toEqual([{ key: "dreamline-sleep-dream-medium-s1000", label: "Dreamline SleepDream Medium S1000",
      notes: [{ at: "2026-11-03T10:00:00.000Z", by: agent("marketplaces"), reason: "Ozon lists it at 59 521 ₽." }] }]);
    expect(once.rows).toEqual(FRAME.rows);
    expect(once.changes).toEqual([]);
    const twice = value(researchFrameWithNote(once, { label: "SleepDream Medium S 1000 Dreamline", reason: "A ranking names it." }, stamp(agent("brands"))));
    // Another word order is another name; the same words written apart are not.
    expect(twice.candidates).toHaveLength(2);
    const merged = value(researchFrameWithNote(once, { label: "Dreamline Sleep Dream Medium S-1000", reason: "A ranking names it." }, stamp(agent("brands"))));
    expect(merged.candidates).toHaveLength(1);
    expect(merged.candidates![0]!.notes.map(({ by }) => by.name)).toEqual(["marketplaces", "brands"]);
    expect(researchNotedCandidate(merged, "dreamline sleepdream medium s1000")).toBe(merged.candidates![0]);
  });

  it("stores nothing for a name a row already covers, and says which row", () => {
    expect(refusal(researchFrameWithNote(FRAME, { label: "Askona Balance Forma", reason: "R." }, stamp()))).toContain("already row forma (Askona Balance Forma 160x200)");
    expect(refusal(researchFrameWithNote(FRAME, { label: "Dreamline", reason: "R." }, stamp()))).toContain("not only its brand or line");
  });

  it("stores nothing for a name with no letter or digit, a second note by the same agent, or one set aside", () => {
    expect(refusal(researchFrameWithNote(FRAME, { label: "«—»", reason: "R." }, stamp()))).toContain("label must name the option");
    const once = noted(FRAME, ["marketplaces", "Lonax X1"]);
    expect(refusal(researchFrameWithNote(once, { label: "LONAX x1", reason: "Again." }, stamp(agent("marketplaces"))))).toBe("Nothing was noted: you noted lonax-x1 already.");
    const aside = value(researchFrameWithSetAside(once, { key: "lonax-x1", reason: "Not sold in Russia." }, stamp(LEAD)));
    expect(refusal(researchFrameWithNote(aside, { label: "Lonax X1", reason: "R." }, stamp(agent("brands"))))).toContain("set aside: Not sold in Russia.");
  });

  it("holds at most its bound of candidates and of notes in all, which with set-asides and the matrix's own changes stay within the frame's bound", () => {
    const limits = RESEARCH_FRAME_LIMITS;
    const full = Array.from({ length: limits.candidates }, (_entry, index) => [`agent-${index}`, `Model ${index}`] as const).reduce((frame, [name, label]) =>
      value(researchFrameWithNote(frame, { label, reason: "R." }, stamp(agent(name)))), { ...FRAME, rows: [] } as ResearchFrame);
    expect(refusal(researchFrameWithNote(full, { label: "Model extra", reason: "R." }, stamp()))).toContain("Name this option in your report instead");
    // A further agent's note of one noted already still counts, until notes in all reach their bound.
    const more = value(researchFrameWithNote(full, { label: "Model 0", reason: "R." }, stamp(agent("other"))));
    expect(more.candidates![0]!.notes).toHaveLength(2);
    expect(limits.rows + limits.criteria + limits.branches + limits.candidateNotes + limits.candidates).toBeLessThanOrEqual(limits.changes);
    expect(researchFrameEntries(more)).toBe(limits.candidates + 1);
  });
});

describe("setting a candidate aside", () => {
  const once = noted(FRAME, ["marketplaces", "Dreamline SleepDream Medium S1000"]);

  it("is the main agent's alone: a researcher is told to say why in its report", () => {
    expect(refusal(researchFrameWithSetAside(once, { key: "dreamline-sleep-dream-medium-s1000", reason: "R." }, stamp(agent("brands")))))
      .toBe("Nothing was changed: only the main agent sets a noted candidate aside. If you think this one is no option, say why in your report.");
  });

  it("stores the key and the reason, by the key the server listed or the name written either way", () => {
    for (const key of ["dreamline-sleep-dream-medium-s1000", "Dreamline SleepDream Medium S1000"]) {
      const aside = value(researchFrameWithSetAside(once, { key, reason: "Sold out." }, stamp(LEAD, "2026-11-03T10:05:00.000Z")));
      expect(aside.setAside).toEqual([{ at: "2026-11-03T10:05:00.000Z", key: "dreamline-sleep-dream-medium-s1000", reason: "Sold out." }]);
      expect(researchOpenCandidates(aside)).toEqual([]);
    }
  });

  it("refuses a key nobody noted, naming the open ones, and one already a row or set aside", () => {
    expect(refusal(researchFrameWithSetAside(once, { key: "lonax-x1", reason: "R." }, stamp(LEAD)))).toBe(
      "Nothing was changed: no candidate lonax-x1 was noted. Open candidates: dreamline-sleep-dream-medium-s1000.");
    const rowed = value(changedResearchFrame(once, { change: "add_row", reason: "Popular.", row: { key: "sleepdream", label: "Dreamline SleepDream Medium S1000 180x200" } }, stamp(LEAD)));
    expect(refusal(researchFrameWithSetAside(rowed, { key: "dreamline-sleep-dream-medium-s1000", reason: "R." }, stamp(LEAD)))).toContain("already row sleepdream");
    const aside = value(researchFrameWithSetAside(once, { key: "dreamline-sleep-dream-medium-s1000", reason: "R." }, stamp(LEAD)));
    expect(refusal(researchFrameWithSetAside(aside, { key: "dreamline-sleep-dream-medium-s1000", reason: "Again." }, stamp(LEAD)))).toContain("set aside already");
  });
});

describe("open candidates", () => {
  it("are those neither a row covers nor the main agent set aside, more agents' first, and a row added later closes one", () => {
    const frame = noted(FRAME, ["a", "Lonax X1"], ["b", "Ormatek Optima"], ["c", "Орматек Оптима"], ["a", "Sealy Hybrid"]);
    expect(researchOpenCandidates(frame).map(({ key }) => key)).toEqual(["ormatek-optima", "lonax-x1", "sealy-hybrid"]);
    const rowed = value(changedResearchFrame(frame, { change: "add_row", reason: "Ranked first.", row: { key: "optima", label: "Ормaтек Optima" } }, stamp(LEAD)));
    const aside = value(researchFrameWithSetAside(rowed, { key: "sealy-hybrid", reason: "Over budget." }, stamp(LEAD)));
    expect(researchOpenCandidates(aside).map(({ key }) => key)).toEqual(["lonax-x1"]);
  });
});

describe("the line the main agent reads", () => {
  it("is none with nothing open", () => {
    expect(researchCandidatesLine(FRAME)).toBeNull();
    expect(researchCandidatesLine(value(researchFrameWithSetAside(noted(FRAME, ["a", "Lonax X1"]), { key: "lonax-x1", reason: "R." }, stamp(LEAD))))).toBeNull();
  });

  it("lists each open candidate as data, with who noted it and why, and what to do with it", () => {
    const line = researchCandidatesLine(noted(FRAME, ["marketplaces", "Dreamline SleepDream Medium S1000"], ["brands", "SleepDream Medium S1000 Dreamline"]))!;
    expect(line).toContain("Candidates noted (from the server), neither a row nor set aside: 2.");
    expect(line).toContain(JSON.stringify({ key: "dreamline-sleep-dream-medium-s1000", name: "Dreamline SleepDream Medium S1000",
      noted_by: [{ agent: "marketplaces", reason: "Seen by marketplaces." }] }));
    expect(line).toContain(`add it as a row with ${CHANGE_RESEARCH_FRAME_TOOL_NAME} add_row and send researchers for its cells, or set it aside with ${CHANGE_RESEARCH_FRAME_TOOL_NAME} set_aside`);
    const own = researchCandidatesLine(value(researchFrameWithNote(FRAME, { label: "Lonax X1", reason: "R." }, stamp(LEAD))))!;
    expect(own).toContain('"agent":"you"');
  });

  it("stays within its bound with every candidate noted at length: reasons go first, then the candidates past what it holds", () => {
    const reason = "r".repeat(1_000);
    const frame = Array.from({ length: RESEARCH_FRAME_LIMITS.candidates }, (_entry, index) => index).reduce((grown, index) =>
      value(researchFrameWithNote(grown, { label: `${"Model ".repeat(30)}${index}`, reason }, stamp(agent(`agent-${index}`)))), FRAME);
    const line = researchCandidatesLine(frame)!;
    expect(line.length).toBeLessThanOrEqual(2_400);
    expect(line).not.toContain("rrrr");
    expect(line).toMatch(/And \d+ more, listed once these are decided\./u);
    expect(line).toContain("set_aside");
  });
});
