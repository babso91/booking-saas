// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  StrictMode,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useOptionsMenu } from "./use-options-menu";

// The menu's whole life on the document. A closed or gone menu must leave no
// listener behind, whichever way its last press ended; Chromium's real touch
// scroll is played in tests/e2e/consolidation-browser.test.ts.

type Entry = {
  type: string;
  listener: unknown;
  capture: boolean;
  signal?: AbortSignal;
  removed: boolean;
};

const captureOf = (options?: boolean | AddEventListenerOptions) =>
  typeof options === "boolean" ? options : (options?.capture ?? false);

/** Every listener the hook's events can reach, as the document holds them. */
function watchDocument() {
  const entries: Entry[] = [];
  const types = ["click", "pointercancel", "pointerdown", "keydown"];
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (types.includes(type))
        entries.push({
          type,
          listener,
          capture: captureOf(options),
          signal: typeof options === "object" ? options.signal : undefined,
          removed: false,
        });
      add(type, listener, options);
    },
  );
  vi.spyOn(document, "removeEventListener").mockImplementation(
    (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      for (const entry of entries)
        if (
          entry.type === type &&
          entry.listener === listener &&
          entry.capture === captureOf(options)
        )
          entry.removed = true;
      remove(type, listener, options);
    },
  );
  return () =>
    entries
      .filter((entry) => !entry.removed && !entry.signal?.aborted)
      .map((entry) => entry.type);
}

function Menu({
  fallback,
  onPanel,
}: {
  fallback: RefObject<HTMLElement | null>;
  onPanel: () => void;
}) {
  const { open, root, trigger, toggle, leaveFor } = useOptionsMenu(fallback);
  return (
    <div ref={root}>
      <button ref={trigger} type="button" onClick={toggle}>
        Options
      </button>
      {open ? (
        <div>
          <button type="button" onClick={() => leaveFor(onPanel)}>
            Bloquer
          </button>
          <input type="checkbox" aria-label="Annulés" />
        </div>
      ) : null}
    </div>
  );
}

/** A panel gives focus back to what had it when it opened, as Sheet does. */
function Page({ wide = false }: { wide?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const before = useRef<HTMLElement | null>(null);
  const [panel, setPanel] = useState(false);
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Agenda
      </h1>
      <p>Rien à presser</p>
      <button type="button">Ailleurs</button>
      {wide ? null : (
        <Menu
          fallback={heading}
          onPanel={() => {
            before.current = document.activeElement as HTMLElement;
            setPanel(true);
          }}
        />
      )}
      {panel ? (
        <button
          type="button"
          onClick={() => {
            setPanel(false);
            before.current?.focus();
          }}
        >
          Fermer le panneau
        </button>
      ) : null}
    </>
  );
}

const button = (name: string) => screen.getByRole("button", { name });
const option = () => screen.getByRole("button", { name: "Bloquer" });
const isOpen = () => screen.queryByRole("button", { name: "Bloquer" }) !== null;
const outside = () => screen.getByText("Rien à presser");
const openMenu = () => fireEvent.click(button("Options"));
/** A focus on nothing, where a phone's press leaves it. */
const blur = () => (document.activeElement as HTMLElement | null)?.blur();

describe.each<[string, (children: ReactNode) => ReactNode]>([
  ["as rendered", (children) => children],
  ["in Strict Mode", (children) => <StrictMode>{children}</StrictMode>],
])("the options menu, %s", (_, wrap) => {
  let listeners: () => string[];
  const mount = (page = <Page />) => render(wrap(page));

  beforeEach(() => {
    listeners = watchDocument();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("a scroll outside closes it and moves no focus, wherever focus was", () => {
    mount();
    openMenu();
    blur();
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    fireEvent.pointerDown(outside());
    fireEvent.pointerCancel(outside());
    expect(isOpen()).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
    expect(listeners()).toEqual([]);

    // The click of a later press owes nothing to the gesture that was cancelled.
    fireEvent.click(outside());
    expect(focus).not.toHaveBeenCalled();
  });

  it("a click outside on nothing: focus back on its button", () => {
    mount();
    openMenu();
    option().focus();
    fireEvent.pointerDown(outside());
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(outside());
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(button("Options"));
    expect(listeners()).toEqual([]);
  });

  it("a click outside after she moved on: focus stays where she put it", () => {
    mount();
    openMenu();
    button("Ailleurs").focus();
    fireEvent.pointerDown(button("Ailleurs"));
    fireEvent.click(button("Ailleurs"));
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(button("Ailleurs"));
    expect(listeners()).toEqual([]);
  });

  it.each(["click", "pointerCancel"] as const)(
    "gone before its %s: nothing stays, nothing acts",
    (ending) => {
      const { unmount } = mount();
      openMenu();
      fireEvent.pointerDown(outside());
      expect(listeners()).not.toEqual([]);
      unmount();
      expect(listeners()).toEqual([]);

      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      fireEvent[ending](document.body);
      expect(focus).not.toHaveBeenCalled();
    },
  );

  it("a press with no ending is over at the next press", () => {
    mount();
    openMenu();
    fireEvent.pointerDown(outside());
    fireEvent.pointerUp(outside());
    fireEvent.pointerDown(outside());
    expect(listeners()).toEqual([]);
  });

  it("opened and closed many times, every way: nothing piles up", () => {
    const { unmount } = mount();
    for (let round = 0; round < 3; round += 1) {
      openMenu();
      fireEvent.pointerDown(outside());
      fireEvent.pointerCancel(outside());
      expect(listeners()).toEqual([]);

      openMenu();
      fireEvent.pointerDown(outside());
      fireEvent.click(outside());
      expect(listeners()).toEqual([]);

      openMenu();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(listeners()).toEqual([]);

      openMenu();
      fireEvent.click(button("Options"));
      expect(isOpen()).toBe(false);
      expect(listeners()).toEqual([]);
    }
    openMenu();
    expect(listeners().sort()).toEqual(["keydown", "pointerdown"]);
    unmount();
    expect(listeners()).toEqual([]);
  });

  it("Escape from the menu: back on its button", () => {
    mount();
    openMenu();
    screen.getByLabelText("Annulés").focus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(button("Options"));
  });

  it("Escape after she moved on: focus stays where she put it", () => {
    mount();
    openMenu();
    button("Ailleurs").focus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(button("Ailleurs"));
  });

  it("an option's panel takes the focus from its button and gives it back", () => {
    mount();
    openMenu();
    option().focus();
    fireEvent.click(option());
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(button("Options"));
    button("Fermer le panneau").focus();
    fireEvent.click(button("Fermer le panneau"));
    expect(document.activeElement).toBe(button("Options"));
    expect(listeners()).toEqual([]);
  });

  it("the screen widens (390 → 1440): the title takes a focus that was inside", () => {
    const { rerender } = mount();
    openMenu();
    option().focus();
    rerender(wrap(<Page wide />));
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Agenda" }),
    );
    expect(listeners()).toEqual([]);
  });

  it("the screen widens: a focus she placed elsewhere does not move", () => {
    const { rerender } = mount();
    openMenu();
    button("Ailleurs").focus();
    rerender(wrap(<Page wide />));
    expect(document.activeElement).toBe(button("Ailleurs"));
    expect(listeners()).toEqual([]);
  });
});
