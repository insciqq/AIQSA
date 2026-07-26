import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AvailabilityStatus,
  availabilityRowClass,
  availabilityStatusClass,
  enableActionTone
} from "./AvailabilityStatus";

describe("AvailabilityStatus", () => {
  it("keeps enabled positive and disabled strongly neutral", () => {
    render(
      <div>
        <AvailabilityStatus enabled />
        <AvailabilityStatus enabled={false} />
      </div>
    );

    expect(screen.getByText("Enabled")).toHaveClass(
      "border-positive/35",
      "bg-positive/[0.12]",
      "text-positive"
    );
    expect(screen.getByText("Enabled")).toHaveAttribute("data-resource-availability", "enabled");
    expect(screen.getByText("Disabled")).toHaveClass(
      "border-trace-strong",
      "bg-control-surface",
      "text-ink"
    );
    expect(screen.getByText("Disabled")).toHaveAttribute("data-resource-availability", "disabled");
  });

  it("exports the same semantic status and restoration-action tones to every surface", () => {
    expect(availabilityStatusClass(false)).not.toContain("text-ink-muted");
    expect(availabilityStatusClass(false)).not.toContain("text-critical");
    expect(availabilityRowClass(true)).toContain("border-l-positive/55");
    expect(availabilityRowClass(false)).toContain("border-l-trace-strong");
    expect(availabilityRowClass(false)).not.toContain("critical");
    expect(enableActionTone).toContain("bg-proof/[0.08]");
    expect(enableActionTone).toContain("text-proof");
  });

  it("allows a domain-specific positive label without changing binary availability semantics", () => {
    render(<AvailabilityStatus enabled enabledLabel="Active" />);

    expect(screen.getByText("Active")).toHaveAttribute("data-resource-availability", "enabled");
    expect(screen.getByText("Active")).toHaveClass("text-positive");
  });
});
