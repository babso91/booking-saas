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
    // A confirmed slot that has started is not a service known to have
    // started: the slot is said, its progress is theoretical.
    expect(now.getByText("Créneau en cours")).toBeTruthy();
    expect(now.queryByText("En cours")).toBeNull();
    expect(now.getByText("Sarah Benali")).toBeTruthy();
    const progress = now.getByRole("progressbar", {
      name: "Avancement théorique du créneau",
    });
    expect(progress.getAttribute("aria-valuetext")).toBe(
      "fin prévue dans 40 min",
    );
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
      figures.getByText("Vendredi 30 est le plus rempli (83 %)."),
    ).toBeTruthy();
    // Measured on bookable time: 435 min booked of 9 h–19 h minus lunch.
    expect(figures.getByText("vendredi : 83 % réservé")).toBeTruthy();
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
      expect(now.getByText("Créneaux en cours · 2")).toBeTruthy();
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

  describe("audit #28", () => {
    const lateNight: AgendaDto = {
      ...sampleWeek,
      appointments: [
        ...sampleWeek.appointments,
        {
          ...sampleWeek.appointments[0]!,
          id: "00000000-0000-4000-8000-0000000000aa",
          status: "confirmed",
          startsAt: sampleInstant("2026-10-27", "23:30"),
          endsAt: sampleInstant("2026-10-28", "01:30"),
          localStartsAt: "2026-10-27T23:30",
          localEndsAt: "2026-10-28T01:30",
          durationMinutes: 120,
          client: { id: "night", displayName: "Lou Minuit" },
        },
      ],
    };

    it("a visit across midnight is on both days, said as such", () => {
      const { unmount } = renderAt("22:00", SAMPLE_TODAY, lateNight);
      const tuesday = within(
        screen.getByRole("list", { name: "Rendez-vous du jour" }),
      );
      expect(
        within(tuesday.getByRole("link", { name: /Lou Minuit/ })).getByText(
          /jusqu’à demain 01:30/,
        ),
      ).toBeTruthy();
      unmount();
      renderAt("00:30", "2026-10-28", lateNight);
      const now = within(screen.getByRole("region", { name: "Maintenant" }));
      expect(now.getByText("Lou Minuit")).toBeTruthy();
      const wednesday = within(
        screen.getByRole("list", { name: "Rendez-vous du jour" }),
      );
      expect(
        within(wednesday.getByRole("link", { name: /Lou Minuit/ })).getByText(
          /depuis hier 23:30/,
        ),
      ).toBeTruthy();
    });

    it("the list says « Créneau en cours », never that a service has started", () => {
      renderAt("14:05");
      const day = within(
        screen.getByRole("list", { name: "Rendez-vous du jour" }),
      );
      expect(
        within(day.getByRole("link", { name: /Sarah Benali/ })).getByText(
          "Créneau en cours",
        ),
      ).toBeTruthy();
    });

    it("an exceptional closure is said as one, and counts as closed in the fill rate", () => {
      const closed: AgendaDto = {
        ...sampleWeek,
        appointments: sampleWeek.appointments.filter(
          (appointment) => !appointment.localStartsAt.startsWith("2026-10-29"),
        ),
        blocks: [
          ...sampleWeek.blocks.filter(
            (block) => !block.localStartsAt.startsWith("2026-10-29"),
          ),
          {
            ...sampleWeek.blocks[0]!,
            id: "00000000-0000-4000-9000-0000000000cc",
            kind: "closed",
            startsAt: sampleInstant("2026-10-29", "00:00"),
            endsAt: sampleInstant("2026-10-30", "00:00"),
            localStartsAt: "2026-10-29T00:00",
            localEndsAt: "2026-10-30T00:00",
            reason: "Formation",
          },
        ],
      };
      renderAt("11:00", "2026-10-29", closed);
      const now = within(screen.getByRole("region", { name: "Maintenant" }));
      expect(now.getByText("Fermeture exceptionnelle")).toBeTruthy();
      expect(now.getByText("Formation")).toBeTruthy();
      expect(now.queryByText("Journée libre")).toBeNull();
      expect(screen.getByText("jeudi : fermé")).toBeTruthy();
    });
  });

  describe("counter-audit of fc24a56", () => {
    const lateNight: AgendaDto = {
      ...sampleWeek,
      appointments: [
        ...sampleWeek.appointments,
        {
          ...sampleWeek.appointments[0]!,
          id: "00000000-0000-4000-8000-0000000000aa",
          status: "confirmed",
          startsAt: sampleInstant("2026-10-27", "23:30"),
          endsAt: sampleInstant("2026-10-28", "01:30"),
          localStartsAt: "2026-10-27T23:30",
          localEndsAt: "2026-10-28T01:30",
          durationMinutes: 120,
          service: {
            id: "long",
            name: "Pose volume russe 4D avec dépose complète et soin kératine",
          },
          client: {
            id: "night",
            displayName: "Marie-Charlotte de La Rochefoucauld-Montbazon",
          },
        },
      ],
    };

    it("« Cette semaine » says what it counts: bookings starting this week", () => {
      renderAt("14:05");
      const figures = within(screen.getByRole("region", { name: "Chiffres" }));
      expect(
        figures.getByText("rendez-vous commençant cette semaine, lun. → dim."),
      ).toBeTruthy();
      expect(figures.queryByText(/du lundi au dimanche/)).toBeNull();
    });

    it("« Cette semaine » counts one booking once, even across midnight", () => {
      renderAt("22:00", SAMPLE_TODAY, lateNight);
      const figures = within(screen.getByRole("region", { name: "Chiffres" }));
      // 25 bookings in the sample week, plus the night one: 26, not 27.
      expect(figures.getByText("26")).toBeTruthy();
      expect(figures.queryByText("27")).toBeNull();
    });

    it("the time across midnight is never inside a truncated label", () => {
      for (const [time, date, text] of [
        ["22:00", SAMPLE_TODAY, /jusqu’à demain 01:30/],
        ["00:30", "2026-10-28", /depuis hier 23:30/],
      ] as const) {
        const { unmount } = renderAt(time, date, lateNight);
        const row = screen.getByRole("link", { name: /Marie-Charlotte/ });
        const mention = within(row).getByText(text);
        expect(mention.closest(".truncate")).toBeNull();
        expect(mention.className).not.toMatch(/\btruncate\b/);
        unmount();
      }
    });

    const training = (
      from: string,
      to: string,
      keepVisits = false,
    ): AgendaDto => ({
      ...sampleWeek,
      appointments: keepVisits
        ? sampleWeek.appointments
        : sampleWeek.appointments.filter(
            (appointment) =>
              !appointment.localStartsAt.startsWith("2026-10-29"),
          ),
      blocks: [
        ...sampleWeek.blocks,
        {
          ...sampleWeek.blocks[0]!,
          id: "00000000-0000-4000-9000-0000000000dd",
          kind: "closed",
          startsAt: sampleInstant("2026-10-29", from),
          endsAt: sampleInstant("2026-10-29", to),
          localStartsAt: `2026-10-29T${from}`,
          localEndsAt: `2026-10-29T${to}`,
          reason: "Formation",
        },
      ],
    });

    it("free day, partly closed: the closure is said, not « Journée libre »", () => {
      renderAt("11:00", "2026-10-29", training("10:00", "12:00"));
      const now = within(screen.getByRole("region", { name: "Maintenant" }));
      expect(now.getByText("Fermeture partielle")).toBeTruthy();
      expect(now.queryByText("Journée libre")).toBeNull();
      expect(
        screen.getAllByText(/Fermé de 10:00 à 12:00 · Formation/).length,
      ).toBeGreaterThan(0);
    });

    it("a day with visits and a partial closure says both", () => {
      renderAt("09:30", "2026-10-29", training("12:00", "13:00", true));
      const now = within(screen.getByRole("region", { name: "Maintenant" }));
      expect(now.getByText("Anaïs Thomas")).toBeTruthy();
      expect(
        screen.getByText(/Fermé de 12:00 à 13:00 · Formation/),
      ).toBeTruthy();
    });

    it("a truly free day stays « Journée libre », with no closure mention", () => {
      renderAt("11:00", "2026-11-01", {
        ...sampleWeek,
        workingHours: {
          ...sampleWeek.workingHours,
          days: sampleWeek.workingHours.days.map((day) =>
            day.date === "2026-11-01"
              ? {
                  ...day,
                  openRanges: sampleWeek.workingHours.days[0]!.openRanges.map(
                    (range) => ({
                      ...range,
                      startsAt: sampleInstant("2026-11-01", "09:00"),
                      endsAt: sampleInstant("2026-11-01", "19:00"),
                      localStartsAt: "2026-11-01T09:00",
                      localEndsAt: "2026-11-01T19:00",
                    }),
                  ),
                }
              : day,
          ),
        },
      });
      const now = within(screen.getByRole("region", { name: "Maintenant" }));
      expect(now.getByText("Journée libre")).toBeTruthy();
      expect(screen.queryByText(/Fermé de/)).toBeNull();
    });
  });
});
