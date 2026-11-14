# Atelier, côté pro — contrat proposé (R5-03, tranche relecture)

Statut : **proposé par l'UI, non implémenté**. La vue existe
(`src/features/atelier/`) et ne tourne que dans `/apercu/atelier`, contre un
serveur en mémoire. **Rien n'est facturé ni publié.** La commande, son
devis et sa facturation appartiennent à M7 ; les propositions et patches à
M5 (Cloud), attachés à `orderId × siteId × baseDraftRevision`.

Hors de cette tranche : la vue opératrice, l'acceptation du devis, le dépôt
des photos et textes.

## Lecture

`read(orderId)` →

```ts
type View = {
  order: {
    orderId: string;
    title: string;
    status:
      | "quoted"
      | "accepted"
      | "awaiting_assets"
      | "in_production"
      | "in_review"
      | "revision_requested"
      | "delivered"
      | "cancelled";
    quote: {
      version: number;
      amountCents: number;
      currency: string;
      includedCorrections: number;
    };
    correctionsUsed: number;
  };
  proposals: {
    proposalId: string;
    baseDraftRevision: number;
    state: "submitted" | "changes_requested" | "accepted" | "applied";
    submittedAt: string;
    authorLabel: string;
    changes: string[]; // lisibles par la pro
  }[];
  currentDraftRevision: number;
};
```

## Actions

| Action              | Entrée                                         | Effet                                                                                 |
| ------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `requestCorrection` | `proposalId, scope, requestId`                 | Consomme **une** correction incluse, une seule fois par demande                       |
| `requestRebase`     | `proposalId, requestId`                        | Refaire la proposition sur le brouillon actuel ; **ne consomme pas** de correction    |
| `apply`             | `proposalId, expectedDraftRevision, requestId` | Sauvegarde le brouillon par le chemin existant (sous révision) ; **ne publie jamais** |

Refus : `stale_site_draft` (+ `currentRevision`) → rien d'écrasé, la pro
compare et choisit ; `atelier_revision_limit_reached` ;
`atelier_out_of_scope` → devis à part, rien de facturé sans accord ;
`atelier_quote_changed` ; `atelier_access_expired` → rien du projet
visible. Même `requestId` → même réponse.

## Règles d'écran

- Montant du devis affiché en lecture seule, « aucun paiement depuis cette
  page », ponctuel et à part de l'abonnement.
- Les modifications faites par la pro elle-même dans le Studio ne
  consomment jamais de correction.
- Après application : « rien n'est publié », lien vers le Studio.
