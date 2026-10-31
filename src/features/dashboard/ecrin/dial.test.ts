import { describe, expect, it } from "vitest";

import { todayModel } from "../client/today-model";
import {
  SAMPLE_TODAY,
  sampleBusyWeek,
  sampleInstant,
  sampleWeek,
} from "../fixtures/sample-week";
import { angleOf, dialArcs, dialTicks, handAngle } from "./dial";

const at = (time: string, date = SAMPLE_TODAY) =>
  Date.parse(sampleInstant(date, time));

describe("the dial's geometry", () => {
  const model = todayModel(sampleWeek, SAMPLE_TODAY, at("14:05"));

  it("the day runs over 300°, opening at the bottom left", () => {
    expect(angleOf(model.span, at("09:00"))).toBe(-150);
    expect(angleOf(model.span, at("14:00"))).toBe(0);
    expect(angleOf(model.span, at("19:00"))).toBe(150);
  });

  it("the hand points at now, only when now is on the day's line", () => {
    expect(handAngle(model.span, at("14:00"))).toBe(0);
    expect(handAngle(model.span, at("08:00"))).toBeNull();
    expect(handAngle(model.span, at("20:00"))).toBeNull();
    expect(handAngle(model.span, null)).toBeNull();
  });

  it("each visit has its capsule, its look from status and time", () => {
    const arcs = dialArcs(model.visits, model.span, at("14:05"));
    expect(arcs.map((arc) => arc.look)).toEqual([
      "completed",
      "completed",
      "now",
      "ahead",
      "ahead",
      "ahead",
    ]);
  });

  it("overlapping visits sit on rings of their own, never on top of each other", () => {
    const busy = todayModel(sampleBusyWeek, SAMPLE_TODAY, at("14:05"));
    const arcs = dialArcs(busy.visits, busy.span, at("14:05"));
    const radius = (name: string) =>
      arcs
        .find((arc) =>
          arc.visit.appointment.client.displayName.startsWith(name),
        )!
        .d.split(" A ")[1]!
        .split(" ")[0];
    expect(radius("Sarah")).not.toBe(radius("Aïcha"));
    expect(radius("Marie")).not.toBe(radius("Lina"));
    expect(arcs).toHaveLength(13);
  });

  it("a 2-minute visit is still drawn: a dot", () => {
    const short = model.visits[0]!;
    const [arc] = dialArcs(
      [{ ...short, start: at("10:00"), end: at("10:02") }],
      model.span,
      at("14:05"),
    );
    expect(arc!.d).toMatch(/^M [\d.]+ [\d.]+ A/);
  });

  it("a whole-day span labels one mark in three", () => {
    const closed = todayModel(
      sampleWeek,
      "2026-11-01",
      at("11:00", "2026-11-01"),
    );
    const labelled = dialTicks(closed.ticks, closed.span).filter(
      (tick) => tick.label,
    );
    expect(labelled.length).toBeLessThan(10);
  });

  it("paths are rounded: the server and the browser draw the same", () => {
    const arcs = dialArcs(model.visits, model.span, at("14:05"));
    for (const arc of arcs) expect(arc.d).not.toMatch(/\d\.\d{3,}/);
  });
});
