import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryProfileSummary } from "./MemoryProfileSummary";
import {
  resetMemoryManagerStoreForTest,
  useMemoryManagerStore
} from "./memoryManagerStore";
import { memoryProfileFixture } from "./memoryTestFixtures";
import type {
  MemoryProfileContributor,
  MemoryProfileViewState
} from "@/lib/contracts/memory";

const contributors: MemoryProfileContributor[] = [{
  displayText: "I prefer concise answers in Russian.",
  factId: "memory-fact-1",
  factVersionId: "memory-version-1",
  ordinal: 0,
  pinned: true,
  sourceMode: "EXPLICIT",
  temperatureClass: "HOT"
}, {
  displayText: "I am building a self-hosted AI workspace.",
  factId: "memory-fact-2",
  factVersionId: "memory-version-2",
  ordinal: 1,
  pinned: false,
  sourceMode: "AUTOMATIC",
  temperatureClass: "COLD"
}];

function readyProfile(accountId = "account-1") {
  useMemoryManagerStore.setState({
    profileAccountId: accountId,
    profileError: null,
    profileLoadState: "ready",
    profileResponse: memoryProfileFixture({ profile: { contributors } })
  });
}

describe("MemoryProfileSummary", () => {
  beforeEach(() => {
    resetMemoryManagerStoreForTest();
  });

  afterEach(() => {
    cleanup();
    resetMemoryManagerStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps provenance out of the default summary and reveals exact advanced actions", async () => {
    readyProfile();
    const onDelete = vi.fn(async () => undefined);
    const onEdit = vi.fn(async () => undefined);
    const onOpenDetails = vi.fn(async () => undefined);
    render(
      <MemoryProfileSummary
        accountId="account-1"
        locale="EN"
        mutationBusy={false}
        onDelete={onDelete}
        onEdit={onEdit}
        onOpenDetails={onOpenDetails}
      />
    );

    expect(screen.getByRole("heading", { name: "What AIQSA remembers about you" }))
      .toBeVisible();
    expect(screen.getByText(contributors[0]!.displayText)).toBeVisible();
    expect(screen.getByText(contributors[1]!.displayText)).toBeVisible();
    expect(screen.queryByText(/Saved by you/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Use priority/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sources and history/u }))
      .not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", {
      name: `Edit: ${contributors[0]!.displayText}`
    }));
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith("memory-fact-1"));

    fireEvent.click(screen.getByRole("button", {
      name: `Delete: ${contributors[1]!.displayText}`
    }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(contributors[1]));

    const advanced = screen.getByRole("button", { name: "Advanced view" });
    fireEvent.click(advanced);
    expect(advanced).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/Source: Saved by you/u)).toBeVisible();
    expect(screen.getByText(/Use priority: Often useful/u)).toBeVisible();
    expect(screen.getByText("Pinned")).toBeVisible();
    expect(screen.getByText(/Source: Learned from chats/u)).toBeVisible();

    fireEvent.click(screen.getByRole("button", {
      name: `Sources and history: ${contributors[1]!.displayText}`
    }));
    await waitFor(() => expect(onOpenDetails).toHaveBeenCalledWith("memory-fact-2"));
  });

  it("uses complete Russian copy and returns to the private default view on account change", async () => {
    readyProfile();
    const props = {
      locale: "RU" as const,
      mutationBusy: false,
      onDelete: vi.fn(async () => undefined),
      onEdit: vi.fn(async () => undefined),
      onOpenDetails: vi.fn(async () => undefined)
    };
    const { rerender } = render(
      <MemoryProfileSummary accountId="account-1" {...props} />
    );

    const advanced = screen.getByRole("button", { name: "Расширенный режим" });
    fireEvent.click(advanced);
    expect(screen.getByText(/Источник: Сохранено вами/u)).toBeVisible();

    rerender(<MemoryProfileSummary accountId="account-2" {...props} />);
    await waitFor(() => expect(screen.getByRole("button", {
      name: "Расширенный режим"
    })).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByText(/Источник: Сохранено вами/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: `Удалить: ${contributors[0]!.displayText}`
    })).toBeVisible();
  });

  it("keeps every no-summary gate honest without exposing advanced metadata", async () => {
    useMemoryManagerStore.setState({
      profileAccountId: "account-1",
      profileError: null,
      profileLoadState: "ready",
      profileResponse: memoryProfileFixture({ profile: null, state: "DISABLED" })
    });
    render(
      <MemoryProfileSummary
        accountId="account-1"
        locale="EN"
        mutationBusy={false}
        onDelete={vi.fn(async () => undefined)}
        onEdit={vi.fn(async () => undefined)}
        onOpenDetails={vi.fn(async () => undefined)}
      />
    );
    const states: Array<Readonly<{
      message: RegExp;
      state: Exclude<MemoryProfileViewState, "READY">;
    }>> = [{
      message: /Memory is off/u,
      state: "DISABLED"
    }, {
      message: /No summary yet/u,
      state: "EMPTY"
    }, {
      message: /Updating your memory summary/u,
      state: "PENDING"
    }, {
      message: /configured memory model is available/u,
      state: "WAITING_FOR_EGRESS_CONSENT"
    }, {
      message: /not available right now/u,
      state: "UNAVAILABLE"
    }];

    for (const { message, state } of states) {
      useMemoryManagerStore.setState({
        profileLoadState: "ready",
        profileResponse: memoryProfileFixture({ profile: null, state })
      });
      expect(await screen.findByText(message)).toBeVisible();
      expect(screen.queryByRole("button", { name: "Advanced view" })).not.toBeInTheDocument();
    }
  });

  it("keeps profile failure distinct from empty and retries the strict private route", async () => {
    useMemoryManagerStore.setState({
      profileAccountId: "account-1",
      profileError: "memory_action_failed",
      profileLoadState: "error",
      profileResponse: null
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(
      memoryProfileFixture({ profile: { contributors } })
    ), {
      headers: { "content-type": "application/json" },
      status: 200
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryProfileSummary
        accountId="account-1"
        locale="EN"
        mutationBusy={false}
        onDelete={vi.fn(async () => undefined)}
        onEdit={vi.fn(async () => undefined)}
        onOpenDetails={vi.fn(async () => undefined)}
      />
    );

    expect(screen.getByText(/could not be loaded/u)).toBeVisible();
    expect(screen.queryByText(/No summary yet/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(contributors[0]!.displayText)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/me/memory/profile",
      expect.objectContaining({ method: "GET" })
    );
  });
});
