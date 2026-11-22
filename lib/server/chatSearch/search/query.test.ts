import { describe, expect, it } from "vitest";
import {
  identifierLike,
  inverseDocumentFrequency,
  pastChatPhraseChunks,
  pastChatQueryChunks,
  pastChatWordUnits,
  type PastChatUnitStatistics
} from "./query";

const stat = (kind: PastChatUnitStatistics["kind"], key: string, documentFrequency: number, query = kind === "prefix" ? `'${key}':*`
  : kind === "phrase" ? `phrase(${key})` : `'${key}'`): PastChatUnitStatistics => ({ documentFrequency, key, kind, passages: 6000, query });

describe("past-chat query chunks", () => {
  it("keep identifiers whole and drop the punctuation around them, in any script", () => {
    expect(pastChatQueryChunks("(ABC-1234), «отчёт» report_2026-11-12.xlsx. campaign_42! iPhoneа ABC-1234"))
      .toEqual(["ABC-1234", "отчёт", "report_2026-11-12.xlsx", "campaign_42", "iPhoneа"]);
    expect(pastChatQueryChunks("  ... — ?? ")).toEqual([]);
  });

  it("call a term an identifier when it has a digit or joining punctuation", () => {
    for (const term of ["ABC-1234", "campaign_42", "report_2026-11-12.xlsx", "1234", "отчёт.docx", "ops/deploy", "user@example.com"]) {
      expect(identifierLike(term)).toBe(true);
    }
    // A hyphen joins ordinary words too ("follow-up", "какой-то"); two characters say too little.
    for (const term of ["follow-up", "какой-то", "template", "v2", "Q4"]) expect(identifierLike(term)).toBe(false);
  });

  it("read phrases for identifiers and joined chunks, longest first and bounded", () => {
    expect(pastChatPhraseChunks(["rollout", "ABC-1234", "campaign_42", "follow-up", "1234"]))
      .toEqual(["campaign_42", "follow-up", "ABC-1234", "1234"]);
    expect(pastChatPhraseChunks(Array.from({ length: 30 }, (_, index) => `id-${index}`))).toHaveLength(12);
  });
});

describe("past-chat word units", () => {
  it("weigh rare and long terms over common and short ones", () => {
    expect(inverseDocumentFrequency(1, 6000)).toBeGreaterThan(inverseDocumentFrequency(3000, 6000));
    expect(inverseDocumentFrequency(6000, 6000)).toBeGreaterThan(0);
    const units = pastChatWordUnits([stat("exact", "rollout", 40), stat("exact", "the", 5800), stat("exact", "abc-1234", 2)]);
    expect(units.map((unit) => unit.term)).toEqual(["w:abc-1234", "w:rollout", "w:the"]);
    expect(units.every((unit) => !unit.pin)).toBe(true);
  });

  it("pin passages of an identifier the query names exactly, but only while it is rare", () => {
    const rare = pastChatWordUnits([stat("phrase", "ABC-1234", 3)]);
    expect(rare).toEqual([expect.objectContaining({ needle: "ABC-1234", pin: true, term: "p:abc-1234" })]);
    expect(pastChatWordUnits([stat("phrase", "2026", 900)])[0]!.pin).toBe(false);
    // A joined chunk that is no identifier is a phrase but pins nothing.
    expect(pastChatWordUnits([stat("phrase", "follow-up", 1)])[0]!.pin).toBe(false);
  });

  it("merge a one-lexeme phrase into its exact unit and keep the pin", () => {
    const units = pastChatWordUnits([stat("exact", "1234", 2), stat("phrase", "1234", 2, "'1234'")]);
    expect(units).toEqual([expect.objectContaining({ pin: true, query: "'1234'", term: "w:1234" })]);
  });

  it("add a prefix only for letter words it widens, at a lower weight under the same term", () => {
    const units = pastChatWordUnits([stat("exact", "договор", 5), stat("prefix", "договор", 30), stat("exact", "abc1", 2),
      stat("prefix", "abc1", 9), stat("exact", "tool", 4), stat("prefix", "tool", 4), stat("prefix", "cat", 9)]);
    const prefixes = units.filter((unit) => unit.query.endsWith(":*"));
    expect(prefixes.map((unit) => unit.query)).toEqual(["'договор':*"]);
    const exact = units.find((unit) => unit.query === "'договор'")!;
    expect(prefixes[0]!.term).toBe(exact.term);
    expect(prefixes[0]!.weight).toBeLessThan(exact.weight);
  });

  it("leave out units that match nothing", () => {
    expect(pastChatWordUnits([stat("exact", "absent", 0), stat("phrase", "ABC-9", 0)])).toEqual([]);
  });
});
