# Lieux et praticiennes à la réservation — contrat proposé (M6-R02, côté cliente)

Statut : **proposé par l'UI, non implémenté**. Le parcours existe
(`src/features/locations/`) et ne tourne que dans `/apercu/lieux`, contre un
serveur en mémoire. La réservation publique réelle garde son parcours solo
tant que ce contrat n'est pas servi. Lieux, occupations (personne, cabine),
exclusion SQL, verrou `business_schedule` et rétrocompatibilité des routes
restent ceux de Cloud.

Hors de cette tranche : les colonnes par personne dans l'agenda pro et la
raison d'un conflit côté pro.

## Mise en place

`setup(serviceId)` → `{ locations: { id, name, address }[]; staff: { id, displayName, locationIds[] }[] }`

Personnes publiques **minimales** (nom affiché, lieux où elles font cette
prestation). Les cabines restent internes : jamais montrées.

## Disponibilités

`availability({ serviceId, locationId, staffPreference })`

```ts
staffPreference = { kind: "any" } | { kind: "staff"; staffId: string };
→ { slots: { startsAt: string; offsetMinutes: number; locationId: string }[]; scheduleRevision: string }
```

- `any` : l'union des créneaux des personnes du lieu ; `staff` : uniquement
  les siens.
- L'écran affiche l'heure locale du lieu via `offsetMinutes` (aucun calcul
  de fuseau côté client).

## Retenue d'un créneau

`hold({ serviceId, locationId, staffPreference, startsAt, scheduleRevision, requestId })`
→ `{ holdId, expiresAt, staffDisplayName | null }`

- Une préférence nominative n'est **jamais remplacée** : si elle n'est plus
  libre, `slot_unavailable`, même si une autre personne l'est.
- En `any`, priorité configurée puis ID stable ; la personne n'est nommée à
  la cliente que si elle l'a choisie (`staffDisplayName` sinon `null`).
- `configuration_changed` : `scheduleRevision` périmée (horaires, prestation).
- Même `requestId` → même réponse.

## Refus nommés

| Code                    | Ce que l'écran fait                                                         |
| ----------------------- | --------------------------------------------------------------------------- |
| `slot_unavailable`      | « Ce créneau vient d'être pris », lieu et prestation gardés, créneaux relus |
| `configuration_changed` | « Les horaires viennent de changer », lieu et prestation gardés, relus      |
| `location_unavailable`  | Motif borné, sans détail                                                    |
| réseau / autre          | Réessai avec le même `requestId`                                            |

## Parcours

Lieu → personne → jour. Un seul lieu saute « Où ? » ; une seule personne
au lieu saute « Avec qui ? » (le solo reste identique). « Première
disponibilité » est un choix explicite. Sans créneau avec la personne
choisie, l'écran **propose** de voir la première disponibilité, sans
basculer seul.
