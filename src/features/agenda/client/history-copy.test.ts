import { describe, expect, it } from "vitest";

import { actorLabel, changedAtLabel, describeChange } from "./history-copy";

const you = { kind: "member" as const, name: "Nora", isYou: true };
const lea = { kind: "member" as const, name: "Léa", isYou: false };
const client = { kind: "client" as const, name: null, isYou: false };

describe("appointment history wording", () => {
  it("names who changed it", () => {
    expect(actorLabel(you)).toBe("Toi");
    expect(actorLabel(lea)).toBe("Léa");
    expect(actorLabel({ ...lea, name: null })).toBe("Un membre de l’équipe");
    expect(actorLabel(client)).toBe("La cliente");
    expect(actorLabel({ kind: "system", name: null, isYou: false })).toBe(
      "Higani",
    );
    expect(changedAtLabel({ localAt: "2026-11-22T14:05" })).toBe(
      "22 nov. 2026, 14:05",
    );
  });

  it("says what changed, in her words", () => {
    expect(
      describeChange(
        {
          type: "created",
          serviceName: "Coupe",
          status: "confirmed",
          localStartsAt: "2026-12-05T10:00",
          localEndsAt: "2026-12-05T11:00",
          inSeries: false,
        },
        client,
      ),
    ).toBe("Réservé en ligne : samedi 5 décembre à 10:00 – 11:00 · Coupe");
    expect(describeChange({ type: "created", inSeries: true }, you)).toBe(
      "Rendez-vous créé (rendez-vous répété)",
    );
    expect(
      describeChange(
        {
          type: "moved",
          from: {
            localStartsAt: "2026-12-05T10:00",
            localEndsAt: "2026-12-05T11:00",
          },
          to: {
            localStartsAt: "2026-12-06T14:30",
            localEndsAt: "2026-12-06T15:30",
          },
        },
        you,
      ),
    ).toBe(
      "Déplacé du samedi 5 décembre à 10:00 au dimanche 6 décembre à 14:30",
    );
    expect(
      describeChange(
        {
          type: "moved",
          from: {
            localStartsAt: "2026-12-05T10:00",
            localEndsAt: "2026-12-05T11:00",
          },
          to: {
            localStartsAt: "2026-12-05T15:00",
            localEndsAt: "2026-12-05T16:00",
          },
        },
        you,
      ),
    ).toBe("Déplacé de 10:00 à 15:00, samedi 5 décembre");
    expect(
      describeChange({ type: "duration", fromMinutes: 60, toMinutes: 90 }, you),
    ).toBe("Durée : 1 h → 1 h 30");
    expect(
      describeChange({ type: "service", from: "Coupe", to: "Couleur" }, you),
    ).toBe("Prestation : Coupe → Couleur");
    expect(
      describeChange(
        {
          type: "price",
          fromCents: 4000,
          toCents: 7000,
          fromCurrency: "EUR",
          toCurrency: "EUR",
        },
        you,
      ).replace(/ | /g, " "),
    ).toBe("Prix : 40,00 € → 70,00 €");
    expect(
      describeChange({ type: "client", fromName: "Inès", toName: null }, you),
    ).toBe("Cliente : Inès → une autre cliente");
    expect(
      describeChange({ type: "staff", fromName: null, toName: "Léa" }, you),
    ).toBe("Avec : personne en particulier → Léa");
    expect(
      describeChange({ type: "status", from: "confirmed", to: "no_show" }, lea),
    ).toBe("Statut : Confirmé → Absente");
    expect(describeChange({ type: "notes" }, you)).toBe(
      "Note interne modifiée",
    );
    expect(describeChange({ type: "untracked" }, you)).toContain(
      "détail non enregistré",
    );
  });
});
