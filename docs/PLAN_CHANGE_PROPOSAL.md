# Changement de formule — contrat proposé (M7-R02)

Statut : **proposé par l'UI, non implémenté**. L'écran existe
(`src/features/plan-change/`) et ne tourne que dans `/apercu/changer-formule`,
contre un serveur en mémoire aux prix provisoires. **Aucun paiement ne peut
partir** : aucun prestataire n'est relié, et le brancher est une décision du
boss (coûts, intégration payante). Le port `PlatformBillingGateway`, les
commandes, l'outbox et les webhooks restent ceux de Cloud.

## Lecture

`current()` → `{ plan, cadence, revision, pending: PlanChange | null }`

## Devis (immuable, court)

`quote({ targetPlan, targetCadence, expectedSubscriptionRevision, promoCode? })`

```ts
type BillingQuote = {
  quoteId: string;
  currency: string;
  current: { plan: "core" | "signature"; cadence: "monthly" | "yearly" };
  target: {
    plan: "core" | "signature";
    cadence: "monthly" | "yearly";
    priceVersionId: string;
  };
  dueNowMinor: number;
  nextCharge: { at: string; amountMinor: number };
  recurring: { amountMinor: number; cadence: "monthly" | "yearly" };
  effective:
    { mode: "after_verified_payment" } | { mode: "end_of_period"; at: string };
  expiresAt: string;
  revision: number;
  simulated: boolean;
};
```

Montée : immédiate **après paiement vérifié** ; descente ou changement de
cadence : en fin de période. L'écran affiche maintenant / prochain débit /
ensuite séparément et ne recompose jamais un montant.

## Confirmation

`confirm({ quoteId, expectedRevision, operationId })` → `{ commandId, status, target, effectiveAt }`

- `status` : `requested` (paiement à vérifier) | `requires_action` (SCA) |
  `scheduled` (fin de période) | `applied` | `failed`. **Aucun droit avant
  `applied`.**
- Un seul changement non résolu par abonnement.
- Même `operationId` + même devis → même reçu.

`cancelScheduled({ commandId, operationId })` annule un changement
programmé.

## Refus nommés

| Code                    | Ce que l'écran fait                               |
| ----------------------- | ------------------------------------------------- |
| `billing_state_changed` | Relit l'abonnement, « rien n'a été demandé »      |
| `quote_expired`         | Demande de redemander le devis                    |
| `billing_unavailable`   | « Paiement indisponible, rien n'a été demandé »   |
| `promo_unavailable`     | Code refusé, devis sans promotion                 |
| `permission_denied`     | « Seule la propriétaire peut changer de formule » |
