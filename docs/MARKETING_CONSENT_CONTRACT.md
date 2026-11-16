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

## Collecte V1 : l'accord vient de la cliente

Les règles produit V1 (formulations retenues, qui **ne sont pas** une
certification juridique) sont détaillées dans
`docs/MARKETING_CONSENT_OPERATIONS.md`.

- **Textes** : `getConsentTextsAction()` (sans connexion) renvoie
  `{ collectionEnabled, texts: { email?, sms?, information?, notice? } }`,
  chaque texte valant `{ version, body }`, les versions actives seulement.
  - Si `collectionEnabled` est faux, ou si un texte manque, la page n'affiche
    **aucune** case.
  - Sinon, elle affiche deux cases indépendantes, jamais précochées, avec le
    nom de l'établissement, le paragraphe `information` et un lien vers la
    notice.
- **Notice** (ces informations sont **publiques** : l'écran pro doit le
  dire, l'adresse d'une micro-entreprise est souvent celle du domicile) :
  `getConsentNoticeAction(slug)` renvoie
  `{ businessName, controller, missing }`. Le modèle et les variables sont
  dans `docs/consent/notice-template.md`. La propriétaire renseigne sa fiche
  légale avec `getBusinessLegalProfileAction` et
  `setBusinessLegalProfileAction` ; `missing` liste ce qui manque encore.
- **Réservation** : `POST /api/bookings` accepte
  `marketingConsent: { email?, sms?, versions: { email?, sms?, information, notice } }`.
  - La réservation n'en dépend jamais.
  - La réponse ajoute `marketingConsent: { status }`, qui vaut :
    - `pending` : un lien de confirmation est parti à l'adresse de la fiche ;
    - sinon la raison pour laquelle rien n'attend : `collection_off`,
      `text_not_active`, `nothing_ticked`, `unreachable`, `email_unavailable`
      (pas de transport d'e-mail), `already_requested` ou `failed`.
- **Double opt-in.** Une réservation publique rattache la fiche par l'e-mail
  saisi, sans prouver que la boîte est la sienne. Une case cochée ne prouve
  donc rien seule.
  - L'accord n'existe qu'**au clic sur le lien de confirmation**, envoyé à
    l'adresse de la fiche et valable 7 jours.
  - Sans ce clic, rien n'est enregistré : une désinscription antérieure
    reste en place.
  - Un accord SMS ne vaut que pour le numéro saisi avec cette réservation,
    s'il est bien celui de la fiche.
- **Page à créer côté UI : `/consentement/confirmer#t=cnf_…`.** Le jeton est
  dans le fragment.
  - `readConsentConfirmationAction(token)` renvoie
    `{ businessName, channels, texts, confirmed }` et n'écrit rien.
  - `confirmConsentAction(token)` renvoie
    `{ status: "confirmed" | "already_confirmed" | "collection_off", businessName, channels? }`,
    où `channels` vaut `{ email?: "granted" | "unreachable", sms?: … }`.
  - Un lien inconnu ou expiré : `consent_link_invalid`.
- **Preuve** de chaque accord : l'établissement, le canal, la date serveur,
  l'origine (`booking`), le rendez-vous et sa demande, la confirmation
  (`confirmedBy: "email_link"`), et les versions exactes de la case, de
  l'information et de la notice, archivées en entier.
- **Verrou de production** : la collecte est **éteinte**
  (`marketing_consent_collection`). Seul l'administrateur de la plateforme
  peut l'ouvrir, par la procédure, sur autorisation explicite.

## Côté pro (`src/features/marketing-consent/actions.ts`)

| Action                                                                            | Réponse                     |
| --------------------------------------------------------------------------------- | --------------------------- |
| `getClientConsentsAction({ clientId })`                                           | `ConsentDto[]` (email, sms) |
| `getClientConsentHistoryAction({ clientId })`                                     | `ConsentEventDto[]`         |
| `setConsentAction({ clientId, purpose, channel, action: "withdraw", requestId })` | `ConsentDto`                |

- **Retrait seulement.** Une professionnelle enregistre le retrait que la
  cliente lui a demandé. Un accord (`grant`) est refusé avec
  `consent_direct_only` : elle ne peut pas déclarer qu'une cliente a accepté.
- `ConsentEventDto` ajoute `informationVersion` et `noticeVersion`. Les
  `source` possibles sont `booking`, `professional`, `unsubscribe_link` et
  `unsubscribe_undo` (`client_hub` est prévu).
- Tout membre de l'établissement peut agir. Une cliente d'un autre
  établissement donne `client_not_found`.

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
