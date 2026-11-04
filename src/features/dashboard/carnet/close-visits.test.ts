import { describe, expect, it } from "vitest";

import type { PlacedAppointment } from "@/features/agenda/client/layout";

import { appointment } from "../../../../tests/support/agenda-fixtures";
import { closeVisitsOf, pieceKey, TARGET_PX } from "./close-visits";

// y in minutes; the Carnet week draws at least 1.2 px a minute.
const SCALE = 1.2;
const MIN = TARGET_PX / SCALE; // 20 minutes for a 24 px target

function placed(top: number, minutes: number, lane = 0, lanes = 1) {
  const item = appointment();
  return {
    appointment: item,
    pieces: [{ top, bottom: top + minutes }],
    top,
    bottom: top + minutes,
    continuesBefore: false,
    continuesAfter: false,
    lane,
    lanes,
  } satisfies PlacedAppointment;
}

describe("closeVisitsOf", () => {
  it("eight visits of 5 minutes, every 15 minutes, share one target", () => {
    const day = Array.from({ length: 8 }, (_, index) =>
      placed(600 + index * 15, 5),
    );
    const { groups, shared } = closeVisitsOf(day, SCALE);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.appointments).toEqual(day.map((v) => v.appointment));
    // From the first start, exactly; down to the last one's target.
    expect(groups[0]!.top).toBe(600);
    expect(groups[0]!.bottom).toBe(600 + 7 * 15 + MIN);
    expect(shared.size).toBe(8);
  });

  it("a short visit with room for its target keeps its own", () => {
    const day = [placed(600, 5), placed(600 + MIN, 60)];
    const { groups, shared } = closeVisitsOf(day, SCALE);
    expect(groups).toEqual([]);
    expect(shared.size).toBe(0);
  });

  it("a short visit right before a long one shares a target with it", () => {
    const long = placed(610, 120);
    const { groups } = closeVisitsOf([placed(600, 10), long], SCALE);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.bottom).toBe(730);
  });

  it("long visits side by side keep their own targets, as before", () => {
    const { groups } = closeVisitsOf(
      [placed(600, 90, 0, 2), placed(630, 90, 1, 2)],
      SCALE,
    );
    expect(groups).toEqual([]);
  });

  it("two groups apart stay two", () => {
    const { groups } = closeVisitsOf(
      [placed(600, 5), placed(610, 5), placed(800, 5), placed(812, 5)],
      SCALE,
    );
    expect(groups.map((group) => group.top)).toEqual([600, 800]);
  });

  it("a taller page gives each visit more room", () => {
    const day = [placed(600, 5), placed(615, 5)];
    expect(closeVisitsOf(day, SCALE).groups).toHaveLength(1);
    expect(closeVisitsOf(day, 2).groups).toEqual([]);
  });

  it("a visit drawn in two pieces is still one target of its own", () => {
    const split = placed(600, 5);
    const twice = {
      ...split,
      pieces: [
        { top: 600, bottom: 603 },
        { top: 605, bottom: 607 },
      ],
    };
    expect(closeVisitsOf([twice], SCALE)).toEqual({
      groups: [],
      shared: new Set(),
    });
    // With a neighbour, both of its pieces are in the group, itself once.
    const next = placed(612, 5);
    const { groups, shared } = closeVisitsOf([twice, next], SCALE);
    expect(groups[0]!.appointments).toEqual([
      split.appointment,
      next.appointment,
    ]);
    expect(shared.has(pieceKey(split.appointment, 1))).toBe(true);
  });
});
