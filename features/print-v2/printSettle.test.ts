import { afterEach, describe, expect, it } from "vitest";
import { pendingPrintWork, waitForPrintSettle } from "./printSettle";

function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    async wait(milliseconds: number) {
      time += milliseconds;
    }
  };
}

function image(complete: boolean): HTMLImageElement {
  const element = document.createElement("img");
  Object.defineProperty(element, "complete", { configurable: true, get: () => complete });
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("print settle detection", () => {
  it("counts pending code, math and diagrams plus images that neither loaded nor failed", () => {
    document.body.innerHTML = `
      <div data-render-pending></div>
      <span data-render-pending></span>
      <div data-mermaid-state="pending"></div>
      <div data-mermaid-state="rendered"></div>
      <div data-mermaid-state="failed"></div>`;
    document.body.append(image(false), image(true));
    expect(pendingPrintWork(document.body)).toBe(4);
  });

  it("settles after two quiet checks once diagrams render and fonts load", async () => {
    const clock = fakeClock();
    const root = document.createElement("div");
    const pending = document.createElement("div");
    pending.setAttribute("data-mermaid-state", "pending");
    root.append(pending);
    let fontsLoading = true;
    let polls = 0;
    const wait = async (milliseconds: number) => {
      polls += 1;
      if (polls === 3) pending.setAttribute("data-mermaid-state", "rendered");
      if (polls === 5) fontsLoading = false;
      await clock.wait(milliseconds);
    };
    const outcome = await waitForPrintSettle({ fontsLoading: () => fontsLoading, now: clock.now, pollMs: 100, root, wait });
    expect(outcome).toBe("settled");
    // Fonts load during the fifth wait; the sixth check confirms the quiet state.
    expect(clock.now()).toBe(600);
  });

  it("restarts the quiet count when new work appears between checks", async () => {
    const clock = fakeClock();
    const root = document.createElement("div");
    const late = document.createElement("div");
    let polls = 0;
    const wait = async (milliseconds: number) => {
      polls += 1;
      // A finished step starts another rendering right after the first quiet check.
      if (polls === 1) {
        late.setAttribute("data-render-pending", "");
        root.append(late);
      }
      if (polls === 3) late.removeAttribute("data-render-pending");
      await clock.wait(milliseconds);
    };
    expect(await waitForPrintSettle({ now: clock.now, pollMs: 100, root, wait })).toBe("settled");
    expect(clock.now()).toBe(400);
  });

  it("gives up at the cap so a stuck renderer or font never blocks printing", async () => {
    const clock = fakeClock();
    const root = document.createElement("div");
    root.append(image(false));
    expect(await waitForPrintSettle({ now: clock.now, root, timeoutMs: 1_000, wait: clock.wait })).toBe("timeout");
    expect(clock.now()).toBe(1_000);
    const fonts = fakeClock();
    expect(await waitForPrintSettle({
      fontsLoading: () => true, now: fonts.now, root: document.createElement("div"), timeoutMs: 500, wait: fonts.wait
    })).toBe("timeout");
  });

  it("stops without an outcome once aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await waitForPrintSettle({ root: document.createElement("div"), signal: controller.signal })).toBe("aborted");
  });
});
