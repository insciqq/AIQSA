import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: false,
  galleryModuleLoads: 0,
  notFound: vi.fn((): never => {
    throw new Error("NEXT_NOT_FOUND");
  })
}));

vi.mock("@/lib/server/auth/config", () => ({
  isTestAuthEnabled: () => mocks.enabled
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound
}));

vi.mock("./_fixtures/NavigationV2Gallery", () => {
  mocks.galleryModuleLoads += 1;
  return {
    NavigationV2Gallery: () => <p>Navigation fixture loaded</p>
  };
});

import UiV2FixturePage from "./page";

describe("UI fixture route gate", () => {
  beforeEach(() => {
    mocks.enabled = false;
    mocks.notFound.mockClear();
  });

  afterEach(cleanup);

  it("returns not found before loading a gallery outside test auth", async () => {
    await expect(UiV2FixturePage({
      searchParams: Promise.resolve({ fixture: "navigation" })
    })).rejects.toThrow("NEXT_NOT_FOUND");

    expect(mocks.notFound).toHaveBeenCalledOnce();
    expect(mocks.galleryModuleLoads).toBe(0);
  });

  it("loads only the requested gallery after test auth admission", async () => {
    mocks.enabled = true;
    render(await UiV2FixturePage({
      searchParams: Promise.resolve({ fixture: "navigation" })
    }));

    expect(screen.getByText("Navigation fixture loaded")).toBeVisible();
    expect(mocks.galleryModuleLoads).toBe(1);
  });
});
