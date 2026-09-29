# Contrat backend — agenda professionnel V1

Contrat entre le backend et l'interface de l'agenda (`/app`). Toutes les opérations sont des Server Actions de `src/features/agenda/actions/agenda.ts`. Elles s'importent dans un Client Component et s'appellent comme une fonction asynchrone.

Le frontend n'appelle jamais Supabase directement pour lire ou modifier l'agenda.

Chaque action renvoie le même `ActionResult` que l'authentification (voir `docs/AUTH_ONBOARDING_CONTRACT.md`) :

```ts
type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: AppErrorCode;
        message: string;
        fieldErrors?: Record<string, string[]>;
      };
    };
```

Aucune action ne lève d'exception vers l'UI, et aucune erreur PostgreSQL ou Supabase (SQLSTATE, message brut) n'est exposée.

## Sécurité

- **Business dérivé de la session.** Chaque action authentifie la session, puis résout le business depuis `business_members`, puis valide l'entrée.
- **Aucun identifiant de business accepté.** Un champ `businessId` envoyé par le navigateur est ignoré, retiré par la validation.
- **Double contrôle de l'appartenance.** Les fonctions SQL vérifient `auth.uid()` et l'appartenance au business avant toute lecture, en plus de RLS.
- **Identifiants d'un autre tenant.** Un identifiant (rendez-vous, bloc, cliente, prestation) appartenant à un autre business renvoie `*_not_found` ou `service_unavailable`, jamais ses données.
- **Écriture directe impossible.** Un professionnel n'a aucune politique d'écriture directe sur `appointments`. Les rendez-vous ne changent que via les fonctions de l'agenda ou la réservation publique.
- **Lecture bornée.** Aucune action ne permet de lire l'agenda d'un business arbitraire. Une plage est limitée à 42 jours et à 800 rendez-vous.
- **Session.** Une session absente donne `unauthenticated`. Un compte sans business, par exemple après retrait du membership, donne `no_business`.

## Fuseau horaire

- **Heures d'entrée.** Toutes les dates et heures reçues sont des heures murales dans le fuseau du business (`businesses.timezone`) : `date` au format `YYYY-MM-DD`, `time` au format `HH:MM`, date-heure au format `YYYY-MM-DDTHH:MM`.
- **Stockage.** La base conserve des instants `timestamptz`.
- **Conversion centralisée.** Elle est faite côté serveur (`src/lib/time/zoned.ts`), avec les mêmes règles que PostgreSQL et que la réservation publique.
- **Sorties.** Chaque instant est renvoyé deux fois : `startsAt` (UTC, ISO 8601) et `localStartsAt` (heure murale du business). L'UI affiche `local*` et ne convertit jamais elle-même.
- **Heure inexistante.** Une heure sautée au passage à l'heure d'été (02:30 le dernier dimanche de mars à Paris) est refusée à la création et au déplacement d'un rendez-vous, avec `validation_error` et `fieldErrors.time`.
- **Heure ambiguë.** Une heure qui existe deux fois à l'automne est lue comme la plus tardive, en heure d'hiver.
- **Jours.** Un jour local va de 00:00 à 00:00 le lendemain, en intervalle semi-ouvert. Un jour de changement d'heure dure donc 23 ou 25 heures.

## Actions

### Lecture

| Action                              | Entrée                                      | Succès (`data`)                         |
| ----------------------------------- | ------------------------------------------- | --------------------------------------- |
| `getAgendaAction(input)`            | `{ startDate, endDate, includeCancelled? }` | `AgendaDto`                             |
| `getAgendaAppointmentAction(input)` | `{ appointmentId }`                         | `AgendaAppointmentDto`                  |
| `listAgendaServicesAction()`        | —                                           | `{ services, bufferMinutes, currency }` |
| `searchAgendaClientsAction(input)`  | `{ query }` (2 à 100 caractères)            | `AgendaClientDto[]` (10 au maximum)     |

Paramètres de `getAgendaAction` :

- `startDate` et `endDate` sont des jours locaux **inclus**, soit 1 à 42 jours ;
- `includeCancelled` vaut `false` par défaut : les rendez-vous annulés sont masqués.

Un rendez-vous est inclus s'il chevauche la plage.

```ts
type AgendaDto = {
  timezone: string;
  range: {
    startDate: string;
    endDate: string;
    startsAt: string;
    endsAt: string;
  };
  appointments: AgendaAppointmentDto[]; // triés par début
  blocks: AgendaBlockDto[]; // closed + blocked qui chevauchent la plage
  workingHours: {
    weekly: { id: string; weekday: number; startsAt: string; endsAt: string }[];
    days: {
      date: string; // jour local
      weekday: number; // 0 = dimanche … 6 = samedi
      openRanges: {
        startsAt: string;
        endsAt: string;
        localStartsAt: string;
        localEndsAt: string;
      }[];
    }[];
  };
};

type AgendaAppointmentDto = {
  id: string;
  version: number; // à renvoyer comme expectedVersion
  status: "confirmed" | "completed" | "cancelled" | "no_show";
  startsAt: string;
  endsAt: string;
  localStartsAt: string;
  localEndsAt: string;
  durationMinutes: number;
  bufferMinutes: number; // temps libre après le rendez-vous
  service: { id: string; name: string };
  client: { id: string; displayName: string };
  internalNotes: string | null;
  cancellationReason: string | null;
  source: "public" | "manual";
  createdAt: string;
  updatedAt: string;
};

type AgendaBlockDto = {
  id: string;
  version: number;
  kind: "blocked" | "closed";
  startsAt: string;
  endsAt: string;
  localStartsAt: string;
  localEndsAt: string;
  reason: string | null;
};

type AgendaClientDto = {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
};
```

Le rendez-vous ne contient volontairement ni le prix ni les coordonnées de la cliente. `searchAgendaClientsAction` renvoie l'email et le téléphone, car il faut pouvoir distinguer deux homonymes.

`workingHours.days` est calculé côté serveur jour par jour :

- ce sont les horaires hebdomadaires plus les ouvertures exceptionnelles (`open_override`), limitées au jour ;
- une plage vidée par le passage à l'heure d'été est ignorée ce jour-là, comme dans le calcul des créneaux publics.

### Rendez-vous

| Action                              | Entrée                                                                                | Succès (`data`)                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `createAppointmentAction(input)`    | `{ date, time, serviceId, client, internalNotes?, requestId? }`                       | `{ appointment: AgendaAppointmentDto, created: boolean }` |
| `updateAppointmentAction(input)`    | `{ appointmentId, expectedVersion, date, time, serviceId, clientId, internalNotes? }` | `AgendaAppointmentDto`                                    |
| `setAppointmentStatusAction(input)` | `{ appointmentId, expectedVersion, status, cancellationReason? }`                     | `AgendaAppointmentDto`                                    |
| `cancelAppointmentAction(input)`    | `{ appointmentId, expectedVersion, reason? }`                                         | `AgendaAppointmentDto`                                    |

Champ `client` de la création :

```ts
type AppointmentClient =
  | { type: "existing"; clientId: string }
  | {
      type: "new";
      firstName: string;
      lastName?: string;
      email?: string;
      phone?: string;
    };
```

**Création manuelle.**

- **Ce que le serveur calcule.** Il déduit du service **actif** la durée, la fin, le nom et le prix. Il déduit des réglages le buffer et la devise. Le business vient de la session. Une durée ou une fin envoyée par le navigateur est ignorée.
- **Placement.** Les horaires d'ouverture, le délai minimum et l'horizon maximum sont des règles de réservation pour les clientes. Ils ne s'appliquent pas à la professionnelle, qui peut placer un rendez-vous hors horaires ou dans le passé.
- **Chevauchements.** Ils sont toujours refusés : avec un autre rendez-vous, buffer compris, et avec un bloc ou une fermeture.
- **Nouvelle cliente.** Seul le prénom est obligatoire ; l'email et le téléphone sont facultatifs.
- **Email déjà connu.** Un email déjà connu **dans ce business** réutilise la fiche existante sans la modifier, comme la réservation publique. Il n'y a pas de déduplication par téléphone ni par nom en V1.
- **`requestId`.** C'est un UUID généré une fois par formulaire. Une seconde soumission avec le même `requestId` renvoie le même rendez-vous avec `created: false`. Sans `requestId`, une seconde soumission identique est refusée par le chevauchement (`schedule_conflict`).
- **Emails.** Aucun email n'est envoyé : les notifications ne font pas partie de la V1.

**Modification et déplacement** (`updateAppointmentAction`) :

- **État complet.** L'entrée est l'état complet des champs modifiables, tel qu'affiché dans le formulaire. `internalNotes` absent ou `null` efface la note.
- **Statut.** L'heure, la prestation et la cliente ne se modifient que si le rendez-vous est `confirmed` ; sinon `appointment_not_editable`. La note interne se modifie toujours.
- **Même prestation.** La durée, le prix et le buffer réservés sont conservés, même si le catalogue a changé depuis.
- **Nouvelle prestation.** La durée, le nom et le prix sont repris de la prestation (qui doit être active). Le buffer et la devise viennent des réglages actuels.
- **Déplacement vers un créneau occupé.** Il donne `schedule_conflict`, et le rendez-vous reste inchangé.

## Statuts

| Depuis      | Vers autorisé                       | Remarque                                                        |
| ----------- | ----------------------------------- | --------------------------------------------------------------- |
| `confirmed` | `cancelled`, `completed`, `no_show` | `completed` / `no_show` seulement si le rendez-vous a commencé  |
| `no_show`   | `confirmed`, `completed`            | correction                                                      |
| `completed` | `confirmed`                         | correction, refusée si des points de fidélité ont été attribués |
| `cancelled` | —                                   | terminal : créer un nouveau rendez-vous                         |

- Toute autre transition donne `invalid_status_transition`.
- Redemander le statut actuel est un succès sans effet, ce qui absorbe un double clic.
- **Occupation.** Seule l'annulation libère le créneau : la contrainte `appointments_no_overlap` ignore les lignes `cancelled`. `completed` et `no_show` continuent d'occuper leur créneau.
- **Annulation.** Elle ne supprime jamais la ligne. `cancellationReason` est enregistré.

## Blocs d'indisponibilité

| Action                     | Entrée                                            | Succès (`data`)  |
| -------------------------- | ------------------------------------------------- | ---------------- |
| `createBlockAction(input)` | `BlockInput`                                      | `AgendaBlockDto` |
| `updateBlockAction(input)` | `{ blockId, expectedVersion, block: BlockInput }` | `AgendaBlockDto` |
| `deleteBlockAction(input)` | `{ blockId, expectedVersion }`                    | `undefined`      |

```ts
type BlockInput =
  | {
      allDay: false;
      startsAt: "YYYY-MM-DDTHH:MM";
      endsAt: "YYYY-MM-DDTHH:MM";
      reason?: string;
    }
  | {
      allDay: true;
      startDate: "YYYY-MM-DD";
      endDate: "YYYY-MM-DD";
      reason?: string;
    }; // jours inclus
```

- **Stockage.** Un bloc est une `availability_exception` de type `blocked`, créée par l'agenda. L'agenda affiche, modifie et supprime aussi les fermetures `closed` créées dans les réglages. Les ouvertures exceptionnelles `open_override` n'y sont pas modifiables : `block_not_found`.
- **Chevauchement.** Un bloc qui chevaucherait un rendez-vous non annulé est refusé avec `schedule_conflict`. Un rendez-vous n'est jamais déplacé ni annulé automatiquement.
- **Adjacence.** Un bloc peut commencer exactement à la fin d'un rendez-vous : le buffer n'est exigé qu'entre deux rendez-vous.

## Concurrence

- **Verrou de planning.** Toute écriture qui ajoute de l'occupation (création, déplacement, changement de prestation, création ou déplacement de bloc) prend le verrou de planning du business. C'est le même verrou que la réservation publique : deux écritures concurrentes sont sérialisées, et la seconde voit la première.
- **Garanties finales.** Elles sont en base :
  - la contrainte d'exclusion GiST `appointments_no_overlap`, buffer compris ;
  - les triggers rendez-vous ↔ blocs.
- **Résultat.** Deux créations simultanées du même créneau donnent un seul rendez-vous et un `schedule_conflict`. Il en va de même pour un rendez-vous et un bloc créés simultanément.
- **Édition obsolète.** Chaque rendez-vous et chaque bloc porte une `version`, incrémentée à chaque modification quel que soit le chemin. Les modifications, changements de statut, déplacements et suppressions exigent `expectedVersion`, la version chargée par l'UI. Si l'élément a changé entre-temps, l'action renvoie `stale_appointment` ou `stale_block` et rien n'est écrasé. L'UI doit alors recharger l'élément et le proposer à nouveau.

## Codes d'erreur

| Code                        | HTTP | Quand                                                                      |
| --------------------------- | ---- | -------------------------------------------------------------------------- |
| `unauthenticated`           | 401  | pas de session                                                             |
| `no_business`               | 403  | session sans business (membership retiré)                                  |
| `forbidden`                 | 403  | business non autorisé (ne devrait pas arriver via les actions)             |
| `validation_error`          | 400  | entrée invalide, plage trop longue, heure inexistante ; voir `fieldErrors` |
| `appointment_not_found`     | 404  | rendez-vous inconnu de ce business                                         |
| `block_not_found`           | 404  | bloc inconnu de ce business (ou ouverture exceptionnelle)                  |
| `client_not_found`          | 404  | cliente inconnue de ce business                                            |
| `service_unavailable`       | 409  | prestation inconnue de ce business ou désactivée                           |
| `schedule_conflict`         | 409  | chevauchement avec un rendez-vous (buffer compris) ou un bloc              |
| `stale_appointment`         | 409  | rendez-vous modifié depuis son chargement                                  |
| `stale_block`               | 409  | bloc modifié depuis son chargement                                         |
| `invalid_status_transition` | 409  | transition de statut non autorisée                                         |
| `appointment_not_editable`  | 409  | déplacement ou changement d'un rendez-vous non confirmé                    |
| `internal`                  | 500  | erreur inattendue ; détail uniquement dans les logs serveur                |

## Hors périmètre V1

- Google et Microsoft Calendar ;
- drag and drop ;
- plusieurs employées ;
- paiement ;
- emails de notification ;
- fidélité ;
- CRM complet ;
- statistiques ;
- liste d'attente.

L'intégration calendrier aura son propre modèle d'événements externes (`docs/ARCHITECTURE.md`, §8 bis). Elle ne passera pas par ces tables.
