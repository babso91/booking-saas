# Fidélisation par cohorte — contrat proposé (R4-01, tranche mesures)

Statut : **proposé par l'UI, non implémenté**. Le tableau existe
(`src/features/retention/`) et ne tourne que dans `/apercu/fidelisation`,
contre un serveur en mémoire. Le calcul (faits d'agenda, `asOf`, fuseau
métier) reste celui de Cloud.

## Définition (versionnée par le serveur)

- Cohorte : les clientes dont la **première visite terminée** tombe dans un
  mois (fuseau de l'établissement).
- Revenue : une deuxième visite **terminée** dans les N jours (30, 60 ou 90)
  après la première. Date de réalisation, pas de réservation.
- Un taux n'est donné que pour une cohorte **entièrement observée** (la
  fenêtre de chaque cliente est terminée à `asOf`) et d'au moins
  `minCohortSize` clientes.
- Aucun montant déduit d'un prix d'agenda ; aucune causalité affichée.

## Lecture

`read({ windowDays: 30 | 60 | 90 })` →

```ts
type Cohort = {
  month: string; // "YYYY-MM"
  size: number;
  returned: number;
  fullyObserved: boolean;
};
type Report = {
  definitionVersion: string;
  windowDays: 30 | 60 | 90;
  asOf: string;
  timeZone: string;
  minCohortSize: number;
  cohorts: Cohort[];
};
```

L'écran calcule seulement l'affichage : taux par cohorte lisible
(`readCohort`) et taux global **pondéré par taille sur les seules cohortes
lisibles** (`overallRate`) ; sinon « Données insuffisantes ». Une cohorte
immature montre « N pour l'instant · fenêtre en cours », une trop petite
« trop peu de clientes ».

## À trancher par Cloud

Valeur de `minCohortSize` (10 proposé) et traitement d'une visite
« terminée » puis corrigée (le fait de retour ne doit pas être dupliqué).
