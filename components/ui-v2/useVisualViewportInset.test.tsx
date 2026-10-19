import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVisualViewportInset, visualViewportInset } from "./useVisualViewportInset";

class FakeVisualViewport extends EventTarget {
  height: number;
  offsetTop = 0;
  constructor(height: number) {
    super();
    this.height = height;
  }
}

function install(height: number) {
  const viewport = new FakeVisualViewport(height);
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", 844);
  return viewport;
}

function Probe() {
  return <p data-testid="inset">{useVisualViewportInset()}</p>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useVisualViewportInset", () => {
  it("is 0 without a visual viewport or while it fills the window", () => {
    vi.stubGlobal("visualViewport", undefined);
    expect(visualViewportInset()).toBe(0);
    install(844);
    expect(visualViewportInset()).toBe(0);
  });

  it("follows an overlaid keyboard and its scroll, and ignores sub-pixel jitter", () => {
    const viewport = install(844);
    render(<Probe />);
    expect(screen.getByTestId("inset")).toHaveTextContent("0");

    act(() => {
      viewport.height = 508;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByTestId("inset")).toHaveTextContent("336");

    act(() => {
      viewport.offsetTop = 120;
      viewport.dispatchEvent(new Event("scroll"));
    });
    expect(screen.getByTestId("inset")).toHaveTextContent("216");

    act(() => {
      viewport.height = 843.5;
      viewport.offsetTop = 0;
      window.dispatchEvent(new Event("orientationchange"));
    });
    expect(screen.getByTestId("inset")).toHaveTextContent("0");
  });
});
