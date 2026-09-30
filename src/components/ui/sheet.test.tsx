// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// A responsive rule like the forms' `[@media(max-height:520px)]:hidden`
// ("Retour" disappears on short screens), applied through a real stylesheet.
function CompactForm({
  hideBack = true,
  extraHidden = false,
  nestedConfirm = false,
}: {
  hideBack?: boolean;
  extraHidden?: boolean;
  nestedConfirm?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [back, setBack] = useState(!hideBack);
  const [confirm, setConfirm] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Ouvrir
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Formulaire"
        footer={
          <div>
            <button type="button" onClick={() => setBack((value) => !value)}>
              Enregistrer
            </button>
            {extraHidden ? (
              <>
                <button type="button" style={{ visibility: "hidden" }}>
                  Invisible
                </button>
                <button type="button" hidden>
                  Masqué
                </button>
                <fieldset disabled>
                  <button type="button">Désactivé</button>
                </fieldset>
                <div style={{ display: "none" }}>
                  <a href="/nulle-part">Sans boîte</a>
                </div>
                <span inert>
                  <button type="button">Inerte</button>
                </span>
              </>
            ) : null}
            {nestedConfirm ? (
              <button type="button" onClick={() => setConfirm(true)}>
                Supprimer
              </button>
            ) : null}
            <button
              type="button"
              className={back ? undefined : "compact-hidden"}
            >
              Retour
            </button>
          </div>
        }
      >
        <input aria-label="Motif" />
      </Sheet>
      <Sheet
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Supprimer ?"
        placement="center"
      >
        <button type="button">Oui, supprimer</button>
        <button type="button" className="compact-hidden">
          Annuler
        </button>
      </Sheet>
    </div>
  );
}

describe("Sheet focus trap — hidden controls are never an edge", () => {
  let style: HTMLStyleElement;
  beforeEach(() => {
    style = document.createElement("style");
    style.textContent = ".compact-hidden { display: none; }";
    document.head.append(style);
  });
  afterEach(() => {
    style.remove();
    delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility;
  });

  const focused = () => document.activeElement as HTMLElement;
  const named = (name: string) => screen.getByRole("button", { name });

  it("compact footer: Tab from the last visible control wraps, Shift+Tab skips the hidden Retour", async () => {
    const user = userEvent.setup();
    render(<CompactForm />);
    await user.click(named("Ouvrir"));

    await user.tab({ shift: true }); // from the panel itself
    expect(focused()).toBe(named("Enregistrer"));
    await user.tab();
    expect(focused()).toBe(named("Fermer")); // not lost on the hidden Retour
    await user.tab({ shift: true });
    expect(focused()).toBe(named("Enregistrer"));
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
      true,
    );
  });

  it("follows controls hidden or shown after opening", async () => {
    const user = userEvent.setup();
    render(<CompactForm />);
    await user.click(named("Ouvrir"));
    await user.click(named("Enregistrer")); // shows Retour
    await user.tab();
    expect(focused()).toBe(named("Retour"));
    await user.tab();
    expect(focused()).toBe(named("Fermer"));

    await user.tab({ shift: true });
    expect(focused()).toBe(named("Retour"));
    await user.click(named("Enregistrer")); // hides it again
    await user.tab();
    expect(focused()).toBe(named("Fermer"));
  });

  it("skips invisible, hidden, disabled, inert and box-less controls", async () => {
    const user = userEvent.setup();
    render(<CompactForm extraHidden />);
    await user.click(named("Ouvrir"));
    await user.tab({ shift: true });
    expect(focused()).toBe(named("Enregistrer"));
    await user.tab({ shift: true });
    expect(focused()).toBe(screen.getByRole("textbox", { name: "Motif" }));
  });

  it("uses checkVisibility when the browser has it (no layout box)", async () => {
    const checkVisibility = vi.fn(function (this: Element) {
      return !this.textContent?.includes("Retour");
    });
    Object.defineProperty(Element.prototype, "checkVisibility", {
      value: checkVisibility,
      configurable: true,
    });
    style.remove(); // only checkVisibility knows that Retour has no box
    const user = userEvent.setup();
    render(<CompactForm />);
    await user.click(named("Ouvrir"));
    await user.tab({ shift: true });
    expect(focused()).toBe(named("Enregistrer"));
    expect(checkVisibility).toHaveBeenCalledWith({
      checkVisibilityCSS: true,
      visibilityProperty: true,
    });
  });

  it("short dialog: a single reachable control keeps the focus", async () => {
    const user = userEvent.setup();
    function Short() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Ouvrir
          </button>
          <Sheet open={open} onClose={() => setOpen(false)} title="Info">
            <button type="button" className="compact-hidden">
              Retour
            </button>
          </Sheet>
        </>
      );
    }
    render(<Short />);
    await user.click(named("Ouvrir"));
    await user.tab();
    expect(focused()).toBe(named("Fermer"));
    await user.tab();
    expect(focused()).toBe(named("Fermer"));
    await user.tab({ shift: true });
    expect(focused()).toBe(named("Fermer"));
  });

  it("nested dialogs: the confirmation traps focus without its hidden control", async () => {
    const user = userEvent.setup();
    render(<CompactForm nestedConfirm />);
    await user.click(named("Ouvrir"));
    await user.click(named("Supprimer"));
    const confirm = screen.getByRole("dialog", { name: "Supprimer ?" });

    await user.tab({ shift: true });
    expect(focused()).toBe(named("Oui, supprimer"));
    await user.tab();
    expect(focused()).toBe(
      within(confirm).getByRole("button", { name: "Fermer" }),
    );
    await user.tab({ shift: true });
    expect(focused()).toBe(named("Oui, supprimer"));
  });
});
