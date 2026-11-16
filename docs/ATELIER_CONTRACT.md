# Atelier, côté pro : contrat servi (R5-03, tranche relecture)

Réponse de Cloud à `docs/ATELIER_PROPOSAL.md` (PR #75). Le contrat
`AtelierActions` est servi **tel que proposé**, avec les écarts listés en fin
de document. Migration : `supabase/migrations/20261116160000_atelier.sql`.

**Rien n'est facturé ni publié d'ici.** Le montant d'une commande est une
hypothèse de produit fixée par la plateforme, comme les tarifs M7, qui sont
provisoires.

## Actions (`src/features/atelier-server/actions.ts`, propriétaire seulement)

| Contrat UI          | Action                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| `read`              | `readAtelierAction({ orderId })`                                               |
| `requestCorrection` | `requestAtelierCorrectionAction({ proposalId, scope, requestId })`             |
| `requestRebase`     | `requestAtelierRebaseAction({ proposalId, requestId })`                        |
| `apply`             | `applyAtelierProposalAction({ proposalId, expectedDraftRevision, requestId })` |

## Règles

- **Proposition** : l'instantané d'une configuration complète du site, faite
  sur une révision donnée de son brouillon. Seul un opérateur dont l'accès à
  la commande est en cours la dépose.
- **Appliquer** passe par le chemin de sauvegarde du Studio
  (`save_site_draft` : révision, schéma, photos). **Rien n'est jamais
  publié.**
  - Son brouillon doit être celui de la proposition, et celui qu'elle a vu.
  - Sinon `stale_site_draft`, avec sa révision actuelle
    (`error.conflict.currentRevision`) : rien n'est écrasé, elle compare et
    choisit.
- **Correction** : elle consomme une correction incluse, une seule fois par
  `requestId`, dans les périmètres du devis.
  - Hors devis : `atelier_out_of_scope` (un devis à part, rien n'est facturé
    sans son accord).
  - Plus de corrections incluses : `atelier_revision_limit_reached`.
- **Refaire sur le brouillon actuel** (`requestRebase`) ne consomme jamais de
  correction. Ses propres modifications dans le Studio non plus.
- **Devis modifié** depuis la proposition : `atelier_quote_changed`.
- **Rejeu** par `requestId` : même contenu, même réponse.
- **Accès** : une commande d'un autre établissement, inconnue, ou vue par une
  admin répond `atelier_access_expired`. C'est la même réponse dans tous les
  cas. Une commande livrée ou annulée n'accepte plus ni correction, ni
  reprise, ni application.
- **Côté opérateur** : un accès expiré ne peut plus déposer de proposition
  (`atelier_access_expired`). Les propositions déjà déposées restent
  consultables et applicables par la propriétaire.
- **Double clic** : l'interface réutilise le même `requestId` pour une même
  intention. Deux `requestId` différents sont deux demandes, donc deux
  corrections.

## Écarts avec la proposition

1. **`AtelierProposalDto.rebaseRequested`** est ajouté : la cliente voit que
   sa demande de reprise est notée.
2. **L'opérateur** (création de commande, accès, dépôt de proposition) passe
   par le service seulement. La vue opératrice est hors lot.
3. **Hors lot** : l'acceptation du devis et le paiement (M7), le dépôt des
   photos et des textes, les notifications.
