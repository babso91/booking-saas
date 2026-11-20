export const agendaFormats = [
  "classic",
  "visual",
  "availability",
  "salon",
] as const;
export type AgendaFormat = (typeof agendaFormats)[number];

export const agendaFormatNames: Record<AgendaFormat, string> = {
  classic: "Agenda de mon univers",
  visual: "Planning visuel",
  availability: "Disponibilités",
  salon: "Agenda salon",
};

export function agendaPreferenceKey(membershipId: string) {
  return `higani_agenda_${membershipId}`;
}

export function readAgendaFormat(value: unknown): AgendaFormat {
  return agendaFormats.find((format) => format === value) ?? "classic";
}
