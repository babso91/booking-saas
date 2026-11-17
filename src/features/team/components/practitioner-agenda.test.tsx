// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PractitionerVisitDto } from "../data/practitioner-agenda";
import { PractitionerAgenda } from "./practitioner-agenda";

const actions = vi.hoisted(() => ({ setMyVisitStatusAction: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn());

vi.mock("../actions/practitioner", () => actions);
vi.mock("@/features/auth/actions/auth", () => ({ signOutAction: vi.fn() }));
vi.mock("next/navigation", async () => ({
  ...(await import("../../../../tests/support/next-router")).nextNavigationMock,
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

const visit = (patch: Partial<PractitionerVisitDto>): PractitionerVisitDto => ({
  id: "00000000-0000-4000-8000-000000000001",
  version: 3,
  status: "confirmed",
  startsAt: "2026-11-17T08:00:00Z",
  endsAt: "2026-11-17T09:00:00Z",
  durationMinutes: 60,
  serviceName: "Pose cil à cil",
  options: [],
  internalNotes: "Yeux sensibles",
  client: {
    id: "c",
    firstName: "Camille",
    lastName: "Roux",
    email: "camille@test.local",
    phone: "0600000000",
  },
  ...patch,
});

function show(visits: PractitionerVisitDto[], serverNow: number) {
  render(
    <PractitionerAgenda
      businessName="Atelier Lune"
      timeZone="Europe/Paris"
      today="2026-11-17"
      days={[
        { date: "2026-11-17", visits },
        { date: "2026-11-18", visits: [] },
      ]}
      previousWeek="/mon-agenda?du=2026-11-10"
      nextWeek="/mon-agenda?du=2026-11-24"
      thisWeek={null}
      serverNow={serverNow}
    />,
  );
}

const AFTER = Date.parse("2026-11-17T10:00:00Z");
const BEFORE = Date.parse("2026-11-17T06:00:00Z");

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("her agenda", () => {
  it("shows what she needs to do the visit, and nothing of the business", () => {
    show([visit({})], AFTER);
    expect(screen.getByRole("heading", { name: "Mon agenda" })).toBeTruthy();
    expect(screen.getByText("Camille Roux")).toBeTruthy();
    expect(screen.getByText("09 h 00 – 10 h 00")).toBeTruthy();
    expect(screen.getByRole("link", { name: "0600000000" })).toBeTruthy();
    expect(screen.getByText("Yeux sensibles")).toBeTruthy();
    expect(screen.getByText("Rien de prévu.")).toBeTruthy();
    // No way into the professional area.
    expect(
      screen
        .queryAllByRole("link")
        .filter((link) => link.getAttribute("href")?.startsWith("/app")),
    ).toHaveLength(0);
  });

  it("a visit not started yet has no outcome to give", () => {
    show([visit({})], BEFORE);
    expect(screen.queryByRole("button", { name: "Réalisé" })).toBeNull();
  });

  it("marks a visit done with its version, then reads her agenda again", async () => {
    actions.setMyVisitStatusAction.mockResolvedValue({ ok: true, data: {} });
    const user = userEvent.setup();
    show([visit({})], AFTER);
    await user.click(screen.getByRole("button", { name: "Réalisé" }));
    expect(actions.setMyVisitStatusAction).toHaveBeenCalledWith({
      appointmentId: "00000000-0000-4000-8000-000000000001",
      expectedVersion: 3,
      status: "completed",
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("changed meanwhile: says so and reads it again", async () => {
    actions.setMyVisitStatusAction.mockResolvedValue({
      ok: false,
      error: { code: "stale_appointment" },
    });
    const user = userEvent.setup();
    show([visit({})], AFTER);
    await user.click(screen.getByRole("button", { name: "Pas venue" }));
    expect(screen.getByText(/a changé entre-temps/)).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("a done visit can be reopened; a cancelled one offers nothing", () => {
    show(
      [
        visit({ status: "completed" }),
        visit({
          id: "00000000-0000-4000-8000-000000000002",
          status: "cancelled",
        }),
      ],
      AFTER,
    );
    const items = screen
      .getAllByRole("listitem")
      .filter(
        (item) =>
          item.querySelector("li") === null &&
          item.textContent?.includes("Camille"),
      );
    expect(
      within(items[0]!).getByRole("button", { name: "Rouvrir" }),
    ).toBeTruthy();
    expect(within(items[1]!).queryByRole("button")).toBeNull();
  });
});
