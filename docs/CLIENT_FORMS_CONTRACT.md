# Formulaires clients : contrat servi (R3-02, lot 1)

Réponse de Cloud à `docs/CLIENT_FORMS_PROPOSAL.md` (PR #65, #66, #84). Les
formes `ClientFormDto`, `FormTemplateDto`, `VisitFormsDto` et leurs actions
sont servies **telles que proposées**, avec les écarts listés en fin de
document. Migration : `supabase/migrations/20261115100000_client_forms.sql`.
Types côté serveur : `src/features/client-forms/types.ts`.

## Côté pro : actions serveur

Fichier : `src/features/client-forms/actions/forms.ts`. Toutes passent par
`runBusinessAction` : l'établissement est celui de la session, le rôle
`owner` ou `admin` est vérifié par la base (`permission_denied` sinon).

| Contrat UI                  | Action serveur              | Fonction SQL            |
| --------------------------- | --------------------------- | ----------------------- |
| (nouveau) liste des modèles | `listFormTemplatesAction`   | `list_form_templates`   |
| (nouveau) créer un modèle   | `createFormTemplateAction`  | `create_form_template`  |
| éditeur `read`              | `readFormTemplateAction`    | `read_form_template`    |
| éditeur `saveDraft`         | `saveFormDraftAction`       | `save_form_draft`       |
| éditeur `publish`           | `publishFormTemplateAction` | `publish_form_template` |
| visite `read`               | `readVisitFormsAction`      | `read_visit_forms`      |
| visite `assign`             | `assignVisitFormAction`     | `assign_visit_form`     |
| visite `revoke`             | `revokeVisitFormAction`     | `revoke_visit_form`     |
| visite `review`             | `reviewVisitFormAction`     | `review_visit_form`     |

Entrées : celles de la proposition. `createFormTemplateAction` prend
`{ requestId, draft }` et rend un `FormTemplateDto` au statut `draft`
(`draftVersion: 1`, aucune version publiée).

Réponse : `{ ok: true, data } | { ok: false, error: { code, message, fieldErrors? } }`.

## Côté cliente : routes du Hub

Session du Hub (cookie) et accès Hub **actif** à la fiche CRM de la cliente,
dont l'e-mail est toujours celui de la fiche. Les coordonnées laissées lors
d'une réservation n'ouvrent jamais un formulaire.

| Route                                                                        | Réponse                              |
| ---------------------------------------------------------------------------- | ------------------------------------ |
| `GET /api/client-hub/businesses/:businessId/forms`                           | `ClientFormDto[]` (sans les retirés) |
| `GET /api/client-hub/businesses/:businessId/forms/:assignmentId`             | `ClientFormDto`                      |
| `POST /api/client-hub/businesses/:businessId/forms/:assignmentId/submission` | `{ receiptId, status, submittedAt }` |

Le `POST` exige `Content-Type: application/json` et la même origine, comme
toutes les écritures du Hub. Réponses `no-store`.

## Garanties

- **Version figée.** Publier copie le brouillon **enregistré** en version
  `n + 1`, revérifiée par la base, puis immuable (une mise à jour est
  refusée par un déclencheur). Un formulaire envoyé garde sa version.
- **Réponses figées.** Une seule soumission par formulaire, jamais modifiée.
  Une attestation enregistre le texte de la version et l'heure du serveur.
- **Questions visibles.** Le serveur parcourt les questions dans l'ordre et
  recalcule celles qui sont visibles. Une réponse à une question masquée ou
  inconnue est refusée et rien n'est enregistré.
- **Rejeu.** Même `requestId` et même contenu, même auteur : la réponse
  enregistrée est renvoyée. Deux envois identiques simultanés donnent un seul
  reçu. Même `requestId` avec un autre contenu, ou par un autre compte :
  `idempotency_conflict`.
- **Révision.** `revoke` et `review` prennent la `version` de l'affectation ;
  une version périmée donne `version_conflict`. Le brouillon d'un modèle a
  son `draftVersion`.
- **Retrait d'accès.** Une révocation de l'accès Hub (ou un changement
  d'e-mail de la fiche) et une soumission ne se croisent pas : l'une attend
  l'autre. Après la révocation, le formulaire répond comme s'il n'existait pas.
- **404 opaque.** Côté pro, un modèle, une version ou un rendez-vous d'un
  autre établissement donne `not_found`. Un compte sans appartenance :
  `forbidden`.

## Refus

| Code                        | Quand                                                                           |
| --------------------------- | ------------------------------------------------------------------------------- |
| `invalid_template`          | création, brouillon ou publication contraires aux règles de l'écran             |
| `version_conflict`          | `draftVersion` ou `version` périmée                                             |
| `form_already_assigned`     | ce modèle (toute version) est déjà ouvert pour cette visite                     |
| `appointment_not_editable`  | visite passée ou non confirmée au moment de l'envoi                             |
| `form_already_submitted`    | `revoke` après réponse, ou nouvel envoi d'un formulaire déjà rempli             |
| `invalid_status_transition` | `review` d'un formulaire qui n'attend pas de relecture                          |
| `form_revoked`              | formulaire retiré, ou visite annulée                                            |
| `form_expired`              | la visite a commencé                                                            |
| `stale_form`                | `templateVersionId` différent, ou texte d'attestation différent                 |
| `field_required`            | question visible obligatoire sans réponse ; `fieldErrors: { [fieldId]: [...] }` |
| `validation_error`          | réponse à une question masquée ou inconnue, valeur d'un mauvais type            |
| `idempotency_conflict`      | voir « Rejeu »                                                                  |
| `form_limit_reached`        | 100 modèles                                                                     |
| `client_hub_not_found`      | Hub : pas d'accès, autre cliente, autre établissement (404)                     |

## Écarts avec la proposition

1. **Code du 404 côté Hub : `client_hub_not_found`**, comme toutes les routes
   du Hub (la proposition dit `not_found`). Même sens, même opacité.
2. **`field_required`** : la question est dans `error.fieldErrors`, clé =
   identifiant stable de la question (pas de champ `fieldId` séparé).
3. **Échéance.** `expiresAt` est le début du rendez-vous. Une visite annulée
   rend le formulaire ouvert `revoked` (calculé à la lecture et à l'envoi).
4. **`under_review` n'est pas utilisé** en V1 : `submitted` puis `completed`
   à la relecture, comme dans la section « Côté pro » de la proposition.
5. **Deux actions en plus** : liste et création de modèles (l'éditeur en a
   besoin pour en ouvrir un).
6. **Hors de ce lot** : assignation automatique et règle de fréquence (la
   fréquence est enregistrée et validée, pas encore appliquée), e-mail qui
   prévient la cliente (la demande est visible dans son Hub), registre des
   consentements marketing, retrait d'un modèle (`retired`). Pas de champ
   santé ni de catégorie particulière.
7. **Rôles.** `owner` et `admin` seulement, jusqu'au lot « capacités ».
