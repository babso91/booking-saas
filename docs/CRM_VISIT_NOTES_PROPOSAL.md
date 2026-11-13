# CRM — fiche technique par visite, préférences et étiquettes (proposition UI → Cloud)

**Statut : PROPOSÉ.** Rien de ce document n'est servi par le backend. Il décrit ce que l'interface attend, pour que Cloud le valide, le corrige ou le remplace. Une fois le contrat arrêté, il rejoint les contrats CRM et ce fichier disparaît.

L'écran existe (`src/features/crm/visit-notes/`), testé contre un serveur en mémoire. **Il n'est monté dans aucune page réelle** : seulement dans l'aperçu `/apercu/fiche-visite`. Il sera branché dans la fiche cliente et l'agenda quand les actions réelles existeront.

## 1. Ce que l'écran fait

- **Préparer la visite** : les préférences de la cliente, sa dernière fiche validée, ses étiquettes.
- **Fiche de cette visite** : des champs définis par l'établissement (texte, nombre avec unité, choix) et des produits utilisés (nom, quantité, unité, sans effet sur un stock).
- Rien n'est propre à un métier : les champs sont ceux de la professionnelle.

## 2. Règles que l'écran suppose

- Une fiche est un **brouillon** modifiable par version, jusqu'à sa **validation**.
- Une fiche validée ne se modifie plus. Une **correction** est une nouvelle fiche, qui référence celle qu'elle remplace et porte une raison obligatoire. L'ancienne reste dans l'historique.
- Une seule fiche validée courante par visite.
- Chaque valeur garde le libellé et l'unité de son champ au moment de l'écriture. Renommer ou retirer un champ ne change aucune fiche passée.
- Reprendre les valeurs d'une visite précédente est une décision explicite. L'écran indique la visite d'origine et nomme les champs qui n'existent plus, sans les copier.
- Une étiquette archivée reste lisible sur la cliente, mais n'est plus proposée.

## 3. Lecture

`getVisitPreparationAction({ appointmentId })` renvoie, d'une seule lecture :

```ts
{
  appointmentId, clientId, clientName, serviceName, startsAt, timezone,
  preferences: { version, text },
  lastRecord: (TechnicalNote & { visitStartsAt }) | null, // dernière fiche validée d'une visite antérieure
  current: TechnicalNote | null,                          // brouillon ou fiche validée de cette visite
  allowedFields: { id, label, kind: "text" | "number" | "choice", unit, choices }[],
  tags: { id, label, archived }[],
  clientTagIds: string[],
}

type TechnicalNote = {
  id, version, state: "draft" | "recorded" | "superseded", serviceName,
  fieldValues: { fieldId, label, value, unit }[],
  products: { name, quantity, unit }[],
  recordedAt, supersedesId, correctionReason,
};
```

## 4. Écritures

| Action                      | Entrée                                                                                    | Réponse attendue        |
| --------------------------- | ----------------------------------------------------------------------------------------- | ----------------------- |
| `saveTechnicalDraftAction`  | `{ requestId, appointmentId, expectedVersion, fieldValues[], products[], supersedesId? }` | le brouillon enregistré |
| `recordTechnicalNoteAction` | `{ requestId, noteId, expectedVersion, correctionReason? }`                               | la fiche validée        |
| `setClientTagAction`        | `{ requestId, clientId, tagId, attached }`                                                | `{ clientId, tagIds }`  |

- `expectedVersion` vaut 0 quand la visite n'a pas encore de fiche.
- `fieldValues` ne porte que `{ fieldId, value }` : libellé et unité sont figés par le serveur.
- **L'écran demande la fiche complète en réponse**, plutôt qu'un reçu `{ id, version, state }` : il affiche ce que le serveur a gardé sans relecture. Si Cloud préfère un reçu, l'écran relira la préparation.
- **Idempotence par `requestId`** : l'écran renvoie le même identifiant après une réponse perdue. La même demande ne doit jamais enregistrer ou valider deux fois.

## 5. Refus gérés par l'écran

| Code                   | Ce que fait l'écran                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `stale_technical_note` | garde la saisie, relit la visite, montre champ par champ « toi / enregistré » avec « Prendre l'enregistré » |
| `visit_client_changed` | « Ce rendez-vous a changé de cliente » : rien n'est attaché                                                 |
| `field_not_allowed`    | relit les champs autorisés et demande de vérifier la fiche                                                  |
| `validation_error`     | message générique (une correction sans raison est déjà arrêtée par l'écran)                                 |
| pas de réponse         | « Pas de réponse », nouvel essai avec le même `requestId`                                                   |

Si une fiche a été **validée ailleurs** pendant la saisie, celle-ci est gardée et proposée comme correction.

## 6. Questions ouvertes pour Cloud

1. **Préférences** : l'écran les affiche, mais aucune action ne les modifie dans cette proposition. Quelle commande, avec quelle version ?
2. **Champs** : qui les définit, et où (réglages de l'établissement, par prestation ou par catégorie) ? L'écran attend seulement `allowedFields` pour la visite.
3. **Étiquettes** : création, renommage et archivage ne sont pas couverts ici ; seulement l'affectation par identifiant.
4. **Le Client Hub ne reçoit aucune fiche technique** : à confirmer côté lectures du Hub.
5. Que devient un brouillon si le rendez-vous est annulé ou déplacé ?

## 7. Où c'est dans le code

- Contrat proposé : `src/features/crm/visit-notes/contract.ts`.
- Logique de brouillon (copie, comparaison, validation locale) : `draft.ts`.
- Écran : `visit-sheet.tsx` ; il reçoit ses actions (`VisitNotesActions`), jamais importées en dur.
- Serveur en mémoire pour l'aperçu et les tests : `memory-actions.ts` (versions, refus d'écriture périmée, rejeu d'un `requestId`).
- Tests : `visit-sheet.test.tsx` (13).
