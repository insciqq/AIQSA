import { render, screen, waitFor } from "@testing-library/react";
import {
  buildPublicShareSnapshot,
  type PublicShareSnapshot
} from "@/lib/domain/shareSnapshot";
import { describe, expect, it } from "vitest";
import { PublicShareUnavailableView, PublicShareView } from "./PublicShareView";

function snapshot(messages: PublicShareSnapshot["messages"]): PublicShareSnapshot {
  return {
    messages,
    title: "Snapshot title",
    version: 1
  };
}

function message(role: "assistant" | "user", text: string): PublicShareSnapshot["messages"][number] {
  return {
    content: {
      blocks: text ? [{ text, type: "text" }] : []
    },
    role
  };
}

describe("PublicShareView", () => {
  it("presents the sanitized branch as an unmistakably read-only AIQSA snapshot", () => {
    const { container } = render(
      <PublicShareView
        snapshot={snapshot([
          message("user", "How should this be structured?"),
          message("assistant", "# Recommended structure\n\nUse the shared reading rhythm.")
        ])}
        title="Architecture notes"
      />
    );

    expect(screen.getByText("AIQSA")).toBeVisible();
    const readOnlyMarker = screen.getByText("Read-only snapshot");
    expect(readOnlyMarker).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "Architecture notes" })).toBeVisible();
    expect(screen.getByText(/it shows one conversation branch/i)).toBeVisible();
    expect(screen.getByRole("list", { name: "Shared conversation" })).toBeVisible();
    expect(screen.getByRole("article", { name: "Shared question" })).toHaveAttribute("data-role", "user");
    expect(screen.getByRole("article", { name: "Shared answer" })).toHaveAttribute(
      "data-role",
      "assistant"
    );
    expect(screen.getByRole("heading", { level: 2, name: "Recommended structure" })).toBeVisible();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("matches the private thread's compact question and document-like answer treatment", () => {
    render(
      <PublicShareView
        snapshot={snapshot([message("user", "A compact question"), message("assistant", "A full answer")])}
        title="Reading rhythm"
      />
    );

    expect(screen.getByRole("article", { name: "Shared question" })).toHaveClass(
      "mx-auto",
      "max-w-reading"
    );
    expect(screen.getByRole("article", { name: "Shared answer" })).toHaveClass(
      "min-w-0",
      "max-w-reading",
      "text-[16px]",
      "leading-[1.68]"
    );
    expect(
      screen.getByRole("article", { name: "Shared question" }).querySelector(
        '[data-public-share-message-content="true"]'
      )
    ).toHaveClass(
      "ml-auto",
      "max-w-[min(36rem,88%)]",
      "rounded-panel",
      "bg-control-surface"
    );
    expect(
      screen.getByRole("article", { name: "Shared answer" }).querySelector(
        '[data-public-share-message-content="true"]'
      )
    ).not.toHaveClass(
      "rounded-panel",
      "bg-control-surface"
    );
    expect(screen.getByTestId("public-share-view")).toHaveClass("bg-answer-paper", "text-ink");
    expect(screen.getByTestId("public-share-note")).toHaveClass("border-trace-subtle");
    expect(screen.queryByText("User")).not.toBeInTheDocument();
    expect(screen.queryByText("Assistant")).not.toBeInTheDocument();
  });

  it("does not introduce private chat controls, ids, or metadata", () => {
    const share = snapshot([message("user", "Public question"), message("assistant", "Public answer")]);
    const withPrivateFields = {
      ...share,
      ownerUserId: "private-owner-id",
      messages: share.messages.map((item, index) => ({
        ...item,
        attachmentId: `private-attachment-${index}`,
        id: `private-message-${index}`,
        internalRunId: `private-run-${index}`,
        providerPayload: "private-provider-payload"
      }))
    } as unknown as PublicShareSnapshot;
    const { container } = render(<PublicShareView snapshot={withPrivateFields} title="Safe snapshot" />);

    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/regenerate|edit message|delete message|branch from here|details/i)).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent("private-owner-id");
    expect(container).not.toHaveTextContent("private-message-0");
    expect(container).not.toHaveTextContent("private-run-1");
    expect(container).not.toHaveTextContent("private-provider-payload");
    expect(container.querySelector("[data-message-id]")).not.toBeInTheDocument();
  });

  it("does not project private Memory sources or opaque refs into a public share", () => {
    const share = snapshot([message("assistant", "A public answer")]);
    const withMemorySources = {
      ...share,
      memorySources: [{
        actions: ["CORRECT", "FORGET", "NOT_RELEVANT"],
        date: "2026-08-21T05:00:00.000Z",
        memoryRef: "opaque-private-memory-ref",
        origin: "Private chat title",
        sourceAvailable: true,
        sourceType: "SAVED_MEMORY",
        text: "Private remembered detail"
      }],
      messages: share.messages.map((item) => ({
        ...item,
        artifactSummary: {
          memorySources: [{ memoryRef: "opaque-private-memory-ref", text: "Private remembered detail" }]
        }
      }))
    } as unknown as PublicShareSnapshot;
    const { container } = render(<PublicShareView snapshot={withMemorySources} title="Safe snapshot" />);

    expect(container).not.toHaveTextContent("Memory · 1");
    expect(container).not.toHaveTextContent("opaque-private-memory-ref");
    expect(container).not.toHaveTextContent("Private remembered detail");
    expect(container).not.toHaveTextContent("Private chat title");
  });

  it("keeps safe links interactive and unsafe markdown inert", () => {
    render(
      <PublicShareView
        snapshot={snapshot([
          message(
            "assistant",
            "Read [the source](https://example.com/research) but not [this link](javascript:alert(1))."
          )
        ])}
        title="Links"
      />
    );

    expect(screen.getByRole("link", { name: "the source" })).toHaveAttribute(
      "href",
      "https://example.com/research"
    );
    expect(screen.getByRole("link", { name: "the source" })).toHaveAttribute("rel", "noreferrer");
    expect(screen.queryByRole("link", { name: "this link" })).not.toBeInTheDocument();
    expect(screen.getByText(/\[this link\]\(javascript:alert\(1\)\)/)).toBeVisible();
  });

  it("renders shared answer math through the same safe Markdown boundary", async () => {
    const { container } = render(
      <PublicShareView
        snapshot={snapshot([
          message("assistant", String.raw`The robust estimate is \(\hat\sigma\).

\[
\frac{\mathrm{MAD}}{0.67449}
\]`)
        ])}
        title="Robust estimate"
      />
    );

    await waitFor(() => expect(container.querySelectorAll(".katex")).toHaveLength(2));

    expect(container.querySelectorAll('[data-math-display="false"]')).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Scrollable mathematical formula" })).toBeVisible();
  });

  it("contains long text, tables, and code inside the public reading measure", () => {
    const longToken = "AIQSA_PUBLIC_UNBROKEN_".repeat(80);
    const { container } = render(
      <PublicShareView
        snapshot={snapshot([
          message("user", longToken),
          message(
            "assistant",
            [
              "| Long value | Result |",
              "| --- | --- |",
              `| ${longToken} | contained |`,
              "",
              "```text",
              longToken,
              "```"
            ].join("\n")
          )
        ])}
        title={longToken}
      />
    );

    expect(screen.getByTestId("public-share-view")).toHaveClass("min-w-0", "overflow-x-hidden");
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass(
      "break-words",
      "[overflow-wrap:anywhere]"
    );
    expect(screen.getByRole("article", { name: "Shared question" })).toHaveClass("min-w-0");
    expect(screen.getByTestId("markdown-table-scroll")).toHaveClass("max-w-full", "overflow-x-auto");
    expect(screen.getByTestId("markdown-code-scroll")).toHaveClass("max-w-full", "overflow-x-auto");
    expect(container.querySelector("pre")).toContainElement(container.querySelector("code"));
  });

  it("renders deliberate empty snapshot and empty-turn states", () => {
    const { rerender } = render(<PublicShareView snapshot={snapshot([])} title="Empty snapshot" />);

    expect(screen.getByTestId("public-share-empty")).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "This snapshot has no visible messages." })).toBeVisible();
    expect(screen.queryByTestId("public-share-thread")).not.toBeInTheDocument();

    rerender(<PublicShareView snapshot={snapshot([message("assistant", "")])} title="Empty turn" />);

    expect(screen.getByTestId("public-share-thread")).toBeVisible();
    expect(screen.getByText("No shared text in this turn.")).toBeVisible();
  });

  it("renders attachment-only and mixed sanitized turns without private attachment metadata", () => {
    const safeSnapshot = buildPublicShareSnapshot({
      activeLeafMessageId: "assistant-private",
      messages: [
        {
          content: {
            blocks: [
              {
                attachmentId: "private-image-id",
                alt: "Sensitive image alt text",
                storageKey: "private/image-key",
                type: "image",
                url: "https://storage.example/private-image"
              }
            ]
          },
          id: "user-private",
          parentMessageId: null,
          role: "user"
        },
        {
          content: {
            blocks: [
              { text: "Public answer", type: "text" },
              {
                attachmentId: "private-file-id",
                fileName: "executive-compensation-private.pdf",
                metadata: { object: "private-object-metadata" },
                storageKey: "private/file-key",
                type: "file",
                url: "https://storage.example/private-file"
              }
            ]
          },
          id: "assistant-private",
          parentMessageId: "user-private",
          role: "assistant"
        }
      ],
      title: "Safe share"
    });
    const { container } = render(
      <PublicShareView snapshot={safeSnapshot} title="Safe share" />
    );

    expect(screen.getByText("[Image attachment omitted]")).toBeVisible();
    expect(screen.getByText("Public answer")).toBeVisible();
    expect(screen.getByText("[Attachment omitted]")).toBeVisible();
    for (const privateValue of [
      "Sensitive image alt text",
      "private-image-id",
      "private-file-id",
      "executive-compensation-private.pdf",
      "private-object-metadata",
      "private/image-key",
      "private/file-key",
      "https://storage.example/private-image",
      "https://storage.example/private-file",
      "user-private",
      "assistant-private"
    ]) {
      expect(container).not.toHaveTextContent(privateValue);
    }
  });

  it("uses a safe fallback for a blank snapshot title", () => {
    render(<PublicShareView snapshot={snapshot([])} title="   " />);

    expect(screen.getByRole("heading", { level: 1, name: "Shared chat" })).toBeVisible();
  });
});

describe("PublicShareUnavailableView", () => {
  it("uses one generic unavailable state without exposing snapshot details", () => {
    const { container } = render(<PublicShareUnavailableView />);

    expect(screen.getByTestId("public-share-unavailable")).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "Shared snapshot unavailable" })).toBeVisible();
    expect(screen.getByText(/link is invalid or the snapshot is no longer available/i)).toBeVisible();
    expect(container).not.toHaveTextContent(/revoked|expired|owner|user id|share token/i);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
