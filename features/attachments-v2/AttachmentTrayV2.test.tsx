import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComposerAttachment } from "@/components/app-shell/attachmentContracts";
import type { AttachmentLimitUsage } from "@/components/app-shell/attachmentLimitUsage";
import { AttachmentTrayV2 } from "./AttachmentTrayV2";
import { SentAttachmentsV2 } from "./SentAttachmentsV2";
import {
  attachmentItemsForV2,
  attachmentSendBlockReasonV2,
  type ComposerAttachmentItemV2
} from "./attachmentPresentation";

const items: ComposerAttachmentItemV2[] = [{
  fileName: "budget.csv",
  id: "upload",
  progress: 64,
  status: "uploading"
}, {
  fileName: "plan.docx",
  id: "processing",
  status: "processing"
}, {
  fileName: "sales.csv",
  id: "ready",
  status: "ready"
}, {
  fileName: "setup.exe",
  id: "unsupported",
  rejection: "unsupported_format",
  status: "rejected"
}, {
  detail: "Больше 50 MB",
  fileName: "archive.pdf",
  id: "large",
  rejection: "too_large",
  status: "rejected"
}, {
  detail: "Не удалось обработать PDF.",
  fileName: "scan.pdf",
  id: "failed",
  retryable: true,
  status: "failed"
}];

const criticalUsage: AttachmentLimitUsage = {
  binaryAttachmentCount: 2,
  blocking: true,
  count: 6,
  encodedBytes: 900,
  feedback: "limit",
  limits: { maxCount: 5, maxEncodedBytes: 750, maxMaterializedBytes: 700 },
  materializedBytes: 800,
  summary: "6 files",
  tone: "critical",
  totalSourceBytes: 1_024
};

describe("AttachmentTrayV2", () => {
  it("renders every attachment lifecycle without collapsing rejected reasons", () => {
    const retry = vi.fn();
    const remove = vi.fn();
    render(<AttachmentTrayV2 items={items} onRemove={remove} onRetry={retry} />);

    expect(screen.getByText("Загрузка… 64%")).toBeVisible();
    expect(screen.getByText("Обработка…")).toBeVisible();
    expect(screen.getByText("Готов")).toBeVisible();
    expect(screen.getByText("Формат не поддерживается")).toBeVisible();
    expect(screen.getByText("Больше 50 MB")).toBeVisible();
    expect(screen.getByText("Ошибка обработки")).toBeVisible();
    // The privacy disclosure is a quiet tooltip/AT note, not a permanent line.
    const privacyNote = screen.getByRole("note", {
      name: "Файлы приватны и доступны только вам."
    });
    expect(privacyNote).toHaveAttribute("title", "Файлы приватны и доступны только вам.");
    expect(privacyNote).not.toHaveTextContent("Файлы приватны");

    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    fireEvent.click(screen.getByRole("button", { name: "Удалить setup.exe" }));
    expect(retry).toHaveBeenCalledWith("failed");
    expect(remove).toHaveBeenCalledWith("unsupported");
  });

  it("keeps a blocking capacity receipt explicit", () => {
    render(<AttachmentTrayV2 items={items} usage={criticalUsage} />);
    expect(screen.getByRole("alert")).toHaveTextContent("6 файлов · 1 KB");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Лимит превышен — удалите часть файлов перед отправкой."
    );
  });

  it("maps server lifecycle and PDF warnings without exposing error codes", () => {
    const attachments: ComposerAttachment[] = [{
      fileName: "scan.pdf",
      id: "opaque-attachment",
      kind: "pdf",
      processingErrorCode: "pdf_extraction_failed",
      status: "failed"
    }, {
      fileName: "limited.pdf",
      id: "limited",
      kind: "pdf",
      status: "ready"
    }];
    const mapped = attachmentItemsForV2(attachments, [{
      attachmentId: "limited",
      blocking: true,
      label: "Text limited",
      message: "Choose native PDF support or remove this file."
    }]);

    expect(mapped[0]).toMatchObject({ retryable: true, status: "failed" });
    expect(mapped[0]?.detail).not.toContain("pdf_extraction_failed");
    expect(mapped[1]?.warning).toMatchObject({ blocking: true, label: "Текст ограничен" });
    expect(attachmentSendBlockReasonV2(mapped, null, false)).toContain("scan.pdf");
  });
});

describe("SentAttachmentsV2", () => {
  it("renders a quiet owner-only label line without private identifiers", () => {
    const { container } = render(
      <SentAttachmentsV2
        blocks={[
          { attachmentId: "private-attachment-id", label: "sample.txt", type: "file" },
          { attachmentId: "private-image-id", label: "Диаграмма продаж", type: "image" }
        ]}
      />
    );

    const list = screen.getByRole("list", { name: "Вложения сообщения" });
    expect(list).toHaveTextContent("sample.txt");
    expect(list).toHaveTextContent("Диаграмма продаж");
    expect(container.innerHTML).not.toContain("private-attachment-id");
    expect(container.innerHTML).not.toContain("private-image-id");
  });

  it("renders nothing for a message without attachments", () => {
    const { container } = render(<SentAttachmentsV2 blocks={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
