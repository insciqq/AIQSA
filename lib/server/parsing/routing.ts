import {
  normalizedUploadFileExtension,
  uploadFormatFor,
  type InlineDocumentFormat,
  type StructuredDocumentFormat,
  type SidecarParserEngine
} from "../../domain/uploadFormats";

export type { InlineDocumentFormat } from "../../domain/uploadFormats";

export type DocumentParserRoute =
  | Readonly<{
      extension: string;
      format: StructuredDocumentFormat;
      kind: "spreadsheet";
      mediaType: string;
    }>
  | Readonly<{
      extension: string;
      format: InlineDocumentFormat;
      kind: "inline";
      mediaType: string;
    }>
  | Readonly<{
      engines: readonly [SidecarParserEngine, ...SidecarParserEngine[]];
      extension: string;
      kind: "sidecar";
      mediaType: string;
    }>;

export const normalizedFileExtension = normalizedUploadFileExtension;

export function resolveDocumentParserRoute(
  fileName: string,
  mimeType: string
): DocumentParserRoute | undefined {
  const extension = normalizedUploadFileExtension(fileName);
  const format = uploadFormatFor(fileName, mimeType, "knowledge");
  if (!extension || !format?.parser) return undefined;

  return format.parser.kind === "inline"
    ? Object.freeze({
        extension,
        format: format.parser.format,
        kind: "inline" as const,
        mediaType: format.canonicalMimeType
      })
    : format.parser.kind === "spreadsheet"
      ? Object.freeze({
          extension,
          format: format.parser.format,
          kind: "spreadsheet" as const,
          mediaType: format.canonicalMimeType
        })
      : Object.freeze({
        engines: format.parser.engines,
        extension,
        kind: "sidecar" as const,
        mediaType: format.canonicalMimeType
      });
}
