import { parentPort, workerData } from "node:worker_threads";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import {
  countTokens,
  setMergeCacheSize
} from "gpt-tokenizer/encoding/gpt2";
import {
  decodeBrightDocumentRow,
  normalizeBrightDocumentText
} from "./brightStackOverflowContract";

export type BrightTokenWorkerInput = Readonly<{
  batchRows: number;
  documentsPath: string;
  rowEnd: number;
  rowStart: number;
}>;

export type BrightTokenWorkerResult = Readonly<{
  documentCount: number;
  normalizedGpt2Tokens: number;
  rawGpt2Tokens: number;
  rowEnd: number;
  rowStart: number;
}>;

const ordinaryText = Object.freeze({
  allowedSpecial: new Set<string>(),
  disallowedSpecial: new Set<string>()
});

export async function countBrightGpt2Tokens(
  input: BrightTokenWorkerInput
): Promise<BrightTokenWorkerResult> {
  if (
    !Number.isSafeInteger(input.rowStart) || input.rowStart < 0 ||
    !Number.isSafeInteger(input.rowEnd) || input.rowEnd <= input.rowStart ||
    !Number.isSafeInteger(input.batchRows) || input.batchRows < 1
  ) throw new Error("bright_stackoverflow_token_worker_input_invalid");
  setMergeCacheSize(5_000);
  const file = await asyncBufferFromFile(input.documentsPath);
  let documentCount = 0;
  let normalizedGpt2Tokens = 0;
  let rawGpt2Tokens = 0;
  for (let rowStart = input.rowStart; rowStart < input.rowEnd;
    rowStart += input.batchRows) {
    const rowEnd = Math.min(input.rowEnd, rowStart + input.batchRows);
    const rows = await parquetReadObjects({
      columns: ["id", "content"],
      file,
      rowEnd,
      rowStart
    });
    if (rows.length !== rowEnd - rowStart) {
      throw new Error("bright_stackoverflow_token_worker_row_count_mismatch");
    }
    for (const [offset, row] of rows.entries()) {
      const document = decodeBrightDocumentRow(row, rowStart + offset);
      const preparedText = normalizeBrightDocumentText(document.rawText);
      rawGpt2Tokens += countTokens(document.rawText, ordinaryText);
      normalizedGpt2Tokens += countTokens(preparedText, ordinaryText);
      documentCount += 1;
    }
  }
  return Object.freeze({
    documentCount,
    normalizedGpt2Tokens,
    rawGpt2Tokens,
    rowEnd: input.rowEnd,
    rowStart: input.rowStart
  });
}

if (parentPort) {
  countBrightGpt2Tokens(workerData as BrightTokenWorkerInput).then(
    (result) => parentPort.postMessage(result),
    (error: unknown) => parentPort.postMessage({
      error: error instanceof Error ? error.message : "bright_stackoverflow_token_worker_failed"
    })
  );
}
