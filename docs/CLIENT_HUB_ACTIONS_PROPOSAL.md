# Client Hub — annuler et déplacer un rendez-vous (proposition UI → Cloud)

**Statut : PROPOSÉ.** Rien de ce document n'est servi par le backend. Il décrit ce que l'interface attend, pour que Cloud le valide, le corrige ou le remplace. Une fois le contrat arrêté, il rejoint `CLIENT_HUB_CONTRACT.md` et ce fichier disparaît.

L'interface est écrite contre cette proposition et **n'affiche rien de nouveau tant que le serveur ne l'envoie pas** : sans `actions` dans le détail d'un rendez-vous, la cliente voit le message actuel (« contactez l'établissement »).

## 1. Ce que le détail d'un rendez-vous ajoute

`GET /api/client-hub/businesses/:businessId/appointments/:appointmentId` renvoie en plus, pour un rendez-vous `confirmed` à venir :

```ts
actions?: {
  version: number; // version du rendez-vous, renvoyée telle quelle dans expectedVersion
  cancel: Action;
  reschedule: Action;
} | null;

type Action = {
  allowed: boolean;
  deadlineAt: string | null; // dernier instant autorisé (ISO), null si aucun
  reason: "policy_cutoff_passed" | "policy_unavailable" | "appointment_not_editable" | null;
};
```

- Le serveur décide seul de `allowed` (état, délai de la politique figée avec le rendez-vous, heure du serveur). L'interface n'en recalcule rien.
- `actions` absent ou `null` : rien n'est modifiable depuis l'espace.
- `reason` n'est lu que si `allowed` est faux. `policy_unavailable` couvre un rendez-vous sans politique structurée : la cliente est renvoyée vers l'établissement.

## 2. Les trois routes

| Route                                     | Corps ou paramètres                        | Réponse                                    |
| ----------------------------------------- | ------------------------------------------ | ------------------------------------------ |
| `POST …/appointments/:id/cancel`          | `{ requestId, expectedVersion }`           | le détail du rendez-vous après annulation  |
| `POST …/appointments/:id/reschedule`      | `{ requestId, expectedVersion, startsAt }` | le détail du rendez-vous après déplacement |
| `GET …/appointments/:id/reschedule-slots` | `?date=YYYY-MM-DD` (jour civil du lieu)    | `{ date, timezone, slots }`                |

- `slots` a la forme des créneaux publics : `{ startsAt, endsAt, localStartsAt, localEndsAt }`. Le créneau actuel du rendez-vous n'y figure pas ; son propre intervalle ne le bloque pas.
- Même prestation, mêmes options, même prix : un déplacement ne change que l'horaire.
- Comme les autres routes du Hub : même origine, JSON seulement, en-tête `X-Client-Hub-Account` sur toute réponse privée, 401 et 404 inchangés.

## 3. Ce que l'interface suppose

- **Idempotence par `requestId`.** L'interface renvoie le même `requestId` après une réponse perdue. La même demande ne doit jamais annuler ou déplacer deux fois, et sa réponse est l'état actuel du rendez-vous. Une autre demande (autre créneau) porte un nouvel identifiant.
- **Rien n'est changé par un refus.** L'ancien rendez-vous reste confirmé à son horaire.
- **Aucun GET ne vaut confirmation.** Le succès affiché vient de la réponse du POST ; le détail est ensuite relu.

## 4. Refus attendus (409 sauf mention)

| Code                       | Ce que fait l'interface                                                               |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `slot_unavailable`         | « Ce créneau vient d'être pris », l'ancien horaire est conservé, le jour est relu     |
| `policy_cutoff_passed`     | « Le délai est passé », le rendez-vous est relu (ses `actions` disent alors pourquoi) |
| `stale_appointment`        | « Ce rendez-vous a changé », le rendez-vous est relu                                  |
| `appointment_not_editable` | comme `stale_appointment`                                                             |
| `idempotency_conflict`     | « Demande déjà traitée autrement », le rendez-vous est relu                           |
| `rate_limited` (429)       | « Trop de demandes », rien d'autre                                                    |
| pas de réponse             | « Pas de réponse », nouvel essai avec le même `requestId`                             |

Les trois premiers codes de la colonne `reason` et `stale_appointment` n'existent pas tous dans `src/lib/errors.ts` : à ajouter côté Cloud avec leurs statuts.

## 5. Questions ouvertes pour Cloud

1. Les noms des routes et de `reschedule-slots` conviennent-ils, ou préfères-tu un paramètre sur la route de disponibilité existante ?
2. Jusqu'où peut-on déplacer : le même horizon que la réservation publique ? L'interface propose aujourd'hui huit semaines et affiche ce que le serveur renvoie.
3. Faut-il une confirmation par email après annulation ou déplacement ? L'interface n'en promet aucune.
4. Le texte de la politique (`cancellationPolicy`) reste-t-il le texte libre actuel, ou un rendu du délai structuré ?

## 6. Où c'est dans le code

- Types : `src/features/client-hub/types.ts` (`ClientHubAppointmentActionsDto`, `ClientHubSlotDto`).
- Appels : `src/features/client-hub/client/api.ts` (`cancelAppointment`, `rescheduleAppointment`, `fetchRescheduleSlots`).
- Écran : `src/features/client-hub/components/appointment-actions.tsx`, monté par `appointment-detail.tsx`.
- Tests : `appointment-actions.test.tsx` (14 cas, faux serveur).
- Aperçu sans backend : `/apercu/espace` (`?etat=ouvert|ferme|sans`), données fictives en mémoire (`src/features/client-hub/preview/`). Absent de la production.
