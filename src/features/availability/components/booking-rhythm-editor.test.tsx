// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nextNavigationMock } from "../../../../tests/support/next-router";
import {
  choicesWith,
  intervalOptions,
  minutesLabel,
  slotExample,
} from "../client/booking-rhythm";
import { BookingRhythmEditor } from "./booking-rhythm-editor";

// Point 220: the rhythm of her online bookings, from what she sees
// and does. The Server Action is mocked at its module boundary.

const { actions } = vi.hoisted(() => ({
  actions: { setBookingRhythmAction: vi.fn() },
}));
vi.mock("next/navigation", () => nextNavigationMock);
vi.mock("@/features/availability/actions/schedule", () => ({
  setBookingRhythmAction: (...args: unknown[]) =>
    actions.setBookingRhythmAction(...args),
}));

const BUSINESS = "10000000-0000-4000-8000-000000000001";
const initial = { slotIntervalMinutes: 15, bufferMinutes: 10 };
const select = (name: string) =>
  screen.getByRole("combobox", { name }) as HTMLSelectElement;
/** Her copy keeps "9 h 00" on one line: compared with plain spaces. */
const plain = (text: string) => text.replace(/\u00a0/g, " ");
const hasText = (text: string) =>
  screen.getByText((_, element) =>
    element?.tagName === "SPAN"
      ? plain(element.textContent ?? "").includes(text)
      : false,
  );
const saveButton = () =>
  screen.getByRole("button", { name: "Enregistrer le rythme" });

beforeEach(() => {
  actions.setBookingRhythmAction.mockReset();
});
afterEach(cleanup);

describe("booking rhythm helpers", () => {
  it("speaks in minutes, hours and days", () => {
    expect(minutesLabel(5)).toBe("5 min");
    expect(minutesLabel(60)).toBe("1 h");
    expect(minutesLabel(90)).toBe("1 h 30");
    expect(minutesLabel(65)).toBe("1 h 05");
    expect(minutesLabel(2880)).toBe("2 jours");
    expect(intervalOptions.map((option) => option.value)).toEqual([
      5, 10, 15, 20, 30, 45, 60, 90, 120,
    ]);
    expect(intervalOptions[0]!.label).toBe("Toutes les 5 min");
    expect(intervalOptions[6]!.label).toBe("Toutes les heures");
  });

  it("shows her first slots and keeps an unusual stored value", () => {
    expect(slotExample(15)).toBe(
      "9\u00a0h\u00a000, 9\u00a0h\u00a015, 9\u00a0h\u00a030…",
    );
    expect(plain(slotExample(5, 9 * 60 + 5))).toBe("9 h 05, 9 h 10, 9 h 15…");
    expect(plain(slotExample(90))).toBe("9 h 00, 10 h 30, 12 h 00…");
    const kept = choicesWith(intervalOptions, 25);
    expect(kept.map((option) => option.value)).toContain(25);
    expect(kept.find((option) => option.value === 25)!.label).toBe("25 min");
    expect(choicesWith(intervalOptions, 30)).toBe(intervalOptions);
  });
});

describe("BookingRhythmEditor", () => {
  it("shows her current rhythm and saves nothing until she changes it", () => {
    render(<BookingRhythmEditor businessId={BUSINESS} initial={initial} />);
    expect(select("Créneaux proposés").value).toBe("15");
    expect(select("Pause après chaque rendez-vous").value).toBe("10");
    expect(
      hasText("Si tu ouvres à 9 h : 9 h 00, 9 h 15, 9 h 30…"),
    ).toBeTruthy();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    // The notice keeps its own editor (point 222, BookingNoticeEditor).
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
  });

  it("saves both choices together and confirms what it changes", async () => {
    actions.setBookingRhythmAction.mockResolvedValue({
      ok: true,
      data: { slotIntervalMinutes: 5, bufferMinutes: 0 },
    });
    render(<BookingRhythmEditor businessId={BUSINESS} initial={initial} />);
    fireEvent.change(select("Créneaux proposés"), { target: { value: "5" } });
    expect(
      hasText("Si tu ouvres à 9 h : 9 h 00, 9 h 05, 9 h 10…"),
    ).toBeTruthy();
    fireEvent.change(select("Pause après chaque rendez-vous"), {
      target: { value: "0" },
    });
    fireEvent.click(saveButton());

    await screen.findByText(/Rythme enregistré/);
    expect(actions.setBookingRhythmAction).toHaveBeenCalledTimes(1);
    expect(actions.setBookingRhythmAction).toHaveBeenCalledWith({
      businessId: BUSINESS,
      slotIntervalMinutes: 5,
      bufferMinutes: 0,
    });
    expect(
      screen.getByText(/les rendez-vous déjà pris ne bougent pas/),
    ).toBeTruthy();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps her choice and says why when the save is refused", async () => {
    actions.setBookingRhythmAction.mockResolvedValue({
      ok: false,
      error: { code: "forbidden", message: "backend text never shown" },
    });
    render(<BookingRhythmEditor businessId={BUSINESS} initial={initial} />);
    fireEvent.change(select("Créneaux proposés"), { target: { value: "30" } });
    fireEvent.click(saveButton());

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("backend text never shown")).toBeNull();
    expect(screen.queryByText(/Rythme enregistré/)).toBeNull();
    expect(select("Créneaux proposés").value).toBe("30");
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps a value set elsewhere among the choices", () => {
    render(
      <BookingRhythmEditor
        businessId={BUSINESS}
        initial={{ ...initial, slotIntervalMinutes: 25, bufferMinutes: 20 }}
      />,
    );
    expect(select("Créneaux proposés").value).toBe("25");
    expect(select("Pause après chaque rendez-vous").value).toBe("20");
  });
});
