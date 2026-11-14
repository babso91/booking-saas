# Import de clientes — contrat proposé (R3-03, tranche import)

Statut : **proposé par l'UI, non implémenté**. L'assistant existe
(`src/features/crm-import/`) et ne tourne que dans `/apercu/import`, contre
un serveur en mémoire. Tables `crm_import_jobs/rows`, résolution par
`private.canonical_email` / `private.resolve_client`, lots bornés et
isolation par établissement restent ceux de Cloud.

Hors de cette tranche : médias privés avant/après, export, aperçu de fusion.

## Aperçu (n'écrit rien dans le CRM)

`preview({ fileName, content, mapping })` (proposition : en vrai, le fichier
part en upload privé et l'aperçu reçoit `uploadId`)

```ts
type Mapping = Record<
  number,
  "firstName" | "lastName" | "email" | "phone" | "tags" | null
>;
type Row = {
  rowNumber: number; // ligne du fichier, en-tête = 1
  state: "create" | "unchanged" | "conflict" | "invalid";
  reason:
    | "duplicate_in_file"
    | "existing_contact"
    | "shared_phone"
    | "missing_contact"
    | "invalid_email"
    | "contact_changed"
    | null;
  displayName: string;
};
type Preview = { jobId: string; mappingVersion: string; rows: Row[] };
```

Règles :

- E-mail canonique (casse ignorée) ; deux lignes avec le même e-mail : la
  seconde est `conflict / duplicate_in_file`.
- **Téléphone seul déjà utilisé : `conflict / shared_phone`, jamais de
  fusion ni de droit accordé.**
- Ni e-mail ni téléphone : `invalid`.
- Un même e-mail dans deux établissements reste deux fiches indépendantes.

## Confirmation

`commit({ jobId, mappingVersion, requestId })` →
`{ status: "completed" | "completed_with_errors", rows: Row[] }`

- Chaque ligne est **relue** au moment d'importer : une fiche créée
  entre-temps donne `conflict / contact_changed`, jamais une fusion.
- Clé stable par ligne `jobId × rowNumber × digest` ; même `requestId` →
  même résultat.
- `import_version_conflict` : l'aperçu ne correspond plus aux colonnes ;
  l'écran revient aux colonnes, « rien n'a été importé ».

## Côté écran

- Lecture locale du CSV seulement pour proposer la correspondance (BOM,
  guillemets, `;` ou `,`) ; le serveur relit le fichier.
- Un nom commençant par `=` est affiché et importé comme du texte.
- Le rapport des lignes non importées se télécharge en CSV dont les
  cellules interprétables (`= + - @`) sont neutralisées.
