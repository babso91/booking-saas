// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { overallRate, readCohort, type RetentionReportDto } from "./contract";
import { memoryRetention } from "./memory-actions";
import { RetentionTable } from "./retention-table";

// The retention table against an in-memory server of the PROPOSED report
// (docs/RETENTION_REPORT_PROPOSAL.md), at a fixed date (14 November 2026).

afterEach(cleanup);

const report = (
  cohorts: RetentionReportDto["cohorts"],
): RetentionReportDto => ({
  definitionVersion: "v1",
  windowDays: 60,
  asOf: "2026-11-14T00:00:00.000Z",
  timeZone: "Europe/Paris",
  minCohortSize: 10,
  cohorts,
});

describe("what a cohort may say", () => {
  it("a rate only when fully observed and big enough", () => {
    expect(
      readCohort(
        { month: "x", size: 20, returned: 5, fullyObserved: false },
        10,
      ),
    ).toEqual({ kind: "immature" });
    expect(
      readCohort({ month: "x", size: 4, returned: 2, fullyObserved: true }, 10),
    ).toEqual({ kind: "too_small" });
    expect(
      readCohort(
        { month: "x", size: 20, returned: 5, fullyObserved: true },
        10,
      ),
    ).toEqual({ kind: "rate", rate: 0.25 });
  });

  it("the overall rate weighs readable cohorts by size, never immature or tiny ones", () => {
    expect(
      overallRate(
        report([
          { month: "a", size: 10, returned: 5, fullyObserved: true },
          { month: "b", size: 30, returned: 6, fullyObserved: true },
          { month: "c", size: 50, returned: 50, fullyObserved: false },
          { month: "d", size: 3, returned: 3, fullyObserved: true },
        ]),
      ),
    ).toEqual({ rate: 11 / 40, cohorts: 2, clients: 40 });
    expect(
      overallRate(
        report([{ month: "c", size: 50, returned: 9, fullyObserved: false }]),
      ),
    ).toBeNull();
  });
});

const rowOf = (month: RegExp) =>
  within(screen.getByRole("rowheader", { name: month }).closest("tr")!);

describe("the table", () => {
  it("at 60 days: complete months rated, a tiny month and open windows say why not", async () => {
    render(<RetentionTable actions={memoryRetention().actions} />);
    await screen.findByRole("table");
    expect(document.body.textContent).toMatch(
      /48\s?%reviennent dans les 60 jours, sur 65 nouvelles clientes \(3 mois complets\)/,
    );
    expect(rowOf(/mai 2026/i).getByText(/44\s?%/)).toBeTruthy();
    expect(
      rowOf(/juillet 2026/i).getByText(/trop peu de clientes/),
    ).toBeTruthy();
    expect(rowOf(/septembre 2026/i).getByText(/fenêtre en cours/)).toBeTruthy();
    expect(rowOf(/octobre 2026/i).getByText(/4 pour l’instant/)).toBeTruthy();
  });

  it("another window changes what is complete", async () => {
    render(<RetentionTable actions={memoryRetention().actions} />);
    await screen.findByRole("table");
    fireEvent.click(screen.getByRole("button", { name: "90 jours" }));
    await screen.findByText(/sur 40 nouvelles clientes \(2 mois complets\)/);
    expect(rowOf(/août 2026/i).getByText(/fenêtre en cours/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "30 jours" }));
    await screen.findByText(/sur 84 nouvelles clientes \(4 mois complets\)/);
  });

  it("no data yet, and a failed read, each say so", async () => {
    render(
      <RetentionTable actions={memoryRetention({ empty: true }).actions} />,
    );
    await screen.findByText("Pas encore de données");
    cleanup();
    render(
      <RetentionTable actions={memoryRetention({ failFirst: true }).actions} />,
    );
    await screen.findByText("Les chiffres n’ont pas pu être chargés");
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    await screen.findByRole("table");
  });
});
