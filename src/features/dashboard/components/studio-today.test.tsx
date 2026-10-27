// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  SAMPLE_TODAY,
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

function renderAt(time: string, date = SAMPLE_TODAY) {
  const now = at(time, date);
  return render(
    <StudioToday
      agenda={sampleWeek}
      date={date}
      serverNow={now}
      frozenNow={now}
    />,
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
    // Her own note travels with the next visit.
    expect(now.getByText("Colle sensible — yeux réactifs")).toBeTruthy();
  });

  it("lists the day and leads to it in the agenda", () => {
    renderAt("14:05");
    const day = within(
      screen.getByRole("list", { name: "Rendez-vous du jour" }),
    );
    expect(day.getAllByRole("listitem")).toHaveLength(6);
    const agenda = screen.getAllByRole("link", { name: /agenda/i });
    agenda.forEach((link) =>
      expect(link.getAttribute("href")).toBe(`/app?date=${SAMPLE_TODAY}`),
    );
  });

  it("figures come from her agenda only: no money before payments exist", () => {
    renderAt("14:05");
    const figures = within(screen.getByRole("region", { name: "Chiffres" }));
    expect(figures.getByText("2 terminés · 4 à venir")).toBeTruthy();
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
});
