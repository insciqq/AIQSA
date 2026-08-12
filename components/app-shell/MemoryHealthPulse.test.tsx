import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryHealthFixture } from "./memoryTestFixtures";
import { MemoryHealthPulse } from "./MemoryHealthPulse";

afterEach(cleanup);

describe("MemoryHealthPulse", () => {
  it("shows a quiet default summary and keeps operational evidence collapsed", () => {
    render(
      <MemoryHealthPulse
        advancedContent={<p>Technical capability evidence</p>}
        error={false}
        health={memoryHealthFixture()}
        loading={false}
        locale="EN"
        onOpenOperations={vi.fn()}
        onRetry={vi.fn()}
      />
    );

    expect(screen.getByRole("heading", { name: "Memory is up to date" })).toBeVisible();
    expect(screen.getByText("Technical capability evidence")).not.toBeVisible();
    fireEvent.click(screen.getByText("Advanced", { exact: true }));
    expect(screen.getByText("Technical capability evidence")).toBeVisible();
  });

  it("keeps English presentation when a retained RU locale is supplied", () => {
    const onOpenOperations = vi.fn();
    render(
      <MemoryHealthPulse
        error={false}
        health={memoryHealthFixture({
          action: "OPEN_MEMORY_OPERATIONS",
          deletion: {
            activeCount: 2,
            retrievalFenced: true,
            state: "BLOCKED_REQUIRES_ADMIN"
          },
          state: "BLOCKED_REQUIRES_ADMIN",
          temporary: { overdueCount: 1, state: "OVERDUE" }
        })}
        loading={false}
        locale="RU"
        onOpenOperations={onOpenOperations}
        onRetry={vi.fn()}
      />
    );

    const pulse = screen.getByTestId("memory-health-pulse");
    expect(within(pulse).getByRole("heading", {
      name: "Memory cleanup needs administrator attention"
    })).toBeVisible();
    expect(within(pulse).getByText(/remains fenced from reuse/u)).toBeVisible();
    expect(within(pulse).getByText(/past its retention deadline/u)).toBeVisible();
    fireEvent.click(within(pulse).getByRole("button", { name: "Open Memory operations" }));
    expect(onOpenOperations).toHaveBeenCalledOnce();
  });

  it("offers a retry without hiding settings when status is unavailable", () => {
    const onRetry = vi.fn();
    render(
      <MemoryHealthPulse
        error
        health={null}
        loading={false}
        locale="EN"
        onOpenOperations={vi.fn()}
        onRetry={onRetry}
      />
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Memory status is unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
