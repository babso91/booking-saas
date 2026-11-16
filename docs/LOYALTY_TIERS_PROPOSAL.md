# Fidélité : niveaux VIP et parrainage (proposition UI → Cloud)

**Statut : PROPOSÉ.** Rien de ce document n'est servi par le backend. Les composants existent (`src/features/loyalty/tiers/`), testés contre des données en mémoire. **Ils ne sont montés dans aucune page réelle**, seulement dans `/apercu/fidelite-vip`.

## 1. Niveaux

- Un niveau s'obtient par des **visites terminées dans une fenêtre**, indépendamment du solde de points : dépenser des points ne fait jamais baisser le niveau.
- Le même composant sert la fiche cliente côté pro et l'espace de la cliente (« vous »). Il place la cliente entre deux niveaux, mais ne compte rien lui-même.

```ts
getTierProgressAction({ clientId }) → {
  tiers: { id, name, threshold, perk | null }[]; // seuils en visites terminées
  tierId: string | null;                         // niveau atteint
  currentValue: number;                          // visites comptées dans la fenêtre
  windowEnd: string;                             // fin de la fenêtre de comptage
  ruleVersion: number;
}
```

Affichage : le niveau atteint, une barre de progression accessible vers le suivant, les visites manquantes, l'avantage du suivant (côté cliente), la date de fin de comptage.

## 2. Parrainage (espace de la cliente)

- La cliente obtient **son** lien et le partage elle-même. Aucun formulaire ne permet d'écrire à une tierce personne : rien n'est envoyé depuis l'écran.
- La récompense est créditée par le serveur après la première visite de la personne parrainée.

```ts
getReferralLink() → { url, expiresAt, state: "active" | "expired" | "revoked" } | null
createReferralLinkAction({ requestId }) → { url, expiresAt, state }
```

- `requestId` : une nouvelle tentative après une réponse perdue ne crée qu'un seul lien.
- Un lien expiré ou révoqué n'est plus affiché ; la cliente peut en demander un nouveau.

## 3. Pas encore couvert

- L'écran pro des parrainages (historique, état de la prime, correction tracée).
- La réservation arrivée par un lien de parrainage (attribution) : côté réservation publique, un lien expiré doit mener au catalogue sans attribution.
- La configuration des niveaux par la professionnelle (seuils, fenêtre, avantages).

## 4. Questions pour Cloud

1. Où la professionnelle définit-elle les niveaux, et qui les voit (Client Hub seulement ou aussi la fiche) ?
2. Le lien de parrainage pointe-t-il vers la page publique avec un paramètre, ou vers une route dédiée ?
3. Le solde négatif prévu par le registre de fidélité doit-il être affiché à côté du niveau ?

## 5. Où c'est dans le code

- Contrat proposé : `src/features/loyalty/tiers/contract.ts`.
- Placement : `progress.ts` ; carte : `tier-progress.tsx` ; parrainage : `referral-card.tsx`.
- Données en mémoire : `memory-actions.ts`. Tests : `tiers.test.tsx` (8).
