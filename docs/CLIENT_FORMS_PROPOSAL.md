# Formulaires clients — contrat proposé (R3-02, côté cliente)

Statut : **proposé par l'UI, non implémenté**. La vue cliente existe
(`src/features/forms/`) et ne tourne que dans `/apercu/formulaire`, contre un
serveur en mémoire. Aucune page réelle ne montre de formulaire tant que ce
contrat n'est pas servi. Tables, RLS, RPC, verrous et notifications restent
ceux de Cloud ; ce document dit seulement ce que l'écran attend.

Hors de cette tranche : l'éditeur de modèles côté pro, la revue
(contre-signature), le registre des consentements marketing et l'accès par
terminal partagé ou lien signé.

## Lecture (dans le Hub, session et relation attestée requises)

`GET /api/client-hub/businesses/:businessId/forms/:assignmentId` → `ClientFormDto`

```ts
ClientFormDto = {
  assignmentId: string;
  templateVersionId: string;     // version publiée, immuable
  title: string;
  businessName: string;
  intro: string | null;
  status: "assigned" | "submitted" | "under_review" | "completed" | "expired" | "revoked";
  expiresAt: string | null;
  canSubmit: boolean;            // la parole du serveur
  review: "none" | "professional";
  fields: FormFieldDto[];
  receipt: { receiptId: string; submittedAt: string } | null;
};
FormFieldDto = {
  id: string;                    // stable entre versions
  type: "short_text" | "single_choice" | "boolean" | "attestation";
  label: string;
  required: boolean;
  help?: string | null;
  options?: { id: string; label: string }[];   // single_choice
  attestationText?: string;                   // attestation : texte exact affiché
  showIf?: { field: string; equals: string | boolean } | null; // question ANTÉRIEURE
};
```

Grant ou relation absente, autre cliente, autre établissement : **404
opaque** (`not_found`), sans distinguer les cas.

## Envoi

`POST …/forms/:assignmentId/submission`

```ts
{ templateVersionId, requestId, answers: { fieldId, value, attestedText? }[] }
→ { receiptId, status, submittedAt }
```

- Seules les réponses des questions **visibles** sont envoyées ; le serveur
  recalcule l'ensemble visible et refuse une réponse masquée.
- Une attestation porte le texte réellement affiché ; le serveur le compare
  à la version et enregistre l'heure serveur.
- Même `requestId` + même contenu → même reçu ; même `requestId` + contenu
  différent → `idempotency_conflict` (409). L'écran garde un `requestId` par
  contenu et le réutilise après une réponse perdue.
- `status` renvoyé : `submitted` si `review = professional`, sinon
  `completed`.

## Refus nommés

| Code                   | Ce que l'écran fait                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `stale_form`           | Relit le formulaire ; garde les réponses qui s'appliquent encore ; redemande toute attestation ; le dit |
| `form_expired`         | Relit : affiche l'état expiré                                                                           |
| `form_revoked`         | Relit : affiche « plus demandé »                                                                        |
| `field_required`       | (+ `fieldId`) erreur sous la question, focus dessus                                                     |
| `idempotency_conflict` | Ne devrait pas arriver (un `requestId` par contenu) ; message générique                                 |
| `not_found`            | « Ce formulaire n'est pas disponible », rien d'autre                                                    |

## Règles du moteur (partagées, `engine.ts`)

- Une condition porte toujours sur une question **antérieure** par ID
  stable : pas de cycle possible ; ID inconnu ou postérieur → modèle refusé
  (`checkTemplate`).
- Une réponse à une question masquée est effacée dans l'écran à l'instant
  où elle est masquée, et n'est jamais envoyée.
- Recette : fixture q1 faux / q2 absente → valide ; q1 vrai / q2 absente →
  erreur q2 (testé).

## Confidentialité

Aucune réponse n'est écrite dans le stockage du navigateur (testé) ; un
avertissement de sortie protège une saisie non envoyée. Pas de champ santé
ni de catégorie particulière en V1 (arbitrage juridique préalable).
