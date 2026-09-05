import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { expect, type Page } from "@playwright/test";

export type OfficeInput = { name: string; mimeType: string; buffer?: Buffer; text?: string };
type Turn = { chatId: string; run: { id: string; assistantMessageId: string | null } };
type Context = {
  db: PrismaClient;
  page: Page;
  fixtures: Map<string, Buffer>;
  officeCase: "ALL" | "STOCK" | "PRESENTATION" | "DOCX" | "MONTHLY";
  deleteChat(chatId: string): Promise<void>;
  downloads(runId: string, names: string[]): Promise<Map<string, Buffer>>;
  emit(value: Record<string, unknown>): void;
  newChat(files: OfficeInput[], enableWorkspace?: boolean): Promise<string | null>;
  oracle(name: string, files: Map<string, Buffer>): void;
  waitForAttachment(name: string, workspace: boolean): Promise<void>;
  captureUI(name: string): Promise<void>;
  send(chatId: string | null, prompt: string, clarification?: boolean): Promise<Turn>;
  setStage(value: string): void;
  setStep(value: string): void;
};
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const stock = "sku,product,quantity,unit_price\n0007,Notebook,12,4.50\n0042,Pen,30,1.20\n0105,Folder,8,2.75\n";
const officeMime = (name: string) => name.endsWith(".xlsx")
  ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  : name.endsWith(".pptx") ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function runOfficeUserScenarios(ctx: Context) {
  const { page, db } = ctx;
  const pins = new Map<string, { id: string; hash: string }>();
  const inspectedDialogs = new Set<string>();
  const ensure = (value: unknown, code: string) => {
    if (!value) throw new Error(`workspace_user_paid_office_${code}`);
  };
  const input = (name: string): OfficeInput => ({ name, mimeType: officeMime(name), buffer: ctx.fixtures.get(name)! });
  async function inspectDialog(name: string) {
    if (inspectedDialogs.has(name)) return;
    const originalViewport = page.viewportSize()!;
    const dialog = page.getByRole("dialog", { name, exact: true });
    for (const state of [
      { width: 1280, height: 900, colorScheme: "light" as const },
      { width: 390, height: 844, colorScheme: "dark" as const }
    ]) {
      await page.setViewportSize({ width: state.width, height: state.height });
      await page.emulateMedia({ colorScheme: state.colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-color-scheme", state.colorScheme);
      await expect.poll(async () => dialog.evaluate(element => {
        const box = element.getBoundingClientRect();
        return box.x >= 0 && box.y >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1 &&
          element.scrollWidth <= element.clientWidth + 1;
      })).toBe(true);
      for (let index = 0; index < 3; index += 1) {
        await page.keyboard.press("Tab");
        ensure(await dialog.evaluate(element => element.contains(document.activeElement)), "dialog_focus_escaped");
      }
      await ctx.captureUI(`${name.toLowerCase().replaceAll(" ", "-")}-${state.width}-${state.colorScheme}`);
    }
    await page.setViewportSize(originalViewport);
    await page.emulateMedia({ colorScheme: "light" });
    inspectedDialogs.add(name);
    ctx.emit({ stage: "ui_passed", surface: name, viewports: 2, themes: 2, focusContained: true });
  }
  async function saved(name: string, expected: Buffer) {
    const response = await page.request.get("/api/uploads");
    ensure(response.ok(), "library_unavailable");
    const body = await response.json();
    const file = body.files.find((file: { fileName: string; savedAt: string | null }) => file.savedAt && file.fileName === name);
    ensure(file, "saved_file_missing");
    const download = await page.request.get(`/api/attachments/${file.id}/content`);
    ensure(download.ok() && sha(await download.body()) === sha(expected), "saved_source_changed");
    pins.set(name, { id: file.id, hash: sha(expected) });
  }
  async function save(name: string, expected: Buffer, generated: boolean) {
    ctx.setStep(generated ? "save_generated" : "save_uploaded");
    const rows = generated
      ? page.locator('article[data-role="assistant"]').last().getByRole("region", { name: "Generated files" }).getByRole("listitem")
      : page.locator('article[data-role="user"]').last().getByRole("listitem");
    const row = rows.filter({ has: page.getByText(name, { exact: true }) });
    await row.getByRole("button", { name: "Save to Library", exact: true }).click();
    await expect(row.getByRole("button", { name: "Saved to Library" })).toBeDisabled();
    await saved(name, expected);
  }
  async function attachSaved(name: string, library = false) {
    ctx.setStep(library ? "reuse_from_library" : "reuse_from_picker");
    if (library) {
      await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("button", { name: "Library", exact: true }).click();
      await page.getByRole("tab", { name: "Files", exact: true }).click();
      const row = page.getByRole("list", { name: "Files", exact: true }).getByRole("listitem")
        .filter({ has: page.getByRole("heading", { name, exact: true }) });
      await row.getByRole("button", { name: "Use in chat", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    } else {
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.getByRole("menuitem", { name: "Saved files…" }).click();
    const picker = page.getByRole("dialog", { name: "Saved files" });
    await expect(picker.getByRole("textbox", { name: "Find saved files" })).toBeFocused();
    await inspectDialog("Saved files");
    await picker.getByRole("textbox", { name: "Find saved files" }).fill(name);
    await picker.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) }).getByRole("button", { name: "Use file" }).click();
    await expect(picker).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: /^Turn off Workspace/u })).toBeVisible();
    await ctx.waitForAttachment(name, true);
  }
  async function openHistory() {
    ctx.setStep("export_history");
    await page.getByRole("button", { name: "Chat actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Export history", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export history", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Loading exports…")).toHaveCount(0);
    return dialog;
  }
  async function history(expected: { turn: Turn; files: Map<string, Buffer> }[]) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("app-shell")).toBeVisible();
    let dialog = await openHistory();
    const entries = dialog.getByRole("list", { name: "Exports", exact: true }).locator(":scope > li");
    await expect(entries).toHaveCount(expected.length);
    await inspectDialog("Export history");
    for (const { turn, files } of expected) {
      const firstName = [...files.keys()][0]!;
      const entry = entries.filter({ has: page.getByText(firstName, { exact: true }) });
      await expect(entry.locator("time")).toBeVisible();
      for (const [name, bytes] of files) {
        const row = entry.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
        const pending = page.waitForEvent("download");
        await row.getByRole("link", { name: "Download", exact: true }).click();
        const download = await pending;
        const stream = await download.createReadStream();
        ensure(stream, "history_download_missing");
        const parts: Buffer[] = [];
        for await (const part of stream!) parts.push(Buffer.from(part));
        ensure(sha(Buffer.concat(parts)) === sha(bytes), "prior_export_changed");
      }
      await entry.getByRole("button", { name: "Go to answer" }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(`[data-message-id="${turn.run.assistantMessageId}"]`).first()).toBeInViewport();
      dialog = await openHistory();
    }
    await expect(dialog.getByRole("list", { name: "Exports", exact: true }).locator(":scope > li")).toHaveCount(expected.length);
    await dialog.getByRole("button", { name: "Close export history" }).click();
    const response = await page.request.get(`/api/chats/${expected[0]!.turn.chatId}/workspace/exports`);
    ensure(response.ok() && (await response.json()).exports.length === expected.length, "history_count_changed");
  }
  async function sourcePinsUnchanged() {
    for (const pin of pins.values()) {
      const response = await page.request.get(`/api/attachments/${pin.id}/content`);
      ensure(response.ok() && sha(await response.body()) === pin.hash, "saved_source_lifetime");
    }
  }
  const pass = (name: string, files: Map<string, Buffer>, evidence: Record<string, unknown> = {}) => {
    ctx.emit({ stage: "scenario_passed", case: name, artifacts: files.size, checksums: [...files.values()].map(sha), ...evidence });
  };

  try {
    let completed = 0;
    let blue = new Map([["stock-blue.xlsx", ctx.fixtures.get("stock-source.xlsx")!]]);
    if (ctx.officeCase === "ALL" || ctx.officeCase === "STOCK") {
      ctx.setStage("office_stock");
      const first = await ctx.send(await ctx.newChat([{ name: "stock.csv", mimeType: "text/csv", text: stock }]),
        "Make a useful Excel table from this CSV as stock-blue.xlsx. Preserve the four input columns and row order; SKU identifiers must remain text including leading zeros. Add line_total as the fifth column, quantity times unit_price. Use a dark blue #1E40AF header with white text, sensible column widths, a frozen header, filters and two decimal places for money. Give the workbook a randomly generated UUID v4 as its document-properties identifier for tracking; keep the identifier inside the file, without printing it or putting it in the chat. Provide the actual XLSX download.");
      blue = await ctx.downloads(first.run.id, ["stock-blue.xlsx"]);
      ctx.oracle("office_stock_blue", blue);
      await save("stock.csv", Buffer.from(stock), false);
      await save("stock-blue.xlsx", blue.get("stock-blue.xlsx")!, true);
      const purpleTurn = await ctx.send(first.chatId,
        "Change only the blue table header to purple #7C3AED. Keep all data, calculations, the report identifier and other formatting. Export this as stock-purple.xlsx, keeping the earlier downloadable file.");
      const purple = await ctx.downloads(purpleTurn.run.id, ["stock-purple.xlsx"]);
      ctx.oracle("office_stock_purple", new Map([...purple, ["previous.xlsx", blue.get("stock-blue.xlsx")!]]));
      // Force a fresh guest: the next turn must use authoritative stored exports.
      ctx.setStep("reset_workspace");
      await page.getByRole("button", { name: "Chat actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Reset workspace…" }).click();
      await page.getByRole("dialog", { name: "Reset workspace", exact: true }).getByRole("button", { name: "Confirm reset workspace", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Reset workspace", exact: true })).toHaveCount(0);
      const notesTurn = await ctx.send(first.chatId,
        "Use the earlier stock-blue.xlsx export, keeping its blue styling, report identifier and all data. Add a sixth column Notes, with Reorder in October for Notebook and empty notes for the other products. Export stock-notes.xlsx. I have not uploaded the earlier file again.");
      const notes = await ctx.downloads(notesTurn.run.id, ["stock-notes.xlsx"]);
      ctx.oracle("office_stock_notes", new Map([...notes, ["previous.xlsx", blue.get("stock-blue.xlsx")!]]));
      await history([{ turn: first, files: blue }, { turn: purpleTurn, files: purple }, { turn: notesTurn, files: notes }]);
      // Exercise the same exact-file reuse from history as the Library picker.
      const dialog = await openHistory();
      await dialog.getByRole("listitem").filter({ has: page.getByText("stock-blue.xlsx", { exact: true }) }).filter({ has: page.getByRole("button", { name: "Use file", exact: true }) }).last()
        .getByRole("button", { name: "Use file", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Attachments" })).toContainText("stock-blue.xlsx");
      await ctx.deleteChat(first.chatId);
      await sourcePinsUnchanged();
      pass("office_stock_history", new Map([...blue, ...purple, ...notes]), { historyAfterReload: true, canonicalExportAfterReset: true, savedUploadAndOutput: true, sourceChatDeleted: true });
      completed += 1;
    }

    if (ctx.officeCase === "ALL" || ctx.officeCase === "PRESENTATION") {
      ctx.setStage("office_presentation");
      const slidesTurn = await ctx.send(await ctx.newChat([{ name: "stock-blue.xlsx", mimeType: officeMime("stock-blue.xlsx"), buffer: blue.get("stock-blue.xlsx")! }]),
        "Create stock-review.pptx from the uploaded Excel table for a stock meeting. Four slides: overview, quantities by product, total inventory value and its product breakdown, then suggested actions. Include all product names and real values from the spreadsheet. Keep it readable and concise.");
      const slides = await ctx.downloads(slidesTurn.run.id, ["stock-review.pptx"]);
      ctx.oracle("office_slides", slides);
      const editTurn = await ctx.send(slidesTurn.chatId,
        "Please change only the third slide: title Updated purchasing plan, and include Reorder 20 notebooks. Keep slides 1, 2 and 4 unchanged. Export stock-review-revised.pptx and preserve the previous download.");
      const revised = await ctx.downloads(editTurn.run.id, ["stock-review-revised.pptx"]);
      ctx.oracle("office_slide_edit", new Map([...slides, ...revised]));
      await history([{ turn: slidesTurn, files: slides }, { turn: editTurn, files: revised }]);
      await ctx.deleteChat(slidesTurn.chatId);
      pass("office_presentation", new Map([...slides, ...revised]), { unchangedOtherSlides: true });
      completed += 1;
    }

    if (ctx.officeCase === "ALL" || ctx.officeCase === "DOCX") {
      ctx.setStage("office_docx");
      const docTurn = await ctx.send(await ctx.newChat([input("leave-application.docx")]),
        "Обнови это заявление: Иванов Иван Иванович, аналитик, идёт в отпуск с 5 августа 2026 года по 18 августа 2026 года включительно. Дата заявления 25 июля 2026 года. Сохрани существующее оформление, шапку, подчёркивание дат и место для подписи; подпись оставь пустой. Формат дат оставь как в исходнике: день и год цифрами, месяц словом. Верни заполненную копию leave-updated.docx.");
      const doc = await ctx.downloads(docTurn.run.id, ["leave-updated.docx"]);
      ctx.oracle("office_docx", new Map([...doc, ["leave-application.docx", ctx.fixtures.get("leave-application.docx")!]]));
      await save("leave-application.docx", ctx.fixtures.get("leave-application.docx")!, false);
      await ctx.deleteChat(docTurn.chatId);
      await sourcePinsUnchanged();
      const leaveChat = await ctx.newChat([], false);
      await attachSaved("leave-application.docx");
      const question = await ctx.send(leaveChat,
        "Заполни сохранённое заявление на отпуск с 1 сентября по 15 сентября включительно для того же сотрудника. Остальные недостающие сведения сначала уточни у меня, не подставляй их наугад.", true);
      const answerText = await page.locator('article[data-role="assistant"]').last().innerText();
      ensure(/год|году|year/iu.test(answerText) && /[?？]/u.test(answerText), "missing_year_not_clarified");
      ensure(await db.workspaceRunOutput.count({ where: { workspaceRunBindingId: question.run.id } }) === 0, "premature_template_filled");
      const leaveTurn = await ctx.send(question.chatId,
        "Отпуск в 2027 году, с 1 сентября по 15 сентября включительно. Дата заявления 20 августа 2027 года. Сотрудник, должность и адресат те же, что в шаблоне. Формат дат оставь как в исходнике: день и год цифрами, месяц словом; подпись оставь пустой. Сохрани оформление и верни заполненную копию leave-september.docx.");
      const leave = await ctx.downloads(leaveTurn.run.id, ["leave-september.docx"]);
      ctx.oracle("office_leave", new Map([...leave, ["leave-application.docx", ctx.fixtures.get("leave-application.docx")!]]));
      await sourcePinsUnchanged();
      await ctx.deleteChat(leaveTurn.chatId);
      pass("office_docx_templates", new Map([...doc, ...leave]), { clarification: true, originalPreserved: true, noVision: true });
      completed += 1;
    }

    if (ctx.officeCase === "ALL" || ctx.officeCase === "MONTHLY") {
      ctx.setStage("office_month_september");
      const templateNames = ["report-example.xlsx", "report-example.docx", "meeting-example.pptx"];
      const septemberData = "department,revenue,cost\nNorth,13500,9000\nSouth,6500,4000\n";
      const monthPrompt = (month: string) => `Use the supplied ordinary company examples as templates for the new monthly data. Produce ${month.toLowerCase()}-report.xlsx, ${month.toLowerCase()}-report.docx and ${month.toLowerCase()}-meeting.pptx together for ${month} 2026. Keep the Northwind Studio identity and the general structure/style of each example, including three presentation slides and the DOCX metrics table. Include the period and total revenue, costs and profit in all three files. Write the summary totals as numeric values, so they are available without recalculation. Replace the old period and its financial values. Provide useful brief conclusions based on the uploaded data. Preserve the saved examples.`;
      const september = await ctx.send(await ctx.newChat([...templateNames.map(input), { name: "september.csv", mimeType: "text/csv", text: septemberData }]), monthPrompt("September"));
      const septemberFiles = await ctx.downloads(september.run.id, ["september-report.xlsx", "september-report.docx", "september-meeting.pptx"]);
      ctx.oracle("office_month_september", septemberFiles);
      for (const name of templateNames) await save(name, ctx.fixtures.get(name)!, false);
      await save("september-report.xlsx", septemberFiles.get("september-report.xlsx")!, true);
      await history([{ turn: september, files: septemberFiles }]);
      await ctx.deleteChat(september.chatId);
      await sourcePinsUnchanged();
      ctx.setStage("office_month_october");
      const octoberChat = await ctx.newChat([{ name: "october.csv", mimeType: "text/csv", text: "department,revenue,cost\nNorth,18000,11000\nSouth,8000,5000\n" }], false);
      for (const name of ["september-report.xlsx", "report-example.docx", "meeting-example.pptx"]) await attachSaved(name, name.endsWith(".xlsx"));
      const october = await ctx.send(octoberChat, monthPrompt("October"));
      const octoberFiles = await ctx.downloads(october.run.id, ["october-report.xlsx", "october-report.docx", "october-meeting.pptx"]);
      ctx.oracle("office_month_october", octoberFiles);
      await history([{ turn: october, files: octoberFiles }]);
      await sourcePinsUnchanged();
      await ctx.deleteChat(october.chatId);
      pass("office_monthly_templates", new Map([...septemberFiles, ...octoberFiles]), { crossChatReuse: true, threeFilesPerAnswer: true, savedSourcesPreserved: true });
      completed += 1;
    }
    return { scenarios: completed };
  } finally {
    for (const pin of pins.values()) {
      const response = await page.request.delete(`/api/uploads/${pin.id}/save`);
      ensure(response.status() === 204, "saved_cleanup_failed");
    }
  }
}
