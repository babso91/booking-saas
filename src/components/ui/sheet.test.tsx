// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { Sheet } from "./sheet";

function Harness({ nested = false }: { nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <div data-testid="page">
      <button type="button" onClick={() => setOpen(true)}>
        Ouvrir
      </button>
      <button type="button">Arrière-plan</button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Panneau">
        <button type="button">Premier</button>
        <input aria-label="Champ" />
        {nested ? (
          <button type="button" onClick={() => setConfirm(true)}>
            Confirmer
          </button>
        ) : null}
        <Sheet
          open={confirm}
          onClose={() => setConfirm(false)}
          title="Confirmation"
          placement="center"
        >
          <button type="button">Oui</button>
        </Sheet>
      </Sheet>
    </div>
  );
}

describe("Sheet (modal dialog)", () => {
  it("wraps focus both ways, including Shift+Tab from the panel itself", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Ouvrir" }));

    const dialog = screen.getByRole("dialog", { name: "Panneau" });
    expect(document.activeElement).toBe(dialog); // initial focus on the panel

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Champ" }),
    ); // last focusable

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Fermer" }),
    ); // wrapped to first

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Champ" }),
    );
  });

  it("makes the background inert while open and restores it", async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const page = container; // the app root, a direct child of <body>
    await user.click(screen.getByRole("button", { name: "Ouvrir" }));
    expect(page.hasAttribute("inert")).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(page.hasAttribute("inert")).toBe(false);
  });

  it("closes with Escape and gives focus back to the opener", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Ouvrir" });
    await user.click(opener);
    await user.keyboard("{Escape}");
    expect(document.activeElement).toBe(opener);
  });

  it("stacks: a confirmation over a panel owns Escape and the focus", async () => {
    const user = userEvent.setup();
    render(<Harness nested />);
    await user.click(screen.getByRole("button", { name: "Ouvrir" }));
    const panel = screen.getByRole("dialog", { name: "Panneau" });
    await user.click(screen.getByRole("button", { name: "Confirmer" }));

    const confirm = screen.getByRole("dialog", { name: "Confirmation" });
    expect(panel.closest("[class*='fixed']")!.hasAttribute("inert")).toBe(true);
    await user.tab();
    expect(confirm.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Confirmation" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Panneau" })).toBeTruthy();
    expect(panel.closest("[class*='fixed']")!.hasAttribute("inert")).toBe(
      false,
    );
  });
});
