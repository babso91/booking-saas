// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AgendaDto } from "@/features/agenda/data/agenda";

import {
  SAMPLE_TODAY,
  sampleBusyWeek,
  sampleInstant,
  sampleWeek,
} from "../fixtures/sample-week";
import { StudioToday } from "./studio-today";

vi.mock(
  "next/navigation",
  async () =>
    (await import("../../../../tests/support/next-router")).nextNavigationMock,
);

const at = (time: string, date = SAMPLE_TODAY) =>
  Date.parse(sampleInstant(date, time));

const idOf = (name: string, agenda: AgendaDto = sampleWeek) =>
  agenda.appointments.find(
    (appointment) => appointment.client.displayName === name,
  )!.id;

function renderAt(time: string, date = SAMPLE_TODAY, agenda = sampleWeek) {
  const now = at(time, date);
  return render(
    <StudioToday agenda={agenda} date={date} serverNow={now} frozenNow={now} />,
  );
}

describe("StudioToday", () => {
  it("says what is going on now, how long is left, and who comes next", () => {
    renderAt("14:05");
    const now = within(screen.getByRole("region", { name: "Maintenant" }));
    expect(now.getByText("14.05")).toBeTruthy();
    expect(now.getByText("En cours")).toBeTruthy();
    expect(now.getByText("Sarah Benali")).toBeTruthy();
    const progress = now.getByRole("progressbar", {
      name: "Avancement du rendez-vous",
    });
    expect(progress.getAttribute("aria-valuetext")).toBe("encore 40 min");
    expect(now.getByText("Léa Fontaine")).toBeTruthy();
    // Straight to each visit in the agenda, its details open.
    const links = now.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `/app?date=${SAMPLE_TODAY}&rdv=${idOf("Sarah Benali")}`,
      `/app?date=${SAMPLE_TODAY}&rdv=${idOf("Léa Fontaine")}`,
    ]);
    // Léa has a note: the colour field says so, never what it says.
    expect(within(links[1]!).getByText("Note")).toBeTruthy();
    expect(screen.queryByText(/Colle sensible/)).toBeNull();
  });

  it("her notes are shown only when she asks, then hidden again", async () => {
    const user = userEvent.setup();
    renderAt("14:05");
    const toggle = screen.getByRole("button", { name: "Afficher" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("À ne pas oublier · 2 notes")).toBeTruthy();
    await user.click(toggle);
    expect(screen.getByText(/Colle sensible — yeux réactifs/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Masquer" }));
    expect(screen.queryByText(/Colle sensible/)).toBeNull();
  });

  it("lists the day and leads to it in the agenda", () => {
    renderAt("14:05");
    const day = within(
      screen.getByRole("list", { name: "Rendez-vous du jour" }),
    );
    expect(day.getAllByRole("listitem")).toHaveLength(6);
    expect(
      day.getAllByRole("link").map((link) => link.getAttribute("href")),
    ).toContain(`/app?date=${SAMPLE_TODAY}&rdv=${idOf("Julie Martin")}`);
    expect(
      screen.getByRole("link", { name: "Agenda" }).getAttribute("href"),
    ).toBe(`/app?date=${SAMPLE_TODAY}`);
  });

  it("figures come from her agenda only: no money before payments exist", () => {
    renderAt("14:05");
    const figures = within(screen.getByRole("region", { name: "Chiffres" }));
    expect(figures.getByText("2 passés · 4 à venir")).toBeTruthy();
    expect(figures.queryByText(/€/)).toBeNull();
    expect(screen.queryByText(/€/)).toBeNull();
    expect(
      figures.getByText("Vendredi 30 est le plus rempli (73 %)."),
    ).toBeTruthy();
  });

  it("a closed day is a day off, said kindly, without a fake line", () => {
    renderAt("11:00", "2026-11-01");
    const now = within(screen.getByRole("region", { name: "Maintenant" }));
    expect(now.getByText("Jour de fermeture")).toBeTruthy();
    expect(now.getByText("Repos")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText(/Ta journée est libre/)).toBeTruthy();
  });

  it("after the last visit, the day is over", () => {
    renderAt("19:10");
    const now = within(screen.getByRole("region", { name: "Maintenant" }));
    expect(now.getByText("Journée terminée")).toBeTruthy();
  });

  describe("a heavy day", () => {
    it("overlapping visits are all said, none hidden, and no single progress bar pretends", () => {
      renderAt("14:05", SAMPLE_TODAY, sampleBusyWeek);
      const now = within(screen.getByRole("region", { name: "Maintenant" }));
      expect(now.getByText("En cours · 2 rendez\u2011vous")).toBeTruthy();
      expect(now.getByRole("link", { name: "Sarah Benali" })).toBeTruthy();
      expect(now.getByRole("link", { name: "Aïcha Diallo" })).toBeTruthy();
      expect(now.queryByRole("progressbar")).toBeNull();
    });

    it("a cancelled visit is not on her day; an absent one is said as such", () => {
      renderAt("14:05", SAMPLE_TODAY, sampleBusyWeek);
      expect(screen.queryByText("Annulée Exemple")).toBeNull();
      const day = within(
        screen.getByRole("list", { name: "Rendez-vous du jour" }),
      );
      expect(day.getAllByRole("listitem")).toHaveLength(13);
      expect(
        within(day.getByRole("link", { name: /Zoé Petit/ })).getByText(
          "Absente",
        ),
      ).toBeTruthy();
    });

    it("a long note stays out of sight until asked, then is shown whole", async () => {
      const user = userEvent.setup();
      renderAt("14:05", SAMPLE_TODAY, sampleBusyWeek);
      expect(screen.queryByText(/latex/)).toBeNull();
      await user.click(screen.getByRole("button", { name: "Afficher" }));
      expect(screen.getByText(/latex/).textContent).toContain(
        "à rappeler après le rendez-vous",
      );
    });
  });
});
