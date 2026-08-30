import { HttpDocumentParserEngineAdapter } from "./client";
import { getDocumentParserConfig } from "./config";
import type { DocumentParseInput, ParsedDocument } from "./types";

export type DoclingLayoutParser = (
  input: DocumentParseInput
) => Promise<ParsedDocument>;

/** Creates the independent layout verifier used by adaptive System Model PDF
 * parsing. OCR is unconditionally disabled on this lane. */
export function createConfiguredDoclingLayoutParser(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: typeof fetch
): DoclingLayoutParser | null {
  const config = getDocumentParserConfig(environment).docling;
  if (!config) return null;
  const adapter = new HttpDocumentParserEngineAdapter({
    config,
    engine: "docling",
    ...(fetchImpl ? { fetch: fetchImpl } : {})
  });
  return (input) => adapter.parse({
    ...input,
    docling: { doOcr: false },
    mediaType: input.mimeType
  });
}
