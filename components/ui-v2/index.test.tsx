import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  UiV2Button,
  UiV2Chip,
  UiV2IconButton,
  UiV2IconSprite,
  UiV2MenuItem,
  UiV2Toast
} from ".";

describe("UI v2 primitives", () => {
  it("keeps busy and disabled button labels readable", () => {
    render(
      <>
        <UiV2Button busy>Checking connection</UiV2Button>
        <UiV2Button disabled tone="primary">Send</UiV2Button>
      </>
    );

    expect(screen.getByRole("button", { name: "Checking connection" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Checking connection" })).toHaveAttribute(
      "aria-busy",
      "true"
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("keeps icon-only controls explicitly named", () => {
    render(
      <>
        <UiV2IconSprite />
        <UiV2IconButton icon="plus" label="Add capability" />
      </>
    );

    expect(screen.getByRole("button", { name: "Add capability" })).toHaveAttribute(
      "title",
      "Add capability"
    );
  });

  it("keeps icon controls non-submitting by default while allowing explicit submit", () => {
    const onSubmit = vi.fn((event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
    });
    render(
      <form onSubmit={onSubmit}>
        <UiV2IconButton icon="close" label="Cancel" />
        <UiV2IconButton icon="check" label="Save" type="submit" />
      </form>
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("projects selected and disabled menu facts separately", () => {
    render(
      <>
        <UiV2MenuItem selected>Current model</UiV2MenuItem>
        <UiV2MenuItem disabled sub="Not available to this account">
          Hidden model
        </UiV2MenuItem>
      </>
    );

    expect(screen.getByRole("menuitem", { name: "Current model" })).toHaveAttribute(
      "aria-current",
      "true"
    );
    expect(
      screen.getByRole("menuitem", {
        name: "Hidden modelNot available to this account"
      })
    ).toBeDisabled();
  });

  it("keeps status tone and toast action semantic", () => {
    const onAction = vi.fn();
    render(
      <>
        <UiV2Chip tone="warn">Preview unavailable</UiV2Chip>
        <UiV2Toast action="Undo" onAction={onAction}>
          Chat moved to archive
        </UiV2Toast>
      </>
    );

    expect(screen.getByText("Preview unavailable")).toHaveAttribute("data-tone", "warn");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onAction).toHaveBeenCalledOnce();
  });
});
