import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSkillLibraryStoreForTest } from "@/components/app-shell/skillLibraryStore";
import type { SkillDetail } from "@/lib/contracts/skills";
import type { SkillSourcePreview } from "@/lib/contracts/skillSources";
import { SkillSourceImportDialog } from "./SkillSourceImportDialog";

const sourceUrl = "https://github.com/example/skills";
const source = { kind: "github" as const, url: sourceUrl, revision: "a".repeat(40) };
const candidate = { path: "skills/review", name: "Review", description: "Review a document", fileCount: 3,
  totalBytes: 420, hasExecutables: false, bundleDigest: "b".repeat(64), matches: [] };
function preview(overrides: Partial<SkillSourcePreview> = {}): SkillSourcePreview {
  return { source, fingerprint: "c".repeat(64), ignoredFiles: 1, candidates: [candidate], ...overrides };
}
const library = { nextCursor: null, publishableWorkspaces: [], skills: [], viewer: { canPublishInstallation: false } };

async function findSkills(): Promise<void> {
  fireEvent.change(screen.getByRole("textbox", { name: "Source link" }), { target: { value: sourceUrl } });
  fireEvent.click(screen.getByRole("button", { name: "Find Skills" }));
  await screen.findByRole("list", { name: "Skills found at source" });
}

describe("SkillSourceImportDialog", () => {
  afterEach(() => { cleanup(); resetSkillLibraryStoreForTest(); vi.unstubAllGlobals(); });

  it("imports selected bundles and requires an explicit action for an existing name", async () => {
    const writes: unknown[] = [];
    const response = { results: [{ name: "Review", outcome: "updated", skillId: "existing" }], ignoredFiles: 1 };
    const onImported = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/preview")) return Response.json(preview({ candidates: [
        { ...candidate, matches: [{ id: "existing", name: "Review", version: 4 }] },
        { path: "broken", name: "Broken", matches: [], error: { code: "skill_field_required", field: "description" } }
      ] }));
      if (String(input).endsWith("/url")) { writes.push(JSON.parse(String(init?.body))); return Response.json(response); }
      return Response.json(library);
    }));
    render(<SkillSourceImportDialog onClose={vi.fn()} onImported={onImported} />);
    await findSkills();
    const checkbox = screen.getByRole("checkbox", { name: "Select Review from skills/review" });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Broken from broken" })).toBeDisabled();
    expect(screen.getByText("description is required.")).toBeVisible();
    fireEvent.click(checkbox);
    expect(screen.getByRole("button", { name: "Import selected" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Choose an import action");
    fireEvent.change(screen.getByRole("combobox", { name: "Import action for Review from skills/review" }), { target: { value: "existing" } });
    expect(screen.getByText(/Updating replaces that Skill’s instructions/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(response));
    expect(writes).toEqual([{ url: sourceUrl, fingerprint: "c".repeat(64), selections: [{ path: candidate.path,
      bundleDigest: candidate.bundleDigest, action: { kind: "update", skillId: "existing", version: 4 } }] }]);
  });

  it("allows explicitly creating a separate Skill when the name already exists", async () => {
    let body: unknown;
    const onImported = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/preview")) return Response.json(preview({ candidates: [{ ...candidate,
        matches: [{ id: "existing", name: "Review", version: 2 }] }] }));
      if (String(input).endsWith("/url")) {
        body = JSON.parse(String(init?.body));
        return Response.json({ results: [{ name: "Review", outcome: "created", skillId: "new" }], ignoredFiles: 0 });
      }
      return Response.json(library);
    }));
    render(<SkillSourceImportDialog onClose={vi.fn()} onImported={onImported} />);
    await findSkills();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Review from skills/review" }));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "create" } });
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    expect(body).toMatchObject({ selections: [{ action: { kind: "create" } }] });
  });

  it("explains standalone Markdown, invalidates edited links and ignores stale preview responses", async () => {
    let resolve!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>(done => { resolve = done; });
    }));
    render(<SkillSourceImportDialog onClose={vi.fn()} onImported={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Source link" }), { target: { value: sourceUrl } });
    fireEvent.click(screen.getByRole("button", { name: "Find Skills" }));
    expect(screen.getByText("Downloading the source and finding Skills…")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Source link" }), { target: { value: "https://example.org/SKILL.md" } });
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolve(Response.json(preview())); });
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("button", { name: "Import selected" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Find Skills" }));
    await act(async () => { resolve(Response.json(preview({ source: { ...source, kind: "markdown", url: "https://example.org/SKILL.md" }, candidates: [{ ...candidate, fileCount: 0 }] }))); });
    expect(screen.getByText(/This link imports SKILL.md only/)).toBeVisible();
    expect(screen.getByText("SKILL.md · 420 bytes")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Source link" }), { target: { value: sourceUrl } });
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("button", { name: "Import selected" })).toBeDisabled();
  });

  it("checks the saved source and preselects the version-fenced target while showing local replacement", async () => {
    const target = { id: "mine", importSource: { ...source, path: candidate.path, bundleDigest: candidate.bundleDigest } } as SkillDetail;
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json(preview({ target: { id: "mine", name: "My edited review", version: 8, path: candidate.path, locallyModified: true },
        candidates: [candidate, { ...candidate, path: "skills/other", name: "Other" }] }));
    }));
    render(<SkillSourceImportDialog target={target} onClose={vi.fn()} onImported={vi.fn()} />);
    expect(await screen.findByRole("checkbox", { name: "Select Review from skills/review" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Other from skills/other" })).not.toBeChecked();
    expect(screen.getByRole("combobox", { name: "Import action for Review from skills/review" })).toHaveValue("mine");
    expect(screen.getByText("Your Skill has local changes since its last import.")).toBeVisible();
    expect(calls).toEqual([{ url: sourceUrl, targetSkillId: "mine" }]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Other from skills/other" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Import action for Other from skills/other" }), { target: { value: "mine" } });
    expect(screen.getByRole("alert")).toHaveTextContent("two selected Skills cannot update the same Skill");
    expect(screen.getByRole("button", { name: "Import selected" })).toBeDisabled();
  });

  it("requires a new preview after a source conflict and does not announce a successful import", async () => {
    const onImported = vi.fn();
    let checks = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/preview")) { checks++; return Response.json(preview()); }
      return Response.json({ error: "skill_source_changed" }, { status: 409 });
    }));
    render(<SkillSourceImportDialog onClose={vi.fn()} onImported={onImported} />);
    await findSkills();
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Find Skills again before importing");
    expect(onImported).not.toHaveBeenCalled();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByRole("button", { name: "Import selected" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Find Skills" }));
    await screen.findByRole("list");
    expect(checks).toBe(2);
  });

  it("blocks duplicate submission and closing while an import is settling", async () => {
    let resolve!: (response: Response) => void;
    let writes = 0;
    const onClose = vi.fn(), onImported = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/preview")) return Response.json(preview());
      if (String(input).endsWith("/url")) { writes++; return new Promise<Response>(done => { resolve = done; }); }
      return Response.json(library);
    }));
    render(<SkillSourceImportDialog onClose={onClose} onImported={onImported} />);
    await findSkills();
    const button = screen.getByRole("button", { name: "Import selected" });
    fireEvent.click(button); fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    const response = { ignoredFiles: 0, results: [{ name: "Review", outcome: "failed", error: { code: "skill_version_conflict" } }] };
    await act(async () => resolve(Response.json(response)));
    expect(writes).toBe(1);
    expect(onImported).toHaveBeenCalledWith(response);
  });

  it("lets a failed source be retried without losing the link and keeps background focus isolated", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => ++attempts === 1
      ? Response.json({ error: "skill_source_unavailable" }, { status: 502 }) : Response.json(preview())));
    const onClose = vi.fn();
    render(<><button>Background</button><SkillSourceImportDialog onClose={onClose} onImported={vi.fn()} /></>);
    fireEvent.change(screen.getByRole("textbox", { name: "Source link" }), { target: { value: sourceUrl } });
    fireEvent.click(screen.getByRole("button", { name: "Find Skills" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check that the link is public");
    expect(screen.getByRole("textbox", { name: "Source link" })).toHaveValue(sourceUrl);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Find Skills" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Background" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Find Skills" }));
    await screen.findByRole("list");
    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
