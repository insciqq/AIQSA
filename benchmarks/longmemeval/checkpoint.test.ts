import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLongMemEvalCheckpointRun,
  loadLongMemEvalCaseCheckpoints,
  resumeLongMemEvalCheckpointRun,
  writeLongMemEvalAnswersAtomic,
  writeLongMemEvalCaseCheckpoint
} from "./checkpoint";

const temporaryDirectories: string[] = [];
const decoders = Object.freeze({
  failure(value: unknown) {
    if (typeof value !== "string") throw new Error("failure_invalid");
    return value;
  },
  summary(value: unknown) {
    if (typeof value !== "string") throw new Error("summary_invalid");
    return value;
  }
});

async function temporaryOutput(): Promise<string> {
  const parent = await mkdtemp(resolve(tmpdir(), "aiqsa-longmemeval-checkpoint-"));
  temporaryDirectories.push(parent);
  return resolve(parent, "run");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

describe("LongMemEval case checkpoints", () => {
  it("atomically retains every terminal attempt and rebuilds ordered answers", async () => {
    const outputDirectory = await temporaryOutput();
    const identity = Object.freeze({ profile: "official", questionIds: ["case_1"] });
    const manifest = await createLongMemEvalCheckpointRun({
      identity,
      outputDirectory,
      startedAt: new Date("2026-08-29T00:00:00.000Z")
    });
    expect(manifest.startedAt).toBe("2026-08-29T00:00:00.000Z");

    const first = await writeLongMemEvalCaseCheckpoint({
      execution: { caseConcurrency: 1, origin: "LIVE", sessionConcurrency: 8 },
      outcome: {
        failure: "provider_unavailable",
        reason: "provider_unavailable",
        status: "FAILED"
      },
      outputDirectory,
      questionId: "case_1",
      questionType: "multi-session"
    });
    await writeLongMemEvalCaseCheckpoint({
      execution: { caseConcurrency: 2, origin: "LIVE", sessionConcurrency: 16 },
      outcome: {
        hypothesis: "private answer",
        reason: "memory_used",
        status: "COMPLETE",
        summary: "safe aggregate summary"
      },
      outputDirectory,
      previous: first,
      questionId: "case_1",
      questionType: "multi-session"
    });

    const checkpoints = await loadLongMemEvalCaseCheckpoints(
      outputDirectory,
      decoders
    );
    expect(checkpoints.get("case_1")?.attempts).toMatchObject([
      {
        attempt: 1,
        execution: { caseConcurrency: 1, origin: "LIVE", sessionConcurrency: 8 },
        outcome: { reason: "provider_unavailable", status: "FAILED" }
      },
      {
        attempt: 2,
        execution: { caseConcurrency: 2, origin: "LIVE", sessionConcurrency: 16 },
        outcome: { reason: "memory_used", status: "COMPLETE" }
      }
    ]);

    await writeLongMemEvalAnswersAtomic(outputDirectory, [
      { hypothesis: "private answer", questionId: "case_1" }
    ]);
    expect(await readFile(resolve(outputDirectory, "answers.jsonl"), "utf8"))
      .toBe('{"hypothesis":"private answer","question_id":"case_1"}\n');
    await expect(resumeLongMemEvalCheckpointRun({
      expectedIdentity: identity,
      outputDirectory
    })).resolves.toEqual(manifest);
  });

  it("fails closed on a different run identity or a corrupted checkpoint", async () => {
    const outputDirectory = await temporaryOutput();
    await createLongMemEvalCheckpointRun({
      identity: { profile: "official" },
      outputDirectory
    });
    await expect(resumeLongMemEvalCheckpointRun({
      expectedIdentity: { profile: "product" },
      outputDirectory
    })).rejects.toThrow("longmemeval_checkpoint_manifest_mismatch");

    await writeFile(
      resolve(outputDirectory, "case-checkpoints", "case_1.json"),
      '{"version":1}\n',
      { mode: 0o600 }
    );
    await expect(loadLongMemEvalCaseCheckpoints(outputDirectory, decoders))
      .rejects.toThrow("longmemeval_checkpoint_invalid");
  });

  it("ignores an interrupted atomic-write temporary file", async () => {
    const outputDirectory = await temporaryOutput();
    await createLongMemEvalCheckpointRun({ identity: {}, outputDirectory });
    await writeFile(
      resolve(outputDirectory, "case-checkpoints", "case_1.json.deadbeef.tmp"),
      "partial",
      { mode: 0o600 }
    );
    await expect(loadLongMemEvalCaseCheckpoints(outputDirectory, decoders))
      .resolves.toEqual(new Map());
  });
});
