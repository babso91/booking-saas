import { describe, expect, it } from "vitest";

import { appointment } from "../../../../tests/support/agenda-fixtures";
import type { AgendaDto } from "../data/agenda";
import { agendaOf, peopleOf, shownPerson } from "./people";

// Who does what in the agenda: the people of a range and one person's
// agenda, from what the server sent (docs/TEAM_CONTRACT.md).

const ines = { id: "staff-ines", displayName: "Inès" };
const maelys = { id: "staff-maelys", displayName: "Maëlys" };

const sample = [
  appointment({ id: "a1", staff: maelys }),
  appointment({ id: "a2", staff: ines }),
  appointment({ id: "a3", staff: maelys }),
  appointment({ id: "a4", staff: null }),
];

describe("the people of the agenda", () => {
  it("each person once, by name; an appointment without anyone adds no one", () => {
    expect(peopleOf(sample)).toEqual([ines, maelys]);
    expect(peopleOf([appointment({ staff: null })])).toEqual([]);
  });

  it("a chosen person absent from the range shows everyone, never an empty week", () => {
    expect(shownPerson([ines, maelys], "staff-ines")).toBe("staff-ines");
    expect(shownPerson([maelys], "staff-ines")).toBeNull();
    expect(shownPerson([ines, maelys], null)).toBeNull();
  });

  it("one person's agenda keeps her appointments and everyone's blocks", () => {
    const data = {
      appointments: sample,
      blocks: [{ id: "b1" }],
    } as unknown as AgendaDto;
    const hers = agendaOf(data, "staff-ines");
    expect(hers.appointments.map((a) => a.id)).toEqual(["a2"]);
    expect(hers.blocks).toBe(data.blocks);
    expect(agendaOf(data, null)).toBe(data);
  });
});
