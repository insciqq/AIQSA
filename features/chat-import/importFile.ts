import {
  ImportArchiveError,
  type ImportArchive,
  type ImportArchiveLimits
} from "./archive/archiveTypes";
import { openTarGzArchive } from "./archive/tarGzArchive";
import { openZipArchive } from "./archive/zipArchive";

export type ImportFileKind = "json" | "tar.gz" | "unknown" | "zip";

/** A file the user picked, opened lazily inside the import worker. */
export interface ImportFile {
  readonly name: string;
  readonly size: number;
  readonly kind: ImportFileKind;
  /** The whole file as UTF-8 text; a file larger than `maxBytes` is refused unread. */
  text(maxBytes: number): Promise<string>;
  /** The file's first `maxBytes` as UTF-8, for recognizing a format. */
  head(maxBytes: number): Promise<string>;
  /** The zip or tar.gz view, opened once; other kinds are not archives. */
  archive(): Promise<ImportArchive>;
}

export class ImportFileTooLargeError extends Error {
  constructor() {
    super("import_file_too_large");
    this.name = "ImportFileTooLargeError";
  }
}

const SNIFF_BYTES = 64;
const utf8 = new TextDecoder("utf-8");

function detectKind(name: string, head: Uint8Array): ImportFileKind {
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5) && (head[3] === 4 || head[3] === 6)) {
    return "zip";
  }
  if (head[0] === 0x1f && head[1] === 0x8b) return "tar.gz";
  const text = utf8.decode(head).replace(/^﻿/u, "").trimStart();
  if (text.startsWith("{") || text.startsWith("[") || /\.json$/iu.test(name)) return "json";
  return "unknown";
}

/** Recognizes a picked file by its leading bytes (falling back to the name for JSON). */
export async function openImportFile(
  file: Blob & { readonly name: string },
  limits?: ImportArchiveLimits
): Promise<ImportFile> {
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const kind = detectKind(file.name, head);
  let archive: Promise<ImportArchive> | null = null;
  return {
    archive() {
      archive ??= kind === "zip"
        ? openZipArchive(file, limits)
        : kind === "tar.gz"
          ? Promise.resolve(openTarGzArchive(file, limits))
          : Promise.reject(new ImportArchiveError("archive_invalid"));
      return archive;
    },
    async head(maxBytes) {
      return utf8.decode(await file.slice(0, maxBytes).arrayBuffer());
    },
    kind,
    name: file.name,
    size: file.size,
    async text(maxBytes) {
      if (file.size > maxBytes) throw new ImportFileTooLargeError();
      return utf8.decode(await file.arrayBuffer());
    }
  };
}
