# Relances et réactivation — contrat proposé (R4-01, tranche campagne)

Statut : **proposé par l'UI, non implémenté**. Les écrans existent
(`src/features/growth/`) et ne tournent que dans `/apercu/relance`, contre un
serveur en mémoire. **Aucun message ne part** : le transport reste simulé
tant que preuves de consentement, désinscription, identité d'expéditeur et
autorisation de budget ne sont pas validées. Segments, file marketing
isolée du transactionnel, verrous, budget et transport restent ceux de
Cloud.

Hors de cette tranche : le tableau de rétention par cohorte, la
recommandation d'heure creuse, la page de désinscription.

## Critères V1 (fermés)

```ts
AudienceCriteria =
  | { kind: "rebooking"; serviceIds: string[]; afterDays: number }   // dernière prestation complétée de ces services, il y a ≥ N jours
  | { kind: "reactivation"; inactiveDays: number };                  // aucune visite complétée depuis ≥ N jours
```

Jamais de notes, réponses, images ni champ sensible. Toujours écartées :
rendez-vous à venir, dernière visite non complétée, pas de consentement
pour le canal, pas de coordonnée, contact récent (cadence).

## Estimation

`estimate({ criteria, channel, message })` →

```ts
{
  estimateId: string;
  matched: number;
  eligible: number;
  suppressedByReason: Partial<
    Record<
      | "future_appointment"
      | "no_consent"
      | "unreachable"
      | "recent_contact"
      | "last_visit_not_completed",
      number
    >
  >; // agrégé : jamais de nom
  estimatedUnits: number; // SMS : unités GSM/UCS-2 par cliente × éligibles
  estimateExpiresAt: string;
  timeZone: string;
  simulated: boolean; // vrai tant que le transport est simulé
}
```

L'écran efface l'estimation dès qu'un critère, le canal ou le message
change.

## Planification

`schedule({ estimateId, maxUnits, requestId })` → `CampaignDto`

- `estimate_stale` : estimation périmée ou contenu changé → l'écran le dit,
  « rien n'a été planifié », et réestime.
- `quota_exceeded` : plafond au-delà du budget restant.
- Même `requestId` → même réponse. L'écran garde un `requestId` par
  `estimateId × plafond`.
- Juste avant chaque remise, le serveur relit dernière visite, rendez-vous
  futur, consentement, cadence et budget (l'écran le dit à la
  confirmation).

## Suivi

```ts
CampaignDto = {
  campaignId; version; state: "scheduled" | "running" | "paused" | "completed" | "cancelled";
  channel; maxUnits; unitsUsed;
  counts: { pending; handedOff; accepted; uncertain; failed; suppressed };
  suppressedByReason;                   // agrégé
  attributedBookings; attributionWindowDays;
  simulated;
};
```

`setState({ campaignId, expectedVersion, requestId, action: "pause" | "resume" | "cancel" })`

- La pause distingue **en attente** (ne partiront pas) et **déjà remis**
  (peuvent encore arriver).
- « Accepté » = pris en charge par le prestataire, pas reçu.
- `uncertain` (réponse perdue après remise) : aucun nouvel essai avant
  rapprochement par clé de livraison.
- Réservations attribuées : référence de campagne + fenêtre déclarée ;
  **aucune causalité** affichée.
- `version_conflict` : l'écran relit et le dit.

## Recette couverte côté écran

Horloge fixe ; C1 (rendez-vous futur), C2 (consentante, inactive), C3
(désabonnée), C4 (dernière visite manquée) : seule C2 passe, les autres sont
comptées par motif. Estimation périmée, budget dépassé, réponse perdue (une
seule campagne), pause et annulation, conflit de version.
