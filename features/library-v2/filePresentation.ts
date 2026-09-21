import type { FileSummaryV2 } from "./contracts";

const typeLabels: Readonly<Record<string, string>> = {
  png: "PNG", jpg: "JPEG", jpeg: "JPEG", gif: "GIF", webp: "WebP", pdf: "PDF",
  md: "Markdown", markdown: "Markdown", txt: "Text", json: "JSON", csv: "CSV",
  html: "HTML", htm: "HTML", doc: "Word document", docx: "Word document",
  xls: "Excel workbook", xlsx: "Excel workbook", ppt: "PowerPoint presentation",
  pptx: "PowerPoint presentation"
};

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : "";
}

export function fileTypeLabel(name: string): string {
  const extension = fileExtension(name);
  return typeLabels[extension] ?? (extension.toUpperCase() || "File");
}

export type FileGroupV2 = Readonly<{
  key: string;
  saved: boolean;
  files: readonly FileSummaryV2[];
}>;

/** Input order comes from the server: saved first, then descending recency. */
export function groupLibraryFiles(files: readonly FileSummaryV2[]): FileGroupV2[] {
  const saved = files.filter(file => file.savedAt !== null);
  const chats = new Map<string, FileSummaryV2[]>();
  for (const file of files) {
    if (file.savedAt !== null) continue;
    const key = file.chatId ?? file.id;
    const group = chats.get(key);
    if (group) group.push(file);
    else chats.set(key, [file]);
  }
  return [
    ...(saved.length ? [{ key: "saved", saved: true, files: saved }] : []),
    ...Array.from(chats, ([key, group]) => ({ key: `chat:${key}`, saved: false, files: group }))
  ];
}
