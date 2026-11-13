# Offres Core et Signature (proposition UI → Cloud)

**Statut : PROPOSÉ pour les prix ; RÉEL pour l'offre actuelle.** Ce document décrit ce que l'interface attend pour lister les offres, pour que Cloud le valide, le corrige ou le remplace.

## 1. Ce qui est réel aujourd'hui

- **`/app/offre`** (« Mon offre ») affiche l'offre de la professionnelle telle que le serveur la garde : `sites.plan`, Core par défaut pour un établissement sans site. Elle affiche aussi ce que chaque offre permet, dans les termes du Studio (`plans.ts` ; la lentille de rendu est celle de `renderedFor`).
- On y accède par le badge « Mode Simple / Créatif » du Studio.
- **Aucun prix n'y est affiché, et aucune souscription n'y est possible.** La page dit que changer d'offre n'est pas encore possible en ligne, et que revenir à Core ne supprime aucun réglage Signature.

## 2. Ce qui attend le backend : la liste des offres

L'écran de comparaison (choix mensuel ou annuel, total réel, équivalent mensuel, mois offerts) existe déjà. Il ne s'affiche que si le serveur fournit :

```ts
listOffers() → {
  offers: {
    planCode: "core" | "signature";
    priceVersionId: string; // version commerciale du prix
    cadence: "month" | "year";
    amountMinor: number;    // en centimes
    currency: string;
    displayTaxMode: "ttc" | "ht";
  }[];
  catalogRevision: string;
}
```

- Les montants viennent toujours du serveur. L'écran ne déduit jamais un prix annuel d'un prix mensuel : une offre absente n'est pas affichée.
- L'avantage (« 2 mois offerts ») n'est affiché que si l'économie annuelle correspond à un nombre entier de mois.
- Taxes : le régime d'affichage (`TTC` ou `HT`) est indiqué à côté de chaque montant.

## 3. Pas encore couvert (lots suivants)

- **Droits effectifs** (`getCapabilities`) : aujourd'hui, l'écran déduit ce qu'une offre permet du code du Studio, sans quota ni période. Quand les quotas existeront, ils viendront du serveur, avec limite, usage et date de réinitialisation.
- **Essai sans carte**, **devis de souscription** (M7-R02), **renouvellement, résiliation et factures** (M7-R03), **Atelier** (M7-R04) : rien côté interface tant que les contrats ne sont pas arrêtés. Aucun paiement réel ni simulé n'est présenté comme réel.

## 4. Questions pour Cloud

1. L'offre est-elle portée par l'établissement ou par le site ? Aujourd'hui, c'est `sites.plan`.
2. Les prix affichés seront-ils TTC ? L'aperçu suppose TTC.
3. Quelle route ou action pour `listOffers`, lisible par une professionnelle connectée (et plus tard par la page publique des tarifs) ?

## 5. Où c'est dans le code

- Calcul des prix : `src/features/platform/offers.ts` (tests : `offers.test.ts`).
- Écran : `src/features/platform/plan-overview.tsx` (tests : `plan-overview.test.tsx`).
- Page réelle : `src/app/(dashboard)/app/offre/page.tsx`.
- Aperçu avec des prix fictifs (ceux du cadrage, non décidés) : `/apercu/offre` (`?forfait=core|signature`), absent de la production.
