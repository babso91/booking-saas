// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AgendaDto } from "@/features/agenda/data/agenda";

import {
  SAMPLE_TODAY,
  sampleDenseWeek,
  sampleInstant,
  sampleNightWeek,
  sampleTrainingWeek,
  sampleWeek,
} from "../fixtures/sample-week";
import { EcrinToday } from "./ecrin-today";

vi.mock(
  "next/navigation",
  async () =>
    (await import("../../../../tests/support/next-router")).nextNavigationMock,
);

function renderAt(time: string, date = SAMPLE_TODAY, agenda = sampleWeek) {
  const now = Date.parse(sampleInstant(date, time));
  return render(
    <EcrinToday agenda={agenda} date={date} serverNow={now} frozenNow={now} />,
  );
}

const only = (keep: (name: string) => boolean): AgendaDto => ({
  ...sampleWeek,
  appointments: sampleWeek.appointments.filter((appointment) =>
    keep(appointment.client.displayName),
  ),
});

const dial = () => within(screen.getByRole("region", { name: "Maintenant" }));
const visits = () =>
  within(screen.getByRole("region", { name: "Rendez-vous du jour" }));

describe("EcrinToday", () => {
  it("the dial says the hour and the slot going on; the next visit is marked", () => {
    renderAt("14:05");
    expect(dial().getByText("Créneau en cours")).toBeTruthy();
    expect(dial().queryByText("En cours")).toBeNull();
    expect(dial().getByText("Sarah Benali")).toBeTruthy();
    expect(dial().getByText("fin prévue dans 40 min")).toBeTruthy();
    const next = visits().getByRole("link", { name: /Léa Fontaine/ });
    expect(next.textContent).toMatch(/Prochain · dans 55 min/);
    expect(next.getAttribute("href")).toMatch(
      new RegExp(`^/app\\?date=${SAMPLE_TODAY}&rdv=`),
    );
  });

  it("shows no amount of money, ever", () => {
    renderAt("14:05");
    expect(document.body.textContent).not.toMatch(/€|\beur\b/i);
  });

  it("her notes: only that one exists, their text when she asks", async () => {
    const user = userEvent.setup();
    renderAt("14:05");
    expect(screen.queryByText(/Colle sensible/)).toBeNull();
    expect(
      visits().getByRole("link", { name: /Léa Fontaine/ }).textContent,
    ).toMatch(/note/);
    await user.click(screen.getByRole("button", { name: "Afficher" }));
    expect(screen.getByText(/Colle sensible/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Masquer" }));
    expect(screen.queryByText(/Colle sensible/)).toBeNull();
  });

  it("0 visit: a free day is said, with nothing invented", () => {
    renderAt(
      "10:00",
      SAMPLE_TODAY,
      only(() => false),
    );
    expect(dial().getByText("Journée libre")).toBeTruthy();
    expect(screen.getByText("Aucun rendez-vous aujourd’hui.")).toBeTruthy();
    expect(visits().queryAllByRole("link")).toHaveLength(0);
  });

  it("1 visit: it is the next, then going on, then the day is over", () => {
    const one = only((name) => name === "Léa Fontaine");
    const { unmount } = renderAt("09:00", SAMPLE_TODAY, one);
    expect(dial().getByText(/^Prochain · 15:00/)).toBeTruthy();
    unmount();
    const during = renderAt("15:30", SAMPLE_TODAY, one);
    expect(dial().getByText("Créneau en cours")).toBeTruthy();
    during.unmount();
    renderAt("18:00", SAMPLE_TODAY, one);
    expect(dial().getByText("Journée terminée")).toBeTruthy();
  });

  it("15 visits: all reachable, the past on demand, no one lost", async () => {
    const user = userEvent.setup();
    renderAt("14:05", SAMPLE_TODAY, sampleDenseWeek);
    await user.click(
      screen.getByRole("button", { name: /^Voir \d+ rendez.vous passés?$/ }),
    );
    expect(visits().getAllByRole("link")).toHaveLength(15);
  });

  it("across midnight: said on its own line, counted once in the week", () => {
    renderAt("23:45", SAMPLE_TODAY, sampleNightWeek);
    const night = visits().getAllByRole("link", {
      name: /Marie-Charlotte/,
    })[0]!;
    expect(night.textContent).toMatch(/jusqu’à demain 01:30/);
    const distinct = new Set(
      sampleNightWeek.appointments
        .filter((appointment) => appointment.status !== "cancelled")
        .map((appointment) => appointment.id),
    ).size;
    expect(distinct).toBeGreaterThan(0);
    expect(
      Number(
        screen
          .getByText(/rendez-vous commençant cette semaine/)
          .textContent!.match(/\d+/)![0],
      ),
    ).toBeLessThanOrEqual(distinct);
  });

  it("a partial closure is visible; a closed day says so", () => {
    const partial = renderAt("09:00", "2026-10-29", sampleTrainingWeek);
    expect(screen.getByText(/Fermé de 10:00 à 12:00 · Formation/)).toBeTruthy();
    partial.unmount();
    renderAt("11:00", "2026-11-01");
    expect(dial().getByText("Jour de fermeture")).toBeTruthy();
    expect(screen.getByText(/Ton espace est fermé/)).toBeTruthy();
  });
});
