import type { AgendaAppointmentDto, AgendaDto } from "../data/agenda";

// Who does what in the agenda (M6-R02, read side): the people of the range,
// and the agenda of one of them. Assignment and per-person availability are
// the server's (docs/TEAM_CONTRACT.md); this only reads what it sent.

export type AgendaPerson = { id: string; displayName: string };

/** The people with an appointment in these, by name. */
export function peopleOf(appointments: AgendaAppointmentDto[]): AgendaPerson[] {
  const byId = new Map<string, AgendaPerson>();
  for (const appointment of appointments)
    if (appointment.staff) byId.set(appointment.staff.id, appointment.staff);
  return [...byId.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, "fr"),
  );
}

/**
 * The person whose agenda is shown: hers if she is in this range, everyone
 * otherwise (a choice never hides a whole week silently).
 */
export function shownPerson(people: AgendaPerson[], chosen: string | null) {
  return chosen && people.some((person) => person.id === chosen)
    ? chosen
    : null;
}

/** The agenda of one person (appointments only; blocks are everyone's). */
export function agendaOf(data: AgendaDto, person: string | null): AgendaDto {
  if (!person) return data;
  return {
    ...data,
    appointments: data.appointments.filter(
      (appointment) => appointment.staff?.id === person,
    ),
  };
}
