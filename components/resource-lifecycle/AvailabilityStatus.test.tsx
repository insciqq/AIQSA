import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  AvailabilityStatus,
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
      "border-positive/25",
      "bg-positive/10",
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
    expect(enableActionTone).toContain("bg-proof/[0.08]");
    expect(enableActionTone).toContain("text-proof");
  });
});
