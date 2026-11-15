# Fidélisation par cohorte — contrat proposé (R4-01, tranche mesures)

Statut : **implémenté, à relire par Cloud** (lecture seule).
`public.crm_retention_report(p_business_id, p_window_days, p_as_of)`
(migration `20261115090000_retention_report.sql`), SECURITY INVOKER : la RLS
reste l'autorité, `crm_assert_member` refuse un non-membre, exécutable par
`authenticated` seulement, STABLE. Action serveur `readRetentionAction`
(l'établissement vient de la session). Page réelle :
`/app/loyalty/retention`, liée depuis Fidélité. L'aperçu
`/apercu/fidelisation` reste sur le serveur en mémoire.

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

## Choix faits (retention-v1), à relire par Cloud

- Visite = rendez-vous `completed` commencé au plus tard à `asOf` (même
  sens que le read model CRM). Heure de la visite = son début, en heure
  métier.
- Cohortes : le mois courant et les 11 précédents ; un mois sans nouvelle
  cliente n'apparaît pas.
- Retour = une visite un jour métier **ultérieur** au premier, au plus
  premier jour + N. Deux rendez-vous le même jour = une visite.
- Cohorte entièrement observée quand `asOf` ≥ (1er du mois suivant + N
  jours), heure métier.
- `minCohortSize` = 10.
- Visite « terminée » puis corrigée : le calcul part de l'état courant de
  l'agenda, rien n'est stocké, donc rien n'est dupliqué.
- Testé sur base réelle : `tests/integration/retention-report.test.ts`
  (fenêtres 30/60, minuit à Paris, no-show jamais première visite, autre
  établissement et anonyme refusés).
