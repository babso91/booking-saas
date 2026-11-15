# Séries de rendez-vous — contrat proposé (M2-R07)

Statut : **proposé par l'UI, non implémenté**. Le planificateur existe
(`src/features/series/`) et ne tourne que dans `/apercu/serie`, contre un
serveur en mémoire. Aucune page réelle ne propose de série tant que ce
contrat n'est pas servi. Verrou d'établissement, disponibilités, quote,
tables (`appointment_series`, lien nullable sur les rendez-vous) et
événements restent ceux de Cloud.

## Aperçu (ne réserve rien)

```ts
SeriesPreviewInput = {
  clientId: string;
  serviceId: string;
  optionChoiceIds: string[];
  firstLocalStart: string;            // heure murale, fuseau de l'établissement
  repeatEveryWeeks: number;           // entier ≥ 1
  end: { count: number } | { untilLocalDate: string };
};
SeriesPreview = {
  previewVersion: string;             // prouve la règle et les choix d'origine
  timeZone: string;
  quote: { serviceName: string; durationMinutes: number; priceCents: number };
  occurrences: {
    key: string;                      // stable : série + rang
    requestedLocalStart: string;
    utcCandidates: string[];
    state: "available" | "conflict" | "ambiguous" | "nonexistent" | "outside_horizon";
  }[];
};
```

- Au plus **12** occurrences : au-delà, `too_many_occurrences` (l'écran le
  dit avant tout aperçu).
- Une répétition garde l'**heure civile** ; l'instant UTC peut changer.
- `ambiguous` (passage à l'heure d'hiver) : deux instants, le plus tôt
  d'abord ; l'écran exige un choix explicite.
- `nonexistent` (passage à l'heure d'été) : **proposition** : le serveur
  renvoie dans `utcCandidates` une heure de remplacement suggérée (même
  heure + 1 h), que la pro peut accepter ; sinon elle retire la date. À
  confirmer par Cloud.
- `conflict`, `outside_horizon` : affichés, comptés, jamais retenus,
  jamais écartés en silence.

## Confirmation (tout ou rien)

```ts
SeriesCommitInput = { requestId, previewVersion, selected: { key, startsAt }[] }
→ { seriesId, appointmentIds[] }
```

- Sous le verrou de l'établissement : revalider quote, occupation, fenêtres
  et collisions internes du lot ; **une seule occurrence en échec fait
  échouer tout le lot**.
- Même `requestId` + même contenu → même réponse ; contenu différent →
  `idempotency_conflict`. L'écran garde un `requestId` par contenu.
- Les occurrences deviennent des rendez-vous ordinaires (snapshots propres,
  lien de série stable) ; l'annulation de l'une ne touche pas les autres.

## Refus nommés

| Code                   | Ce que l'écran fait                                                             |
| ---------------------- | ------------------------------------------------------------------------------- |
| `calendar_conflict`    | (+ `keys`) « rien n'a été créé », recalcule, signale « À revoir » sur ces dates |
| `quote_changed`        | « rien n'a été créé », recalcule et affiche le nouveau prix/durée               |
| `series_stale`         | « rien n'a été créé », recalcule                                                |
| `too_many_occurrences` | Le dit, sans aperçu                                                             |
| réseau / autre         | Réessai avec le même `requestId` ; « rien n'a été enregistré »                  |

Changer la règle après un aperçu l'efface : on ne peut pas confirmer un
aperçu qui ne correspond plus à ce qui est affiché.

## Recette couverte côté écran

Paris, ancre dimanche 18 octobre 2026 à 02:30, hebdomadaire : le 25 octobre
propose `00:30Z` et `01:30Z`, choix explicite. Série incluant le 29 mars
2026 à 02:30 : autre heure ou exclusion. Conflit pendant la confirmation :
rien de créé, dates réaffichées. Réponse perdue : une seule série.
