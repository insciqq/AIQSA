import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow, expectWithinViewport } from "./support/layoutAssertions";

for (const theme of ["dark", "light"] as const) {
  test(`v2 navigation archive undo and collapse · ${theme}`, async ({ context, page }) => {
    await context.addCookies([{
      name: "aiqsa.theme",
      value: theme,
      url: "http://127.0.0.1:3000"
    }]);
    await page.setViewportSize({ height: 900, width: 1440 });
    await page.goto("/ui-v2-fixture?fixture=navigation");

    await page.getByRole("button", { name: "Actions: Quarterly product brief" }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    await expect(page.getByRole("status")).toHaveText("Chat moved to archive·Undo");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("treeitem", {
      exact: true,
      name: "Quarterly product brief"
    })).toBeVisible();

    await page.getByRole("button", { name: "Close sidebar" }).click();
    await expect(page.getByRole("button", { name: "Open sidebar" })).toBeFocused();
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(page.getByRole("complementary", { name: "Chat navigation" }))
      .toBeVisible();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("searchbox", { name: "Filter chats" })).toBeFocused();
  });

  test(`v2 conversation interaction and containment · ${theme}`, async ({ context, page }) => {
    await context.addCookies([{
      name: "aiqsa.theme",
      value: theme,
      url: "http://127.0.0.1:3000"
    }]);
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto("/ui-v2-fixture?fixture=conversation&state=basic");
    const answer = page.getByRole("article", { name: "Answer" }).first();
    await answer.click();
    await expect(answer).toHaveAttribute("data-controls-open", "true");
    await expect(page.getByRole("toolbar", { name: "Answer actions" }).first()).toBeVisible();

    await page.goto("/ui-v2-fixture?fixture=conversation&state=containment");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole("region", { name: "Scrollable table" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Scrollable code block" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Scrollable mathematical formula" })).toBeVisible();
    expect(await page.evaluate(() => (window as typeof window & { __unsafe?: boolean }).__unsafe)).toBeUndefined();
  });

  test(`v2 composer short-height sheet · ${theme}`, async ({ context, page }) => {
    await context.addCookies([{
      name: "aiqsa.theme",
      value: theme,
      url: "http://127.0.0.1:3000"
    }]);
    await page.setViewportSize({ height: 500, width: 1100 });
    await page.goto("/ui-v2-fixture?fixture=composer&state=add");

    const sheet = page.getByRole("menu", { name: "Add" });
    await expect(sheet).toBeVisible();
    const sheetBox = await sheet.boundingBox();
    const closeBox = await sheet.getByRole("button", { name: "Close" }).boundingBox();
    expect(sheetBox).not.toBeNull();
    expect(closeBox).not.toBeNull();
    expect(sheetBox!.x).toBe(0);
    expect(sheetBox!.y).toBeGreaterThanOrEqual(0);
    expect(sheetBox!.x + sheetBox!.width).toBeLessThanOrEqual(1101);
    expect(sheetBox!.y + sheetBox!.height).toBeLessThanOrEqual(501);
    expect(closeBox!.width).toBeGreaterThanOrEqual(40);
    expect(closeBox!.height).toBeGreaterThanOrEqual(40);
  });
}

test("v2 run lifecycle refreshes only on request and isolates its live source", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.goto("/ui-v2-fixture?fixture=run-lifecycle");

  const partial = page.getByRole("region", {
    name: "Connection lost · unknown until refresh"
  });
  await expect(partial.getByText("Connection lost", { exact: true })).toBeVisible();
  await expect(partial).toContainText("Собрал книгу из трёх листов");
  await partial.getByRole("button", { name: "Refresh" }).click();
  await expect(partial.getByText("Connection lost", { exact: true })).toBeHidden();
  await expect(partial).toContainText("Собрал книгу из трёх листов");

  const unavailableStop = page.getByRole("button", { name: "Stop answer" }).first();
  const durableStop = page.getByRole("button", { name: "Stop answer" }).last();
  await expect(unavailableStop).toBeDisabled();
  await expect(durableStop).toBeEnabled();

  const announcer = page.getByTestId("run-lifecycle-announcer");
  await expect(announcer).toHaveText("Working on the answer…");
  await page.getByRole("treeitem", { exact: true, name: "Settled answer" }).click();
  await expect(announcer).toHaveText("");

  const compacted = page.getByRole("region", { name: "Complete · context compacted" });
  await expect(compacted).toContainText("Context compacted");
  await compacted.getByTestId("tool-activity-disclosure").locator("summary").click();
  await expect(compacted.getByTestId("context-compaction-status")).toContainText("Approx. 600 working-context tokens removed");
  await expect(compacted).not.toContainText("notes");

  const unavailable = page.getByRole("region", { name: "Failed · context source unavailable" });
  await expect(unavailable).toContainText("Context source unavailable");
  await unavailable.getByTestId("tool-activity-disclosure").locator("summary").click();
  await expect(unavailable.getByTestId("context-compaction-status")).toContainText("Context source unavailable");
});

test("v2 compaction states stay server-truthful and readable at phone width", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/ui-v2-fixture?fixture=run-lifecycle");

  const running = page.getByRole("region", { exact: true, name: "Context compaction" });
  await running.getByTestId("tool-activity-disclosure").locator(":scope > summary").click();
  const runningStatus = running.getByTestId("context-compaction-status");
  await expect(runningStatus).toHaveAttribute("data-state", "running");
  await expect(runningStatus).toContainText("Summarizing earlier messages to fit the working context.");

  const lost = page.getByRole("region", { exact: true, name: "Connection lost · compaction was running" });
  const lostFold = lost.getByTestId("tool-activity-disclosure");
  await expect(lostFold.locator(":scope > summary")).toHaveText("Context compaction · connection lost");
  await expect(lostFold.locator(".v2-spinner")).toHaveCount(0);
  await expect(lost.getByTestId("run-connection-lost")).toBeVisible();

  const failed = page.getByRole("region", { exact: true, name: "Failed · provider reason in a long fold label" });
  const label = failed.getByTestId("tool-activity-disclosure").locator(":scope > summary .v2-answer-process-label");
  await label.scrollIntoViewIfNeeded();
  await expect(label).toHaveText("Worked for 1m 4s · Provider could not compact the context");
  expect(await label.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await expectWithinViewport(page, label);
  await expectNoHorizontalOverflow(page);
});

test("v2 conversation preserves the visible anchor after loading earlier messages", async ({ page }) => {
  await page.setViewportSize({ height: 700, width: 1100 });
  await page.goto("/ui-v2-fixture?fixture=conversation&state=earlier");
  const scroller = page.getByTestId("conversation-scroll");
  const anchor = page.locator('[data-conversation-message-id="earlier-current-4"]');
  // The mounted thread rests at its latest message; wait for that client
  // scroll before positioning, otherwise a pre-hydration scrollTop can leave
  // the top sentinel within its auto-load margin and the page loads itself.
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await scroller.evaluate((element) => {
    element.scrollTop = 760;
  });
  const topBefore = await anchor.evaluate((element) => element.getBoundingClientRect().top);
  await page.getByRole("button", { name: "Load earlier messages" }).evaluate(
    (button: HTMLButtonElement) => button.click()
  );
  await expect(page.getByText("Сначала определим, что именно хотим измерить.")).toBeAttached();
  const topAfter = await anchor.evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(topAfter - topBefore)).toBeLessThan(2);
});

test("v2 composer owns keyboard traversal and restores focus without leaking bindings", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.goto("/ui-v2-fixture?fixture=composer&state=default");

  const modelTrigger = page.getByRole("button", { exact: true, name: "GPT-5.2" });
  await modelTrigger.click();
  const modelSearch = page.getByRole("searchbox", { name: "Search models" });
  await expect(modelSearch).toBeFocused();
  await modelSearch.press("End");
  const gemini = page.getByRole("option", { name: /Gemini 3 Pro/ });
  await expect(gemini).toBeFocused();
  await gemini.press("Enter");
  await expect(page.getByRole("dialog", { name: "Choose model" })).toBeHidden();
  await expect(page.getByRole("button", { exact: true, name: "Gemini 3 Pro" })).toBeFocused();

  const plus = page.getByRole("button", { name: "Add" });
  await plus.click();
  await expect(page.getByRole("menu", { name: "Add" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(plus).toBeFocused();

  const text = await page.getByTestId("composer-v2").innerText();
  expect(text).not.toContain("openai-work");
  expect(text).not.toContain("google-work");
  expect(text).not.toContain("kb-finance");
  expect(text).not.toContain("mcp-office");
});

test("v2 composer routes picker, drop, and paste through one visible attachment owner", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.goto("/ui-v2-fixture?fixture=composer&state=default");

  await page.getByLabel("Attach files").setInputFiles({
    buffer: Buffer.from("quarter,total\nQ3,42"),
    mimeType: "text/csv",
    name: "quarter.csv"
  });

  await page.getByTestId("composer-v2-surface").evaluate((surface) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["binary"], "setup.exe", {
      type: "application/x-msdownload"
    }));
    surface.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer
    }));
  });

  await page.getByRole("textbox", { name: "Message" }).evaluate((textarea) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["pdf"], "brief.pdf", { type: "application/pdf" }));
    textarea.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer
    }));
  });

  await expect(page.getByText("quarter.csv", { exact: true })).toBeVisible();
  await expect(page.getByText("setup.exe", { exact: true })).toBeVisible();
  await expect(page.getByText("brief.pdf", { exact: true })).toBeVisible();
  await expect(page.getByText("Format not supported", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("note", { name: "Files are private and visible only to you." })
  ).toBeVisible();

  const input = page.getByRole("textbox", { name: "Message" });
  await expect(input).toBeEnabled();
  await input.fill("Черновик остаётся доступен");
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
});

test("v2 attachment failures keep exact retry and remove resolution", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.goto("/ui-v2-fixture?fixture=composer&state=attachments");

  await expect(page.getByText("4 files · 78.3 KB", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("scan.pdf", { exact: true })).toBeVisible();
  await expect(page.getByText("Processing failed", { exact: true })).toBeHidden();
  await expect(page.getByText("Processing…", { exact: true })).toHaveCount(2);

  await page.getByRole("button", { name: "Remove archive.pdf" }).click();
  await expect(page.getByText("archive.pdf", { exact: true })).toBeHidden();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
});

test("v2 answer outputs expose only Sources and direct user outputs", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.goto("/ui-v2-fixture?fixture=answer-outputs&state=complete");

  const answer = page.locator('article[data-role="assistant"]').first();
  await expect(answer).toContainText("Research assistant");
  // Sources live in the actions row: a chip that expands the list in place.
  await expect(page.getByTestId("answer-sources")).toHaveCount(0);
  const toggle = answer.getByRole("toolbar", { name: "Answer actions" })
    .getByTestId("answer-sources-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const outputs = answer.getByTestId("answer-sources");
  await expect(outputs.getByRole("link", { name: "Cross-language retrieval evaluation" }))
    .toBeVisible();
  await expect(outputs).not.toContainText("Knowledge");

  await page.setViewportSize({ height: 700, width: 390 });
  await expectNoHorizontalOverflow(page);
  const text = await outputs.innerText();
  expect(text).not.toContain("fixture query never rendered");
  expect(text).not.toContain("fixture-private-id");
  expect(text).not.toMatch(/Run details|Answer evidence|Tools \d|Files \d/iu);
});

test("v2 answer outputs reserve no placeholder and keep Reasoning optional", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=answer-outputs&state=empty");
  await expect(page.getByTestId("answer-outputs")).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toMatch(/Run details|Answer evidence/iu);

  await page.goto("/ui-v2-fixture?fixture=answer-outputs&state=reasoning");
  // One human line above the text; Thinking waits inside the fold.
  const process = page.getByTestId("tool-activity-disclosure");
  await expect(process.locator("summary")).toHaveText("Thought for 12s");
  await process.locator("summary").click();
  await expect(page.getByTestId("answer-reasoning")).toContainText("Thinking");
  await expect(page.getByTestId("answer-reasoning")).not.toContainText("**");
  await expect(page.getByTestId("answer-sources-toggle")).toHaveCount(0);
  await expect(page.getByTestId("answer-sources")).toHaveCount(0);
});

test("v2 memory recall and the saved-memory notice keep their verbs behind menus", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.goto("/ui-v2-fixture?fixture=answer-outputs&state=memory");
  const answer = page.locator('article[data-role="assistant"]').first();
  const process = answer.getByTestId("tool-activity-disclosure");
  await expect(process.locator(":scope > summary")).toHaveText("Worked for 8s · Memory · 2");
  await expect(answer.getByTestId("memory-action-confirmation")).toContainText("Memory saved.");
  await expect(answer.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await process.locator(":scope > summary").click();
  await expect(answer.getByRole("heading", { name: "Steps" })).toBeVisible();
  await answer.getByTestId("memories-disclosure").locator(":scope > summary").click();
  const rows = answer.getByTestId("memory-source-card");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("My dog is called Bruno and he is a beagle.");
  await rows.first().getByTestId("memory-source-actions").click();
  const menu = answer.getByRole("menu", { name: "Memory actions" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Correct", "Not relevant", "Forget"]);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(rows.first().getByTestId("memory-source-actions")).toBeFocused();
  await expectNoHorizontalOverflow(page);
});

for (const viewport of [
  { height: 900, name: "desktop", width: 1440 },
  { height: 1180, name: "tablet-portrait", width: 820 },
  { height: 844, name: "phone-portrait", width: 390 },
  { height: 390, name: "phone-landscape", width: 844 }
] as const) {
  test(`v2 MCP approval cards decide with explicit bounded controls · ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await page.goto("/ui-v2-fixture?fixture=answer-outputs&state=approval");
    const pending = page.getByRole("listitem", { name: "Approval for Records vault delete_record" });
    await expect(pending).toContainText("Approval needed");
    await expect(pending).toContainText("nothing was sent");
    await expect(pending.getByRole("button", { name: /^Review arguments/u })).toBeVisible();
    for (const name of ["Deny", "Always allow for this server", "Allow once"]) {
      await expect(pending.getByRole("button", { name })).toBeVisible();
    }
    const member = page.getByRole("listitem", { name: "Approval for Shared tracker close_issue" });
    await expect(member).toContainText("Only the person who sent this message can allow this tool.");
    await expect(member.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("listitem", { name: "Approval for Records vault purge_records" })).toContainText("Denied");
    const waiting = page.getByRole("listitem", { name: "Approval for Calendar create_event" });
    await expect(waiting).toContainText("The answer has not continued yet.");
    await expect(waiting.getByRole("button", { name: "Continue" })).toBeVisible();
    await expect(page.getByRole("article", { exact: true, name: "Approval" })).toHaveText("Allowed: update_record");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ fullPage: false, path: testInfo.outputPath(`mcp-approval-${viewport.name}-pending.png`) });

    await pending.getByRole("button", { name: "Allow once" }).click();
    await expect(pending).toContainText("Allowed once: only this exact call may run, once.");
    await expect(pending.getByRole("button", { name: "Allow once" })).toHaveCount(0);
    const code = page.getByRole("listitem", { name: /^Approval for Records vault archive_records/u });
    await code.getByRole("button", { name: "Deny" }).click();
    await expect(code).toContainText("Nothing was sent.");
    await expect(code.getByRole("button")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ fullPage: false, path: testInfo.outputPath(`mcp-approval-${viewport.name}-decided.png`) });
  });
}

for (const viewport of [
  { height: 900, name: "desktop", width: 1440 },
  { height: 1180, name: "tablet-portrait", width: 820 },
  { height: 844, name: "phone-portrait", width: 390 },
  { height: 390, name: "phone-landscape", width: 844 }
] as const) {
  test(`v2 reviewed answer groups its versions under one answer · ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });
    await page.goto("/ui-v2-fixture?fixture=answer-review&state=collapsed");
    const gallery = page.getByTestId("ui-v2-answer-review-gallery");
    // The server-written turns are never bubbles: one question, one answer block.
    await expect(gallery.locator('article[data-role="user"]')).toHaveCount(1);
    await expect(gallery.getByText(/Answer (review|revision) request/u)).toHaveCount(0);
    await expect(gallery).toContainText("opened in March 2021");
    const toggle = gallery.getByRole("button", { name: "Review history · 1 round" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(gallery.getByTestId("answer-review-status")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ fullPage: false, path: testInfo.outputPath(`answer-review-${viewport.name}-collapsed.png`) });

    await page.goto("/ui-v2-fixture?fixture=answer-review&state=expanded");
    const history = page.getByTestId("answer-review-history");
    await expect(history).toContainText("Version 1");
    await expect(history.getByTestId("answer-review-card")).toContainText("Review by GPT-5: 2 findings");
    await expect(history.getByTestId("answer-review-decisions")).toHaveText(/Decisions: 1 accepted, 1 rejected/u);
    await expect(history).toContainText("Version 2 is the answer shown above.");
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ fullPage: true, path: testInfo.outputPath(`answer-review-${viewport.name}-expanded.png`) });

    await page.goto("/ui-v2-fixture?fixture=answer-review&state=running");
    const live = page.getByTestId("answer-review-status");
    await expect(live).toContainText("Review · round 1 · GPT-5 is checking…");
    await expect(live.getByRole("button", { name: "Stop" })).toBeVisible();
    await expectWithinViewport(page, live);
    await page.screenshot({ fullPage: false, path: testInfo.outputPath(`answer-review-${viewport.name}-running.png`) });

    await page.goto("/ui-v2-fixture?fixture=answer-review&state=findings");
    await expect(page.getByTestId("answer-review-status")).toContainText("2 findings to evaluate");
    await expect(page.getByTestId("answer-review-status").getByRole("button", { name: "Revise" })).toBeVisible();
    await page.goto("/ui-v2-fixture?fixture=answer-review&state=clean");
    await expect(page.getByTestId("answer-review-status")).toContainText("No substantive issues");
    await expect(page.getByRole("button", { name: "Revise" })).toHaveCount(0);
  });
}


test("v2 branch drawer switches only the future leaf and restores trigger focus", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.goto("/ui-v2-fixture?fixture=branches&state=default");

  const drawer = page.getByRole("dialog", { name: "Conversation branches" });
  await expect(drawer).toBeHidden();
  const opener = page.getByRole("button", { name: "Branches" });
  await opener.click();
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".v2-branch-version").filter({ hasText: "Version 3" }))
    .toContainText("Current");
  const text = await drawer.innerText();
  expect(text).not.toContain("answer-edited");
  expect(text).not.toContain("question-root");

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();

  await opener.click();
  const original = drawer.locator(".v2-branch-version").filter({ hasText: "Version 1" });
  await original.getByRole("button", { name: "Switch" }).click();
  await expect(drawer).toBeHidden();
  await expect(page.getByText(
    "Первый ответ опирается только на lexical lane и служит исходной версией."
  )).toBeVisible();
  await expect(page.locator(".v2-branch-gallery-notice")).toContainText(
    "next message continues the selected branch"
  );
});

test("v2 branch pager and portalled More menu stay bounded and target exact versions", async ({ page }) => {
  await page.setViewportSize({ height: 560, width: 760 });
  await page.goto("/ui-v2-fixture?fixture=branches&state=default");

  const answerPager = page.getByTestId("branch-pager").first();
  await expect(answerPager.getByLabel("Version 2 of 2")).toHaveText("2/2");
  await answerPager.getByRole("button", { name: "Previous version" }).click();
  await expect(page.getByText(
    "Первый ответ опирается только на lexical lane и служит исходной версией."
  )).toBeVisible();

  const answer = page.getByRole("article", { name: "Answer" });
  await answer.click();
  await answer.getByRole("button", { name: "More answer actions" }).click();
  const menu = page.getByRole("menu", { name: "Answer menu" });
  // Branch first; Delete last and destructive (UX audit 2026-09-02 B4).
  await expect(menu.getByRole("menuitem").first()).toHaveText("Branch from here");
  await expect(menu.getByRole("menuitem").last()).toHaveText("Delete");
  await expect(menu.getByRole("menuitem").last()).toHaveAttribute("data-tone", "destructive");
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(761);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(561);
  await page.keyboard.press("Escape");
  await expect(answer.getByRole("button", { name: "More answer actions" })).toBeFocused();
});

test("v2 branch edit stays inline and preserves the composer draft", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/ui-v2-fixture?fixture=branches&state=edit");

  const inlineEdit = page.getByTestId("inline-message-edit-v2");
  await expect(inlineEdit).toContainText(
    "Sending creates a new branch; the original history stays unchanged."
  );
  await expect(inlineEdit.getByText("privacy-check.md")).toBeVisible();
  const composerInput = page.getByRole("textbox", { name: "Message" });
  await expect(composerInput).toHaveValue("Незавершённый черновик остаётся в композере.");
  await expect(composerInput).toBeDisabled();

  const input = inlineEdit.getByRole("textbox", { name: "Edit question" });
  await expect(input).toBeFocused();
  await input.press("Escape");
  const editedQuestion = page.locator('article[data-message-id="question-edited"]');
  const editButton = editedQuestion.getByRole("button", { name: "Edit question" });
  await expect(editButton).toBeFocused();
  await editButton.click();
  await expect(input).toBeFocused();
  await expect(composerInput).toHaveValue("Незавершённый черновик остаётся в композере.");
  await input.fill("Уточнённый вопрос остаётся в новой ветви");
  await inlineEdit.getByRole("button", { name: "Send" }).click();
  await expect(inlineEdit).toBeHidden();
  await expect(page.getByText("Уточнённый вопрос остаётся в новой ветви")).toBeVisible();
  await expect(composerInput).toHaveValue("Незавершённый черновик остаётся в композере.");
  await expect(page.locator(".v2-branch-gallery-notice")).toContainText(
    "original history is unchanged"
  );
});

test("v2 branch mutations stay disabled while a response is streaming", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/ui-v2-fixture?fixture=branches&state=streaming");

  const drawer = page.getByRole("dialog", { name: "Conversation branches" });
  await expect(drawer).toContainText("Another version cannot be opened while the answer is running");
  await expect(drawer.getByRole("button", { name: "Switch" })).toHaveCount(2);
  for (const button of await drawer.getByRole("button", { name: "Switch" }).all()) {
    await expect(button).toBeDisabled();
  }
  await drawer.getByRole("button", { name: "Close branches" }).click();
  const answer = page.getByRole("article", { name: "Answer" }).last();
  await answer.click();
  await expect(answer.getByRole("button", { name: "Regenerate answer" })).toBeDisabled();
  await expect(answer).toContainText("Wait for the answer to finish or stop it.");
});
