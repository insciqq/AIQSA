import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeTokenUsage } from "../../lib/domain/usage";
import type { ProviderSearchAdapter } from "../../lib/server/providers/types";
import { cbrQuestion, eolQuestions, parseCbrRates, parseGeneratedQuestion, russianDate } from "./web-search-quality-build";
import { clientEngine, ENGINES, PENDING_ENGINES } from "./web-search-quality-engines";
import {
  answerQuestion,
  buildReport,
  exactMcNemar,
  judgePending,
  latestAnswers,
  parseQuestions,
  percentile,
  questionHash,
  readJsonl,
  readJudgments,
  runEvaluation,
  selectQuestions,
  type AnswerRecord,
  type Grader,
  type PreparedEngine,
  type Question,
  type ResponsesModel,
  type RunConfig
} from "./web-search-quality-support";
import { main, outputDirectory } from "./web-search-quality";

const directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "web-search-quality-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

/** The prototype's line format, with an extra field it carried for some sets. */
const QUESTION_LINES = [
  { gold: "Miriam Kastner", id: "s077", q: "Who was the medalist at the V. M. Goldschmidt Award in 2015?", set: "simpleqa" },
  { gold: "Bana Kingdom. 10 Kings.", id: "f080", q: "Which dynasty did the emperor's only sister marry into?", set: "frames" },
  { gold: "Further", id: "w001", q: "Как назывался дебютный сингл проекта LOKRUMENTAL?", set: "ruwiki", title: "LOKRUMENTAL" },
  { gold: "82,1664 руб.", id: "n07", q: "Какой официальный курс доллара США установил ЦБ РФ на 25 ноября 2026 года?", set: "fresh_ru" }
].map((line) => JSON.stringify(line)).join("\n");

/** A question whose fact sits in the middle of a long result, past the excerpt's head: only `read_tool_result` finds it. */
const LONG_ID = "w001";

/**
 * The product router over a fake engine. Its findings carry each question's gold, except for the frames question, about which it
 * knows nothing; the long question's gold is buried in the middle of 40 000 characters.
 */
function fakeEngine(questions: readonly Question[], calls: { search: number }): PreparedEngine {
  const byText = new Map(questions.map((question) => [question.q, question]));
  const adapter: ProviderSearchAdapter = {
    buildRequestPreview: () => ({ provider: "fake" }),
    search(request) {
      calls.search += 1;
      const question = byText.get(request.query);
      const fact = question && question.set !== "frames" ? `The answer is ${question.gold}.` : "Nothing relevant was found.";
      const findings = question?.id === LONG_ID ? `[1] ${"filler ".repeat(2_000)}\n${fact}\n${"filler ".repeat(4_000)}` : `[1] ${fact}`;
      return Promise.resolve({ artifacts: [], costUsd: 0.001, finalProviderResponsePreview: {}, findings, requestPreview: {},
        sourceAttribution: "available", sources: [{ citation: 1, rank: 1, title: "Fake source", url: "https://example.com/fact" }],
        usage: normalizeTokenUsage({}) });
    }
  };
  return clientEngine({ adapter, config: { maxOutputTokens: 16, queryMaxCharacters: 1_000, reasoningPolicy: "provider_default", timeoutMs: 10_000 },
    displayName: "Fake engine", modelId: "fake-search", protocol: "deepseek_search_api", provider: "deepseek" });
}

function message(text: string) {
  return { content: [{ text, type: "output_text" }], role: "assistant", type: "message" };
}

/**
 * A fake answer model: with hosted search it searches and answers in one response; with a client search tool it searches with the
 * question, reads a saved result's middle when the excerpt names a handle, and answers with what it read.
 */
function fakeModel(questions: readonly Question[], options: { failOnce?: Set<string>; requests: { count: number } }): ResponsesModel {
  const byText = new Map(questions.map((question) => [question.q, question]));
  return (body) => {
    options.requests.count += 1;
    const input = (body.input as Record<string, unknown>[]);
    const question = byText.get(String(input[0]!.content))!;
    if (options.failOnce?.delete(`${String(body.model)}:${question.id}`)) {
      return Promise.reject(Object.assign(new Error("upstream"), { code: "provider_response_not_retryable" }));
    }
    const tools = (body.tools ?? []) as Record<string, unknown>[];
    const usage = { input_tokens: 100, output_tokens: 10 };
    if (tools.some((tool) => tool.type === "web_search")) {
      return Promise.resolve({ output: [
        { action: { query: question.q, sources: [{ type: "url", url: "https://example.com/a" }], type: "search" }, id: "ws_1",
          status: "completed", type: "web_search_call" },
        message(question.set === "simpleqa" ? question.gold : "I could not find it.")
      ], status: "completed", usage });
    }
    const outputs = input.filter((item) => item.type === "function_call_output").map((item) => String(item.output));
    const search = tools.find((tool) => tool.type === "function" && tool.name !== "read_tool_result");
    if (search && outputs.length === 0) {
      return Promise.resolve({ output: [{ type: "reasoning", encrypted_content: "opaque", id: "rs_1", summary: [] },
        { arguments: JSON.stringify({ query: question.q }), call_id: "call_1", name: search.name, type: "function_call" }], status: "completed", usage });
    }
    const handle = /handle "(tor1_[a-f0-9]{32})"/u.exec(outputs.at(-1) ?? "")?.[1];
    if (handle && outputs.length === 1 && body.tool_choice !== "none") {
      return Promise.resolve({ output: [{ arguments: JSON.stringify({ handle, offset: 12_000 }), call_id: "call_2", name: "read_tool_result",
        type: "function_call" }], status: "completed", usage });
    }
    const read = outputs.join("\n");
    return Promise.resolve({ output: [message(read.includes(question.gold) ? `It is ${question.gold}.` : "I do not know.")], status: "completed", usage });
  };
}

const grader: Grader = (question, answer) =>
  Promise.resolve(answer.includes(question.gold) ? "CORRECT" : /do not know|could not/u.test(answer) ? "NOT_ATTEMPTED" : "INCORRECT");

describe("question file", () => {
  it("reads the prototype's format, ignores extra fields and marks Russian questions", () => {
    const questions = parseQuestions(`${QUESTION_LINES}\n`);
    expect(questions.map((question) => [question.id, question.set, question.russian])).toEqual([
      ["s077", "simpleqa", false], ["f080", "frames", false], ["w001", "ruwiki", true], ["n07", "fresh_ru", true]
    ]);
    expect(parseQuestions(JSON.stringify({ gold: "x", id: "a", lang: "ru", q: "plain English", set: "s" }))[0]!.russian).toBe(true);
  });

  it("names the line of a broken or duplicate question without its content", () => {
    expect(() => parseQuestions(`${QUESTION_LINES}\n{"id": "x"}`)).toThrow("question_line_invalid:5");
    expect(() => parseQuestions(`${QUESTION_LINES}\n${QUESTION_LINES.split("\n")[0]}`)).toThrow("question_id_duplicate:5");
  });

  it("takes a limited selection round-robin across sets, in file order", () => {
    const questions = parseQuestions(QUESTION_LINES);
    expect(selectQuestions(questions, { limit: 2 }).map((question) => question.id)).toEqual(["s077", "f080"]);
    expect(selectQuestions(questions, { sets: ["ruwiki", "fresh_ru"] }).map((question) => question.id)).toEqual(["w001", "n07"]);
  });
});

describe("statistics", () => {
  it("matches the prototype's exact McNemar values", () => {
    expect(exactMcNemar(16, 5)).toBeCloseTo(0.027, 3);
    expect(exactMcNemar(4, 15)).toBeCloseTo(0.019, 3);
    expect(exactMcNemar(5, 4)).toBe(1);
    expect(exactMcNemar(0, 0)).toBe(1);
  });

  it("takes nearest-rank percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("dry run with fake engines and a fake model", () => {
  it("answers through the product's search tool, reads a long result by handle, resumes and reports", async () => {
    const directory = scratch();
    const answersPath = join(directory, "answers.jsonl");
    const judgmentsPath = join(directory, "judgments.jsonl");
    const questions = parseQuestions(QUESTION_LINES);
    const calls = { search: 0 };
    const engines: Record<string, PreparedEngine> = { fake: fakeEngine(questions, calls), hosted: { kind: "in_answer" }, none: { kind: "none" } };
    const configs: RunConfig[] = ["fake", "hosted", "none"].map((engine) => ({ effort: "medium", engine, model: "gpt-fake" }));
    const requests = { count: 0 };
    let clock = 0;
    const run = (model: ResponsesModel) => runEvaluation({
      answer: (question, config, signal) => answerQuestion({ effort: config.effort, engine: engines[config.engine]!, instructions: "Answer.",
        maxRounds: 6, model, modelId: config.model, now: () => (clock += 500), question, signal }),
      answersPath, concurrency: 1, configs, now: () => (clock += 1_000), questions
    });

    const first = await run(fakeModel(questions, { failOnce: new Set(["gpt-fake:f080"]), requests }));
    expect(first).toEqual({ answered: 11, failed: 1, skipped: 0 });
    // An interrupted append leaves a cut line; it is skipped.
    appendFileSync(answersPath, '{"v":1,"config":"gpt-fake|fake|me');
    const firstRequests = requests.count;

    const second = await run(fakeModel(questions, { requests }));
    expect(second).toEqual({ answered: 1, failed: 0, skipped: 11 });
    expect(requests.count - firstRequests).toBe(2);

    const latest = latestAnswers(readJsonl(answersPath));
    const record = (engine: string, id: string) => latest.get(`gpt-fake|${engine}|medium\n${id}\n${questionHash(questions.find((question) => question.id === id)!)}`)!;
    const long = record("fake", LONG_ID);
    expect(long).toMatchObject({ answer: "It is Further.", engineCostUsd: 0.001, rounds: 3, status: "ok" });
    expect(long.searches).toEqual([{ costUsd: 0.001, query: questions[2]!.q, seconds: 0.5, sources: 1, status: "complete" }]);
    expect(record("fake", "f080")).toMatchObject({ answer: "I do not know.", status: "ok" });
    expect(record("hosted", "s077")).toMatchObject({ answer: "Miriam Kastner", engineCostUsd: null, rounds: 1 });
    expect(record("hosted", "s077").searches).toEqual([{ costUsd: null, query: questions[0]!.q, sources: 1, status: "complete" }]);
    expect(record("none", "n07")).toMatchObject({ engineCostUsd: 0, searches: [] });
    expect(calls.search).toBe(4);

    expect(await judgePending({ answers: latest, concurrency: 2, grade: grader, judgmentsPath, questions })).toEqual({ failed: 0, graded: 12 });
    expect(await judgePending({ answers: latest, concurrency: 2, grade: grader, judgmentsPath, questions })).toEqual({ failed: 0, graded: 0 });

    const report = buildReport({ answers: latest, grades: readJudgments(judgmentsPath), questions });
    const row = (config: string) => report.split("\n").find((line) => line.startsWith(config))!.split(/\s+/u);
    // config, n, acc, simpleqa, frames, ruwiki, fresh_ru, RU, na, err, ungr, eng$/q, p50, p90, srch/q, srchfail%
    expect(row("gpt-fake|fake|medium")).toEqual(["gpt-fake|fake|medium", "4", "75", "100", "0", "100", "100", "100", "25", "0", "0",
      "0.0010", "2.0", "2.5", "1.0", "0"]);
    expect(row("gpt-fake|hosted|medium").slice(0, 8)).toEqual(["gpt-fake|hosted|medium", "4", "25", "100", "0", "0", "0", "0"]);
    expect(row("gpt-fake|hosted|medium")[11]).toBe("unknown");
    expect(row("gpt-fake|none|medium").slice(2, 4)).toEqual(["0", "0"]);
    expect(report).toMatch(/gpt-fake\|fake\|medium\s+gpt-fake\|none\|medium\s+4\s+3\s+0\s+0\.250/u);
    expect(report).toMatch(/gpt-fake\|fake\|medium\s+gpt-fake\|hosted\|medium\s+4\s+2\s+0\s+0\.500/u);
  });

  it("a changed question's old answer is not reused", async () => {
    const directory = scratch();
    const answersPath = join(directory, "answers.jsonl");
    const [question] = parseQuestions(QUESTION_LINES);
    const config: RunConfig = { effort: "low", engine: "none", model: "gpt-fake" };
    const answered: string[] = [];
    const run = (questions: readonly Question[]) => runEvaluation({
      answer: (current) => {
        answered.push(current.gold);
        return Promise.resolve({ answer: current.gold, engineCostUsd: 0, inputTokens: null, outputTokens: null, rounds: 1, searches: [] });
      },
      answersPath, concurrency: 1, configs: [config], now: () => 0, questions
    });
    await run([question!]);
    await run([question!]);
    await run([{ ...question!, gold: "Someone else" }]);
    expect(answered).toEqual(["Miriam Kastner", "Someone else"]);
    expect((readJsonl(answersPath) as AnswerRecord[]).map((record) => record.qhash)).toHaveLength(2);
  });
});

describe("command line", () => {
  it("runs and reports a dry run outside the repository, and refuses an output directory inside it", async () => {
    const directory = scratch();
    const questionsPath = join(directory, "questions.jsonl");
    writeFileSync(questionsPath, QUESTION_LINES);
    const printed: string[] = [];
    const ports = { env: {}, now: () => performance.now(), print: (line: string) => { printed.push(line); } };
    const out = join(directory, "out");
    expect(await main(["run", "--questions", questionsPath, "--out", out, "--models", "gpt-fake", "--limit", "2", "--dry-run"], ports)).toBe(0);
    expect(await main(["report", "--questions", questionsPath, "--out", out, "--dry-run"], ports)).toBe(0);
    expect(printed).toContain("run: 6 answered, 0 failed (rerun to retry), 0 already answered");
    const report = readFileSync(join(out, "report.txt"), "utf8");
    expect(report).toContain("gpt-fake|deepseek|medium");
    expect(report).toContain("gpt-fake|openai-in-answer|medium");

    expect(() => outputDirectory(new Map([["out", resolve(".aiqsa", "eval")]]), resolve("."))).toThrow("eval_output_inside_repository");
    expect(await main(["run", "--questions", questionsPath, "--out", out, "--engines", "gemini"], ports)).toBe(2);
    // OpenRouter's engines drive the product adapter and need only the OpenRouter key.
    expect(await main(["run", "--questions", questionsPath, "--out", out, "--engines", "perplexity"], ports)).toBe(2);
    expect(printed.some((line) => line.startsWith("eval_env_missing:OPENROUTER_API_KEY"))).toBe(true);
    expect(printed.some((line) => line.startsWith("eval_env_missing:GEMINI_API_KEY"))).toBe(true);
    expect(Object.keys(PENDING_ENGINES)).toEqual([]);
    for (const id of ["perplexity", "parallel", "exa"]) expect(ENGINES[id]).toMatchObject({ env: ["OPENROUTER_API_KEY"], id });
    expect(ENGINES.gemini).toMatchObject({ env: ["GEMINI_API_KEY"], id: "gemini" });
  });
});

describe("question set builder", () => {
  it("writes rate questions from the Bank of Russia's daily XML", () => {
    const xml = '<?xml version="1.0"?><ValCurs Date="25.11.2026"><Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode>' +
      "<Nominal>1</Nominal><Name>Доллар США</Name><Value>82,1664</Value></Valute><Valute ID=\"R01335\"><CharCode>KZT</CharCode>" +
      "<Nominal>100</Nominal><Name>Казахстанских тенге</Name><Value>18,5538</Value></Valute></ValCurs>";
    const [usd, kzt] = parseCbrRates(xml);
    expect(cbrQuestion("2026-11-25", usd!)).toEqual({ gold: "82,1664 руб.", id: "cbr-20261125-usd",
      q: "Какой официальный курс доллара США установил ЦБ РФ на 25 ноября 2026 года?", russian: true, set: "fresh_ru" });
    expect(cbrQuestion("2026-11-18", kzt!)).toMatchObject({ gold: "18,5538 руб. за 100 казахстанских тенге",
      q: "Какой официальный курс казахстанского тенге установил ЦБ РФ на 18 ноября 2026 года (за 100 казахстанских тенге)?" });
    expect(russianDate("2026-01-02")).toBe("2 января 2026 года");
  });

  it("asks about the newest release lines released by the as-of date", () => {
    const payload = { result: { label: "Python", releases: [
      { latest: { date: "2026-11-30", name: "3.16.0" }, name: "3.16" },
      { latest: { date: "2026-10-25", name: "3.15.2" }, name: "3.15" },
      { latest: { date: "2026-10-25", name: "3.14.10" }, name: "3.14" },
      { latest: { date: "2026-01-01", name: "3.13.9" }, name: "3.13" }
    ] } };
    expect(eolQuestions(payload, "python", 2, "2026-11-25").map((question) => [question.id, question.gold, question.q])).toEqual([
      ["eol-python-3.15", "3.15.2", "Какая последняя версия Python в ветке 3.15 вышла по состоянию на 25 ноября 2026 года?"],
      ["eol-python-3.14", "3.14.10", "Какая последняя версия Python в ветке 3.14 вышла по состоянию на 25 ноября 2026 года?"]
    ]);
  });

  it("reads the generator's question or its skip", () => {
    expect(parseGeneratedQuestion('```json\n{"question": "Когда?", "answer": "1397"}\n```')).toEqual({ gold: "1397", q: "Когда?" });
    expect(parseGeneratedQuestion('{"skip": true}')).toBeNull();
    expect(parseGeneratedQuestion("no json")).toBeNull();
  });
});
