import { describe, expect, it } from "vitest";
import { isSafeUploadFileName } from "@/lib/domain/uploadFormats";
import type { TelegramMessage } from "../botApi";
import { cleanTelegramFileName, largestTelegramPhoto, planTelegramMedia, TELEGRAM_FILE_MAX_BYTES } from "./plan";

const base: TelegramMessage = { chat: { id: 1, type: "private" }, date: 0, has_other_content: false, message_id: 1 };
const options = { uploadMaxBytes: 25_000_000, workspaceEnabled: false };
const MiB = 1024 * 1024;

describe("Telegram media plan", () => {
  it("picks the largest photo Telegram serves within the download bound", () => {
    const size = (id: string, width: number, fileSize?: number) => ({
      file_id: id, file_unique_id: `u${id}`, height: width, width, ...(fileSize === undefined ? {} : { file_size: fileSize })
    });
    expect(largestTelegramPhoto([size("s", 90, 1_000), size("m", 800, 90_000), size("l", 2_560, 21 * MiB)])?.file_id).toBe("m");
    expect(largestTelegramPhoto([size("s", 90), size("l", 1_280)])?.file_id).toBe("l");
    expect(largestTelegramPhoto([size("l", 2_560, TELEGRAM_FILE_MAX_BYTES + 1)])).toBeNull();
    expect(planTelegramMedia({ ...base, photo: [size("l", 2_560, 21 * MiB)] }, options)).toEqual({ kind: "refused", refusal: { reason: "file_too_large" } });
  });

  it("keeps a document's own name as a safe upload name, its extension kept when the name is cut", () => {
    expect(cleanTelegramFileName("Отчёт\tQ3 / итог.docx", "U1")).toBe("Отчёт Q3 _ итог.docx");
    expect(cleanTelegramFileName("..", "U/2", "application/pdf")).toBe("document-U_2.pdf");
    expect(cleanTelegramFileName(undefined, "U3", "text/markdown")).toBe("document-U3.md");
    expect(cleanTelegramFileName(undefined, "U4", "application/x-unknown")).toBe("document-U4");
    const long = cleanTelegramFileName(`${"я".repeat(300)}.pdf`, "U5");
    expect(long.endsWith(".pdf")).toBe(true);
    expect(Buffer.byteLength(long, "utf8")).toBeLessThanOrEqual(255);
    expect(isSafeUploadFileName(long)).toBe(true);
  });

  it("checks voice length and size, audio types and attachment types from Telegram's own fields", () => {
    const voice = { duration: 600, file_id: "v", file_unique_id: "uv", file_size: 10 * MiB, mime_type: "audio/ogg" };
    expect(planTelegramMedia({ ...base, voice }, options)).toMatchObject({ kind: "audio", mimeType: "audio/ogg" });
    expect(planTelegramMedia({ ...base, voice: { ...voice, duration: 601 } }, options))
      .toEqual({ kind: "refused", refusal: { reason: "voice_too_long" } });
    expect(planTelegramMedia({ ...base, voice: { ...voice, file_size: 10 * MiB + 1 } }, options))
      .toEqual({ kind: "refused", refusal: { reason: "voice_too_large" } });
    const audio = { duration: 30, file_id: "a", file_name: "song.flac", file_unique_id: "ua", mime_type: "audio/flac" };
    // An audio type Speech to text does not take is a file: refused without Workspace, uploaded with it.
    expect(planTelegramMedia({ ...base, audio }, options)).toMatchObject({ kind: "refused", refusal: { reason: "unsupported_file" } });
    expect(planTelegramMedia({ ...base, audio }, { ...options, workspaceEnabled: true }))
      .toMatchObject({ fileName: "song.flac", kind: "attachment", scope: "workspace" });
    expect(planTelegramMedia({ ...base, audio: { ...audio, mime_type: "audio/mpeg" } }, options)).toMatchObject({ kind: "audio", mimeType: "audio/mpeg" });
    const document = { file_id: "d", file_name: "rec.m4a", file_unique_id: "ud", mime_type: "audio/mp4" };
    expect(planTelegramMedia({ ...base, document }, options)).toMatchObject({ kind: "audio", mimeType: "audio/mp4" });
    expect(planTelegramMedia({ ...base, document: { ...document, file_name: "notes.md", mime_type: "text/x-markdown" } }, options))
      .toMatchObject({ fileName: "notes.md", kind: "attachment", mimeType: "text/markdown", scope: "attachment" });
    // Below Telegram's bound, the installation's upload cap still refuses before the download.
    expect(planTelegramMedia({ ...base, document: { ...document, file_name: "a.pdf", file_size: 2 * MiB, mime_type: "application/pdf" } },
      { ...options, uploadMaxBytes: MiB })).toEqual({ kind: "refused", refusal: { reason: "file_too_large" } });
    expect(planTelegramMedia({ ...base, has_other_content: true, document }, options)).toBeNull();
    expect(planTelegramMedia({ ...base, text: "hi" }, options)).toBeNull();
  });
});
