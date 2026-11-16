# Consentement marketing et désinscription : contrat servi

Réponse de Cloud à `docs/UNSUBSCRIBE_PROPOSAL.md` (PR #80). Ce lot sert aussi
le registre de consentement de R3-02, préalable aux campagnes (R4-01, PR #68).
Les actions de la page sont servies **telles que proposées**, avec les écarts
listés en fin de document. Migration :
`supabase/migrations/20261115160000_marketing_consent.sql`.

## Registre

- **Append-only**, par cliente × finalité × canal (`marketing` × `email` |
  `sms`). L'état courant est le dernier événement. Sans aucun événement :
  `unknown`, c'est-à-dire jamais contactée. L'opt-in est explicite : seul
  `granted` autorise un envoi marketing.
- Un `granted` porte `proofVersion`, la version du texte qu'elle a accepté.
- **Les rappels de rendez-vous ne lisent jamais ce registre** : ce n'est pas
  du marketing.
- **Verrou** : chaque changement prend le verrou de la cliente
  (`private.lock_consent_subject`). Un envoi marketing le prendra aussi juste
  avant sa dernière vérification. Un retrait validé avant cette vérification
  empêche donc l'envoi. Un message déjà remis au fournisseur peut partir.

## Côté pro (`src/features/marketing-consent/actions.ts`)

| Action                                                                               | Réponse                     |
| ------------------------------------------------------------------------------------ | --------------------------- |
| `getClientConsentsAction({ clientId })`                                              | `ConsentDto[]` (email, sms) |
| `setConsentAction({ clientId, purpose, channel, action, proofVersion?, requestId })` | `ConsentDto`                |

`ConsentDto = { purpose, channel, state: "unknown"|"granted"|"withdrawn", proofVersion, source, changedAt }`.

**Texte validé obligatoire.** Un accord (`grant`) doit citer une version de
texte enregistrée côté serveur comme validée
(`private.consent_wording_versions`). Seul un opérateur l'enregistre, en SQL,
après la validation juridique, jamais l'application. Sinon :
`consent_wording_not_validated` (409), et rien n'est écrit. **Aucune version
n'est enregistrée aujourd'hui : tout accord est refusé.** Un retrait reste
toujours possible.

**Historique** : `getClientConsentHistoryAction({ clientId })` renvoie
`ConsentEventDto[]`, du plus récent au plus ancien. Chaque élément vaut
`{ purpose, channel, state, proofVersion, source, businessName, occurredAt }`.
`state` peut valoir `unknown` après une annulation qui ramène à l'état
inconnu. Les `source` servies aujourd'hui sont `professional`,
`unsubscribe_link` et `unsubscribe_undo`. `booking` et `client_hub` viendront
avec leurs parcours.
`action: "grant"` exige `proofVersion` (`[A-Za-z0-9._-]{1,64}`). Le rejeu par
`requestId` : même commande, même réponse ; autre commande,
`idempotency_conflict`. Tout membre de l'établissement peut agir (le rôle
praticienne n'est pas encore ouvert). Une cliente d'un autre établissement
donne `client_not_found`.

## Page de désinscription (sans connexion)

| Contrat UI    | Action                                | Effet                                                           |
| ------------- | ------------------------------------- | --------------------------------------------------------------- |
| `read`        | `readUnsubscribeAction(token)`        | `UnsubscribeView`, n'écrit rien                                 |
| `withdraw`    | `withdrawUnsubscribeAction(token)`    | retrait pour cet établissement × ce canal, idempotent           |
| `resubscribe` | `resubscribeUnsubscribeAction(token)` | annule son retrait fait par **ce lien** dans les **30 minutes** |

`UnsubscribeView = { businessName, channel, alreadyWithdrawn, canUndo }`.

- **Lien** : `/desinscription#t=uns_…`. Le jeton est dans le fragment : le
  navigateur ne l'envoie pas au serveur et ne le met pas dans le referrer. La
  page le lit et le passe aux actions. Seule son empreinte SHA-256 est
  stockée. Il ne prouve que l'établissement, la cliente et le canal : ni Hub,
  ni CRM.
- **Un clic depuis la messagerie (RFC 8058)** :
  `POST /api/unsubscribe/uns_…`, l'URL de l'en-tête `List-Unsubscribe` des
  e-mails marketing. Même effet que le bouton. Pas de `GET` : ouvrir un lien
  ne désinscrit jamais.
- **Validité** : un an après l'envoi du message.
- **Annuler** rétablit l'état d'avant le retrait : son accord précédent avec
  sa preuve, ou `unknown`. L'annulation n'invente jamais de consentement.

## Refus

| Code                                 | Quand                                                         |
| ------------------------------------ | ------------------------------------------------------------- |
| `unsubscribe_link_invalid` (404)     | jeton inconnu, forgé ou expiré : une réponse opaque, sans nom |
| `unsubscribe_undo_unavailable` (409) | aucun retrait par ce lien, ou retrait de plus de 30 minutes   |

## Écarts avec la proposition

1. **`canUndo`** est ajouté à la vue : la page n'affiche « Annuler » que
   lorsque c'est possible.
2. **Choix tranchés.** Le jeton vaut un an. `resubscribe` n'est possible que
   juste après le retrait, depuis le même lien. Un retrait pris en compte
   avant la dernière vérification d'un envoi l'arrête (verrou ci-dessus).
3. **Hors lot** : l'émission des liens dans les messages vient avec les
   campagnes (`issueUnsubscribeLink`, côté serveur). Les e-mails marketing
   réels restent désactivés tant que le fournisseur d'e-mail, l'identité
   d'expéditeur et la validation juridique de l'opt-in ne sont pas réglés.
