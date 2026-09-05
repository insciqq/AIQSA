import { modelPdfPagesToDocument } from "../parsing/modelPdfOutput";
import { chunkKnowledgeDocument } from "./chunking";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "./indexProfile";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";
import { KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER } from "./tokenizer/knowledgeTokenCounter";

/** Neutral repeated-value fixture shared by parse/dispatch and bounded-read
 * integration, so both checks use the same immutable normalized artifact. */
export function tableOccurrenceFixture() {
  const header = "Object\tDate\tValue\tUnit";
  const rows = ["A\t2040-01-01\t10\tkg", "B\t2040-02-03\t10\tkg"];
  const parsed = modelPdfPagesToDocument({ maxBlocks: 100, maxCharacters: 10_000,
    mode: "system_model_vision", pageCount: 1, tableContinuationMarkers: true,
    pages: [{ page: 1, text: ["Issued 2041-02-03.", "", header, ...rows].join("\n") }] });
  const encoded = encodeKnowledgeNormalizedDocument(parsed, { maxChunksPerDocument: 100,
    maxFileBytes: 1_000_000, maxNormalizedChars: 100_000, maxNormalizedObjectBytes: 1_000_000, maxPages: 10
  }, { layoutAwareTables: true, sourceDisplayName: "measurements.pdf" });
  const chunks = chunkKnowledgeDocument({ document: encoded.document, maxChunks: 100,
    profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION, tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER });
  const data = chunks.filter(({ documentContext }) => documentContext?.locator.kind === "table_row" &&
    documentContext.locator.rowKind === "data");
  return { chunks, data, encoded, header, rows };
}
