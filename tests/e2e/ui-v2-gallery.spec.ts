import { expect, test } from "@playwright/test";

const modes = [
  { height: 900, name: "desktop", width: 1440 },
  { height: 844, name: "mobile", width: 390 }
] as const;

for (const theme of ["dark", "light"] as const) {
  for (const mode of modes) {
    test(`v2 control inventory · ${theme} · ${mode.name}`, async ({ context, page }) => {
      await context.addCookies([
        {
          name: "aiqsa.theme",
          value: theme,
          url: "http://127.0.0.1:3000"
        }
      ]);
      await page.setViewportSize({ height: mode.height, width: mode.width });
      await page.goto("/ui-v2-fixture");

      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByTestId("ui-v2-control-gallery")).toBeVisible();
      await expect(page).toHaveScreenshot(
        `controls-${theme}-${mode.name}.png`,
        {
          animations: "disabled",
          caret: "hide",
          fullPage: true
        }
      );
    });
  }

  for (const state of ["default", "loading", "empty", "error", "search"] as const) {
    test(`v2 navigation · ${theme} · ${state}`, async ({ context, page }) => {
      await context.addCookies([{
        name: "aiqsa.theme",
        value: theme,
        url: "http://127.0.0.1:3000"
      }]);
      await page.setViewportSize({ height: 900, width: 1440 });
      await page.goto(`/ui-v2-fixture?fixture=navigation&state=${state}`);

      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByTestId("ui-v2-navigation-gallery")).toBeVisible();
      await expect(page).toHaveScreenshot(`navigation-${state}-${theme}-desktop.png`, {
        animations: "disabled",
        caret: "hide",
        fullPage: true
      });
    });
  }

  test(`v2 navigation mobile drawer · ${theme}`, async ({ context, page }) => {
    await context.addCookies([{
      name: "aiqsa.theme",
      value: theme,
      url: "http://127.0.0.1:3000"
    }]);
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto("/ui-v2-fixture?fixture=navigation");
    await page.getByRole("button", { name: "Open sidebar" }).click();

    await expect(page.getByRole("complementary", { name: "Chat navigation" }))
      .toBeVisible();
    await expect(page).toHaveScreenshot(`navigation-drawer-${theme}-mobile.png`, {
      animations: "disabled",
      caret: "hide",
      fullPage: true
    });
  });

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
    await expect(page.getByRole("button", {
      exact: true,
      name: "Quarterly product brief"
    })).toBeVisible();

    await page.getByRole("button", { name: "Close sidebar" }).click();
    await expect(page.getByRole("button", { name: "Open sidebar" })).toBeFocused();
    await page.getByRole("button", { name: "Open sidebar" }).click();
    await expect(page.getByRole("complementary", { name: "Chat navigation" }))
      .toBeVisible();
  });

  for (const mode of modes) {
    for (const state of ["empty", "basic", "unavailable", "earlier", "containment"] as const) {
      test(`v2 conversation · ${theme} · ${mode.name} · ${state}`, async ({ context, page }) => {
        await context.addCookies([{
          name: "aiqsa.theme",
          value: theme,
          url: "http://127.0.0.1:3000"
        }]);
        await page.setViewportSize({ height: mode.height, width: mode.width });
        await page.goto(`/ui-v2-fixture?fixture=conversation&state=${state}`);

        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.getByTestId("ui-v2-conversation-gallery")).toBeVisible();
        await expect(page).toHaveScreenshot(
          `conversation-${state}-${theme}-${mode.name}.png`,
          {
            animations: "disabled",
            caret: "hide",
            fullPage: true
          }
        );
      });
    }
  }

  for (const state of ["loading", "error"] as const) {
    test(`v2 conversation state · ${theme} · ${state}`, async ({ context, page }) => {
      await context.addCookies([{
        name: "aiqsa.theme",
        value: theme,
        url: "http://127.0.0.1:3000"
      }]);
      await page.setViewportSize({ height: 900, width: 1440 });
      await page.goto(`/ui-v2-fixture?fixture=conversation&state=${state}`);

      await expect(page.getByTestId("ui-v2-conversation-gallery")).toBeVisible();
      await expect(page).toHaveScreenshot(`conversation-${state}-${theme}-desktop.png`, {
        animations: "disabled",
        caret: "hide",
        fullPage: true
      });
    });
  }

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

  for (const mode of modes) {
    test(`v2 run lifecycle · ${theme} · ${mode.name}`, async ({ context, page }) => {
      await context.addCookies([{
        name: "aiqsa.theme",
        value: theme,
        url: "http://127.0.0.1:3000"
      }]);
      await page.setViewportSize({ height: mode.height, width: mode.width });
      await page.goto("/ui-v2-fixture?fixture=run-lifecycle");

      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByTestId("ui-v2-run-lifecycle-gallery")).toBeVisible();
      await expect(page.getByRole("region", { name: "Queued" }).first()).toBeVisible();
      await expect(page.getByText("Request not completed", { exact: true })).toBeVisible();
      await expect(page).toHaveScreenshot(
        `run-lifecycle-${theme}-${mode.name}.png`,
        {
          animations: "disabled",
          caret: "hide",
          fullPage: true
        }
      );
    });
  }

  for (const state of [
    "default",
    "attachments",
    "capabilities",
    "model",
    "assistant",
    "zero",
    "error"
  ] as const) {
    test(`v2 composer · ${theme} · desktop · ${state}`, async ({ context, page }) => {
      await context.addCookies([{
        name: "aiqsa.theme",
        value: theme,
        url: "http://127.0.0.1:3000"
      }]);
      await page.setViewportSize({ height: 900, width: 1440 });
      await page.goto(`/ui-v2-fixture?fixture=composer&state=${state}`);

      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByTestId("ui-v2-composer-gallery")).toBeVisible();
      await expect(page).toHaveScreenshot(`composer-${state}-${theme}-desktop.png`, {
        animations: "disabled",
        caret: "hide",
        fullPage: true
      });
    });
  }

  for (const state of ["default", "attachments", "capabilities", "model"] as const) {
    test(`v2 composer · ${theme} · mobile · ${state}`, async ({ context, page }) => {
      await context.addCookies([{
        name: "aiqsa.theme",
        value: theme,
        url: "http://127.0.0.1:3000"
      }]);
      await page.setViewportSize({ height: 844, width: 390 });
      await page.goto(`/ui-v2-fixture?fixture=composer&state=${state}`);

      await expect(page.getByTestId("ui-v2-composer-gallery")).toBeVisible();
      await expect(page).toHaveScreenshot(`composer-${state}-${theme}-mobile.png`, {
        animations: "disabled",
        caret: "hide",
        fullPage: true
      });
    });
  }

  test(`v2 composer short-height sheet · ${theme}`, async ({ context, page }) => {
    await context.addCookies([{
      name: "aiqsa.theme",
      value: theme,
      url: "http://127.0.0.1:3000"
    }]);
    await page.setViewportSize({ height: 500, width: 1100 });
    await page.goto("/ui-v2-fixture?fixture=composer&state=capabilities");

    const sheet = page.getByRole("menu", { name: "Capabilities" });
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
    await expect(page).toHaveScreenshot(`composer-capabilities-${theme}-short.png`, {
      animations: "disabled",
      caret: "hide"
    });
  });

  for (const mode of modes) {
    for (const state of ["approval", "complete", "empty", "partial"] as const) {
      test(`v2 evidence · ${theme} · ${mode.name} · ${state}`, async ({ context, page }) => {
        await context.addCookies([{
          name: "aiqsa.theme",
          value: theme,
          url: "http://127.0.0.1:3000"
        }]);
        await page.setViewportSize({ height: mode.height, width: mode.width });
        await page.goto(`/ui-v2-fixture?fixture=evidence&state=${state}`);

        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.getByTestId("ui-v2-evidence-gallery")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
          .toBe(true);
        await expect(page).toHaveScreenshot(
          `evidence-${state}-${theme}-${mode.name}.png`,
          { animations: "disabled", caret: "hide", fullPage: true }
        );
      });
    }
  }
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
  await expect(announcer).toHaveText("Searching the web…");
  await page.getByRole("button", { exact: true, name: "Settled answer" }).click();
  await expect(announcer).toHaveText("");
});

test("v2 conversation preserves the visible anchor after loading earlier messages", async ({ page }) => {
  await page.setViewportSize({ height: 700, width: 1100 });
  await page.goto("/ui-v2-fixture?fixture=conversation&state=earlier");
  const scroller = page.getByTestId("conversation-scroll");
  const anchor = page.locator('[data-conversation-message-id="earlier-current-4"]');
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

  const plus = page.getByRole("button", { name: "Capabilities" });
  await plus.click();
  await expect(page.getByRole("menu", { name: "Capabilities" })).toBeVisible();
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

test("v2 evidence opens exact citations and never renders private tool identity", async ({ page }) => {
  await page.setViewportSize({ height: 900, width: 1280 });
  await page.goto("/ui-v2-fixture?fixture=evidence&state=complete");

  await expect(page.getByTestId("evidence-row")).toHaveText("Sources 3Tools 1Files 2Run details");
  await page.getByRole("button", { name: "Open source 1" }).click();
  await expect(page.getByRole("button", { name: "Search, Complete, 1 attempt" }))
    .toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-citation-index="1"]')).toBeFocused();

  await page.getByTestId("evidence-row").getByText("Tools 1", { exact: true }).click();
  await expect(page.getByTestId("tool-evidence").getByRole("button", { name: "Tools, 1 call" }))
    .toHaveAttribute("aria-expanded", "true");
  expect(await page.locator("body").innerText()).not.toContain("private-call-id-must-not-render");
  expect(await page.locator("body").innerText()).not.toContain("knowledge-base-private-id");
});

test("v2 evidence preserves empty and partial Search outcomes", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=evidence&state=empty");
  await expect(page.getByTestId("evidence-row")).toHaveText("Run details");
  await expect(page.getByRole("button", { name: "Search, No results, 1 attempt" })).toBeVisible();
  await page.getByRole("button", { name: "Search, No results, 1 attempt" }).click();
  await expect(page.getByText("No sources were returned by this attempt.")).toBeVisible();

  await page.goto("/ui-v2-fixture?fixture=evidence&state=partial");
  await expect(page.getByRole("button", { name: "Search, Partial, 2 attempts" })).toBeVisible();
  await page.getByRole("button", { name: "Sources 1" }).click();
  await expect(page.getByText("The archive endpoint timed out before returning a source."))
    .toBeVisible();
  await expect(page.getByTestId("unsafe-citation-title")).toBeVisible();
  expect(await page.getByTestId("unsafe-citation-title").evaluate((node) => node.closest("a")))
    .toBeNull();
});

test("v2 MCP approval uses explicit bounded controls", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=evidence&state=approval");
  const approval = page.getByRole("complementary", {
    name: "Approval required for Research vault lookup_document"
  });
  await expect(approval).toBeVisible();
  await approval.getByText("Review arguments").click();
  await expect(approval).toContainText("[private path redacted]");
  await approval.getByRole("button", { name: "Allow once" }).click();
  await expect(approval).toContainText("allowed");
  await expect(approval.getByRole("button", { name: "Allow once" })).toBeHidden();
});

for (const theme of ["dark", "light"] as const) {
  for (const mode of modes) {
    for (const state of ["default", "drawer", "edit", "streaming"] as const) {
      test(`v2 branches · ${theme} · ${mode.name} · ${state}`, async ({ context, page }) => {
        await context.addCookies([{
          name: "aiqsa.theme",
          value: theme,
          url: "http://127.0.0.1:3000"
        }]);
        await page.setViewportSize({ height: mode.height, width: mode.width });
        await page.goto(`/ui-v2-fixture?fixture=branches&state=${state}`);

        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.getByTestId("ui-v2-branches-gallery")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
          .toBe(true);
        await expect(page).toHaveScreenshot(
          `branches-${state}-${theme}-${mode.name}.png`,
          { animations: "disabled", caret: "hide", fullPage: true }
        );
      });
    }
  }
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
  await expect(menu.getByRole("menuitem").first()).toHaveText("Delete");
  await expect(menu.getByRole("menuitem").last()).toHaveText("Branch from here");
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(761);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(561);
  await page.keyboard.press("Escape");
  await expect(answer.getByRole("button", { name: "More answer actions" })).toBeFocused();
});

test("v2 branch edit keeps the draft and makes its immutable outcome explicit", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/ui-v2-fixture?fixture=branches&state=edit");

  await expect(page.getByTestId("edit-branch-strip-v2")).toContainText(
    "Sending creates a new branch; history stays unchanged."
  );
  const input = page.getByRole("textbox", { name: "Message" });
  await input.fill("Уточнённый вопрос остаётся в новой ветви");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("edit-branch-strip-v2")).toBeHidden();
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

for (const theme of ["dark", "light"] as const) {
  for (const mode of modes) {
    for (const state of [
      "cancelled",
      "default",
      "drawer",
      "failed",
      "generating",
      "preview-unavailable",
      "stack"
    ] as const) {
      test(`v2 artifacts · ${theme} · ${mode.name} · ${state}`, async ({ context, page }) => {
        await context.addCookies([{
          name: "aiqsa.theme",
          value: theme,
          url: "http://127.0.0.1:3000"
        }]);
        await page.setViewportSize({ height: mode.height, width: mode.width });
        await page.goto(`/ui-v2-fixture?fixture=artifacts&state=${state}`);

        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.getByTestId("ui-v2-artifacts-gallery")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
          .toBe(true);
        await expect(page).toHaveScreenshot(
          `artifacts-${state}-${theme}-${mode.name}.png`,
          { animations: "disabled", caret: "hide", fullPage: true }
        );
      });
    }
  }
}

test("v2 artifact preview switches exact immutable versions and restores focus", async ({ page }) => {
  await page.setViewportSize({ height: 760, width: 1180 });
  await page.goto("/ui-v2-fixture?fixture=artifacts&state=default");

  await expect(page.getByRole("dialog", { name: /File preview/ })).toBeHidden();
  const card = page.getByRole("article", { name: "File report_q3.xlsx" });
  await expect(card).toContainText("v2");
  const opener = card.getByRole("button", { name: "Preview" });
  await opener.click();
  const drawer = page.getByRole("dialog", { name: "File preview: report_q3.xlsx" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Close preview" })).toBeFocused();
  const text = await drawer.innerText();
  expect(text).not.toContain("artifact-version-private");
  expect(text).not.toContain("message-private");
  expect(text).not.toContain("object-key");

  await drawer.getByRole("button", { name: /v1.*Original answer/ }).click();
  await expect(drawer.getByText("₽14.8M")).toBeVisible();
  await drawer.getByRole("tab", { name: "Продажи" }).click();
  await expect(drawer.getByText("₽8.9M")).toBeVisible();
  const download = drawer.getByRole("button", { name: "Download" });
  await expect(download).not.toHaveAttribute("href");
  await download.click();
  await expect(page.locator(".v2-artifact-gallery-notice")).toContainText(
    "Download not performed: original · fixture-only"
  );

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(card).toContainText("v2");
});

test("v2 artifacts keep preview failure, validation failure, and lifecycle outcomes honest", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=artifacts&state=preview-unavailable");
  const ready = page.getByRole("article", { name: "File legacy.xlsx" });
  await expect(ready).toContainText("Preview unavailable");
  await expect(ready.getByRole("button", { name: "Preview" })).toBeHidden();
  await ready.getByRole("button", { name: "Download" }).click();
  await expect(page.locator(".v2-artifact-gallery-notice")).toContainText(
    "Download not performed"
  );

  await page.goto("/ui-v2-fixture?fixture=artifacts&state=failed");
  await expect(page.locator(".v2-artifact-failure")).toContainText(
    "broken reference to sheet “Сводная”"
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.locator(".v2-artifact-gallery-notice")).toContainText(
    "compute backend is not connected"
  );

  await page.goto("/ui-v2-fixture?fixture=artifacts&state=generating");
  const generating = page.getByRole("article", { name: "Generating file report_q3.xlsx" });
  await expect(generating).toHaveAttribute("aria-busy", "true");
  await expect(generating).toContainText("Creating fileValidating fileRendering preview");
  expect(await page.locator("body").innerText()).not.toContain("artifact-private-generating");
});

test("v2 artifacts render multiple outputs in stable order without fabricating product support", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=artifacts&state=stack");
  const cards = page.getByTestId("artifact-stack-v2").getByRole("article");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toContainText("report_q3.xlsx");
  await expect(cards.nth(1)).toContainText("deck_q3.pptx");
  await expect(page.getByText(
    "Fixture-only preview · the generated-files backend is not available in the product."
  )).toBeVisible();
});

const runDetailsStates = [
  "closed",
  "complete",
  "empty",
  "error",
  "loading",
  "memory",
  "redacted"
] as const;

async function prepareRunDetailsVisual(page: import("@playwright/test").Page, state: typeof runDetailsStates[number]) {
  if (state === "closed") {
    await expect(page.getByRole("dialog", { name: /Run details/ })).toBeHidden();
    return;
  }
  const drawer = page.getByRole("dialog", { name: /Run details/ });
  await expect(drawer).toBeVisible();
  if (state === "loading") {
    await expect(drawer.getByRole("status")).toContainText("Loading this answer’s receipt");
    return;
  }
  if (state === "error") {
    await expect(drawer.getByRole("alert")).toContainText("Run details unavailable");
    return;
  }
  if (state === "memory") {
    const memory = drawer.getByRole("region", { name: "Memory" });
    await memory.scrollIntoViewIfNeeded();
    await memory.getByText(/2\. Previous-chat excerpt/).click();
    return;
  }
  if (state === "redacted") {
    const tools = drawer.getByRole("region", { name: "MCP tools" });
    await tools.scrollIntoViewIfNeeded();
    await tools.getByText(/office-compute · create_workbook/).click();
    await tools.getByText("Arguments · redacted").click();
  }
}

for (const theme of ["dark", "light"] as const) {
  for (const mode of modes) {
    for (const state of runDetailsStates) {
      test(`v2 run details · ${theme} · ${mode.name} · ${state}`, async ({ context, page }) => {
        await context.addCookies([{
          name: "aiqsa.theme",
          value: theme,
          url: "http://127.0.0.1:3000"
        }]);
        await page.setViewportSize({ height: mode.height, width: mode.width });
        await page.goto(`/ui-v2-fixture?fixture=run-details&state=${state}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.getByTestId("ui-v2-run-details-gallery")).toBeVisible();
        await prepareRunDetailsVisual(page, state);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
          .toBe(true);
        await expect(page).toHaveScreenshot(
          `run-details-${state}-${theme}-${mode.name}.png`,
          { animations: "disabled", caret: "hide", fullPage: true }
        );
      });
    }
  }
}

test("v2 Run details opens only for the exact answer and restores its evidence-row opener", async ({ page }) => {
  await page.setViewportSize({ height: 760, width: 1180 });
  await page.goto("/ui-v2-fixture?fixture=run-details&state=closed");
  await expect(page.getByRole("dialog", { name: /Run details/ })).toBeHidden();
  const opener = page.getByRole("button", { name: "Run details, usage available" });
  await opener.click();
  const drawer = page.getByRole("dialog", {
    name: "Run details · Answer “Квартальный отчёт”"
  });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Close run details" })).toBeFocused();
  await expect(drawer).toContainText("OpenAI · рабочий ключ");
  await expect(drawer).toContainText("GPT-5.2");
  await expect(drawer).toContainText("Usage · provider evidence");
  await expect(drawer).not.toContainText("$0.0091");
  const visible = await drawer.innerText();
  expect(visible).not.toMatch(
    /assistant-message-private|run-private|fact-private|version-private|tool-call-private|knowledge-base-private|search-option-private/u
  );

  const tools = drawer.getByRole("region", { name: "MCP tools" });
  await tools.getByText(/office-compute · create_workbook/).click();
  await tools.getByText("Arguments · redacted").click();
  await expect(tools.getByRole("region", { name: "Redacted tool arguments" }))
    .toContainText("‹redacted›");
  await tools.getByText("Result · untrusted data").click();
  await expect(tools.getByRole("region", { name: "Untrusted tool result preview" }))
    .toContainText("‹redacted›");
  expect(await tools.innerText()).not.toMatch(/sk-private|private-bearer/u);

  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
});

test("v2 Run details keeps loading and owner-private read failure honest", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=run-details&state=loading");
  let drawer = page.getByRole("dialog", { name: /Run details/ });
  await expect(drawer.getByRole("status")).toContainText("Loading this answer’s receipt");
  await expect(drawer).not.toContainText("Complete");

  await page.goto("/ui-v2-fixture?fixture=run-details&state=error");
  drawer = page.getByRole("dialog", { name: /Run details/ });
  await expect(drawer.getByRole("alert")).toContainText("Run details unavailable");
  await drawer.getByRole("button", { name: "Retry" }).click();
  await expect(drawer.getByRole("alert")).toContainText("Run details unavailable");
  await expect(drawer).not.toContainText("OpenAI · рабочий ключ");
});

test("v2 Run details preserves frozen Memory evidence and removes stale source links", async ({ page }) => {
  await page.goto("/ui-v2-fixture?fixture=run-details&state=memory");
  const drawer = page.getByRole("dialog", { name: /Run details/ });
  const memory = drawer.getByRole("region", { name: "Memory" });
  await expect(memory).toContainText("Used with safe degradation");
  await expect(memory).toContainText("Updated");

  const deleted = memory.locator("details").filter({ hasText: "2. Previous-chat excerpt" }).first();
  await deleted.getByText(/2\. Previous-chat excerpt/).click();
  await expect(deleted.getByTestId("run-memory-frozen-text")).toContainText(
    "удалённом исходном чате"
  );
  await expect(deleted).toContainText("Link hidden: the source chat was deleted");
  await expect(deleted.getByRole("button", { name: /Open source/ })).toBeHidden();

  const live = memory.locator("details").filter({ hasText: "3. Previous-chat excerpt" }).first();
  await live.getByText(/3\. Previous-chat excerpt/).click();
  const source = live.getByRole("button", { name: "Open source · 2" });
  await expect(source).toBeVisible();
  expect(await source.innerText()).not.toContain("source-chat-private-live");
  expect(await memory.innerText()).not.toMatch(/source-chat-private|source-message-private/u);
});

test("v2 Run details redacts long provider and request previews without widening mobile", async ({ page }) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/ui-v2-fixture?fixture=run-details&state=redacted");
  const drawer = page.getByRole("dialog", { name: /Run details/ });
  await expect(drawer).toHaveCSS("width", "390px");
  const text = await drawer.innerText();
  expect(text).toContain("password=‹redacted›");
  expect(text).not.toMatch(/private-password|private-error-token|private-event-token/u);
  await expect(drawer.getByRole("region", { name: "Redacted request preview" }))
    .toContainText("‹redacted›");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});
