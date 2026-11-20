export const bookingFormats = [
  "classic",
  "calendar",
  "chronological",
  "showcase",
  "guided",
] as const;
export type BookingFormat = (typeof bookingFormats)[number];

export const bookingFormatCopy: Record<
  BookingFormat,
  { name: string; description: string }
> = {
  classic: {
    name: "Classique",
    description:
      "Ta cliente choisit sa prestation puis son horaire dans le parcours habituel de ton univers.",
  },
  calendar: {
    name: "Calendrier",
    description:
      "Après la prestation, le mois s’ouvre sur les jours disponibles. Ta cliente touche une date pour choisir l’heure.",
  },
  chronological: {
    name: "Chronologique",
    description:
      "Les heures disponibles se lisent sur plusieurs jours à la suite et se sélectionnent directement.",
  },
  showcase: {
    name: "Vitrine",
    description:
      "Tes réalisations et ton catalogue ouvrent la réservation. Ta cliente explore ton travail avant de choisir sa prestation.",
  },
  guided: {
    name: "Guidé",
    description:
      "Ta cliente avance étape par étape, de la catégorie de prestation à la confirmation, avec ses choix sous les yeux.",
  },
};
