# Facturation, résiliation et factures — contrat proposé (M7-R03, interface)

Statut : **proposé par l'UI, non implémenté**. La page existe
(`src/features/billing/`) et ne tourne que dans
`/apercu/facturation?etat=actif|impaye|termine`, contre un serveur en
mémoire. **Aucun prestataire de paiement n'est relié ; aucun document n'est
une vraie facture.** Inbox de webhooks, projection d'abonnement et de
factures, vendeur légal et TVA restent ceux de Cloud (et du boss pour tout
choix payant ou juridique).

## Résumé

`summary()` →

```ts
type BillingSummary = {
  plan: "core" | "signature";
  state: "trialing" | "active" | "past_due" | "ended";
  revision: number;
  renewsAt: string | null;
  graceUntil: string | null; // past_due : droits gardés jusqu'à cette date
  cancellation: { effectiveAt: string; requestedAt: string } | null;
  upcomingAppointments: number; // pour l'écran de résiliation
  simulated: boolean;
};
```

La résiliation programmée est un **attribut** : l'état reste `active`
jusqu'au terme. Un impayé n'est montré qu'à la pro, jamais publiquement ;
rendez-vous, rappels et site continuent pendant la grâce.

## Factures

`invoices()` → `{ invoiceId, periodStart, periodEnd, status: "preparing" | "issued" | "unavailable", amountMinor: number | null, currency, simulated }[]`

Montant figé à l'émission ; **inconnu = `null`, jamais 0** (l'écran
affiche « — »). Un document simulé est étiqueté comme tel.

## Actions

| Action                | Entrée                          | Effet                                                                  |
| --------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| `requestCancellation` | `expectedRevision, operationId` | Programme la fin au terme ; renvoie `receiptId`                        |
| `undoCancellation`    | `expectedRevision, operationId` | Retire la résiliation tant qu'elle n'a pas pris effet                  |
| `openPortal`          | —                               | Lien éphémère vers le portail ; `billing_unavailable` sans prestataire |

Refus : `billing_state_changed` (l'écran relit, « rien n'a été modifié »),
`permission_denied`, `billing_unavailable`. Même `operationId` → même
reçu.

## Avant de confirmer une résiliation, l'écran dit

Jusqu'à quand l'abonnement reste actif, que rien n'est remboursé ni débité
en plus, ce que deviennent les N rendez-vous à venir (gardés avec leurs
rappels jusqu'au terme), que le site n'accepte plus de réservations
ensuite, que les factures restent consultables, et qu'on peut annuler la
résiliation jusqu'au terme. **À valider par le boss** (contrat et
conditions générales).
