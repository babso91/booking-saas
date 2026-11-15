import { describe, expect, it } from "vitest";

import type { AgendaAppointmentDto, AgendaDto } from "../data/agenda";
import { agendaPulse } from "./agenda-pulse";

const at = (id: string, start: string, end: string, status = "confirmed") =>
  ({
    id,
    status,
    startsAt: `${start}:00.000Z`,
    endsAt: `${end}:00.000Z`,
    localStartsAt: `${start}:00`,
    localEndsAt: `${end}:00`,
    client: { id: `c-${id}`, displayName: id },
    service: { id: "s", name: "Pose" },
  }) as unknown as AgendaAppointmentDto;

const data = (appointments: AgendaAppointmentDto[]) =>
  ({ appointments, blocks: [] }) as unknown as AgendaDto;

const day = "2026-11-15";
const ms = (time: string) => Date.parse(`${day}T${time}:00.000Z`);
const visits = data([
  at("a", `${day}T09:00`, `${day}T10:00`),
  at("b", `${day}T11:00`, `${day}T12:00`),
  at("x", `${day}T12:00`, `${day}T13:00`, "cancelled"),
  at("c", `${day}T14:00`, `${day}T15:00`),
  at("d", `2026-11-16T09:00`, `2026-11-16T10:00`),
]);

describe("agendaPulse", () => {
  it("names the next visit and how many are left after it", () => {
    const pulse = agendaPulse(visits, [day, "2026-11-16"], day, ms("10:30"));
    expect(pulse).toMatchObject({ kind: "today", count: 3, left: 1 });
    expect(pulse.kind === "today" && pulse.focus?.appointment.id).toBe("b");
    expect(pulse.kind === "today" && pulse.focus?.ongoing).toBe(false);
  });

  it("prefers the visit in progress", () => {
    const pulse = agendaPulse(visits, [day], day, ms("11:15"));
    expect(pulse).toMatchObject({ kind: "today", left: 1 });
    expect(pulse.kind === "today" && pulse.focus?.ongoing).toBe(true);
  });

  it("says nothing is left once the day is over", () => {
    const pulse = agendaPulse(visits, [day], day, ms("18:00"));
    expect(pulse).toMatchObject({ kind: "today", focus: null, count: 3 });
  });

  it("counts the range, cancelled excluded, away from today or without a clock", () => {
    expect(agendaPulse(visits, ["2026-11-20"], day, ms("10:00"))).toEqual({
      kind: "range",
      count: 4,
    });
    expect(agendaPulse(visits, [day], day, null)).toEqual({
      kind: "range",
      count: 4,
    });
  });
});
