# Écrin : dossier d'audit (le cadran)

Branche `feat/dashboard-ecrin`, partie du HEAD Studio 2 `5da19de` (PR #29, en audit). La PR Écrin est **empilée sur `feat/dashboard-studio-2`** : son diff ne contient que l'Écrin.

Plan d'ensemble : `docs/DASHBOARD_EXPERIENCE.md`. Dossiers précédents : `docs/STUDIO_1_AUDIT.md`, `docs/STUDIO_2_AUDIT.md`.

**Hors périmètre** : aucune migration, aucune nouvelle action serveur, aucune route API, aucune dépendance npm. Deux polices Google chargées par `next/font` (Marcellus, Jost), sans préchargement. Le style Carnet n'est pas commencé.

---

## 1. Architecture : un seul moteur, une troisième mise en scène

`AgendaView` reste **le contrôleur unique**. En style Écrin, il délègue le dessin à `EcrinAgenda`, avec exactement le contrat de Studio (`StudioAgendaProps`). Le seul changement dans `agenda-view.tsx` : le test `studio` devient `style !== "classique"`, et le composant dessiné dépend du style.

**Rien n'est réimplémenté** : lecture, « aujourd'hui » validé par PostgreSQL, panneaux, formulaires, actions, `supersede`, `?rdv=`, erreurs, disponibilités, anti-double réservation, statuts, autorisations, fuseaux. Un créneau peut être proposé depuis le cadran ou le fil, mais c'est le formulaire et le serveur existants qui décident. Un test le vérifie avec un refus `schedule_conflict`.

Le placement réutilise `features/agenda/client/layout.ts` (axe, bandes du changement d'heure, couloirs de chevauchement). Les modèles de lecture sont ceux de Studio : `todayModel` et `dayFlow`. La seule géométrie nouvelle est celle du cadran, pure et testée : `features/dashboard/ecrin/dial.ts`.

| Fichier (`features/dashboard/ecrin/`) | Rôle                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------ |
| `dial.ts`, `ecrin-dial.tsx`           | Géométrie et dessin du cadran (arcs, anneaux si chevauchement, aiguille, pauses)     |
| `ecrin-shell.tsx`                     | Monogramme, capsule de navigation (haut sur ordinateur, sous le pouce sur téléphone) |
| `ecrin-today.tsx`                     | Accueil autour du cadran                                                             |
| `ecrin-agenda.tsx`                    | En-tête, vues, téléphone (perles des jours, « + », balayage, retour sur l'onglet)    |
| `ecrin-week.tsx`                      | Semaine en sept tubes, mini-cadran en tête de chaque jour                            |
| `ecrin-thread.tsx`                    | Jour en fil de perles                                                                |
| `looks.ts`                            | Traduction des états de rendez-vous en matières Écrin                                |

Classique et Studio ne changent pas de code, à quelques lignes de routage près (`app-shell.tsx`, `today/page.tsx`, `agenda-view.tsx`). Les fichiers de Studio ne sont pas modifiés, pour que les corrections de l'audit de #29 s'intègrent sans conflit.

## 2. Ce qui différencie l'Écrin de Studio

| Sujet        | Studio                             | Écrin                                                      |
| ------------ | ---------------------------------- | ---------------------------------------------------------- |
| Temps        | Frise, planning mural              | Cadran, tubes verticaux, fil de perles                     |
| Lettres      | Condensé noir, capitales           | Gravure (Marcellus), sans géométrique léger (Jost)         |
| Surfaces     | Aplats, couleur signature en grand | Satin, liseré fin, ombre douce ; la pierre reste un accent |
| Navigation   | Dock                               | Capsule ; monogramme gravé                                 |
| Jour (ordi.) | Colonne détaillée                  | Grand cadran fixe à côté du fil                            |
| Téléphone    | Défilement avec bande de jours     | Mini-cadran, fil, perles des jours et « + » sous le pouce  |

## 3. Règles de contenu conservées

- Aucune donnée fictive en production : les fixtures ne servent qu'aux aperçus `/apercu/*` (404 en production sauf `DASHBOARD_PREVIEW=1`).
- Aucun montant sur l'accueil, la semaine ou le jour. Seule la fiche partagée `AppointmentDetails` montre, comme dans les autres styles, le prix réel convenu à la réservation.
- Un rendez-vous confirmé commencé reste un « Créneau en cours », avec un avancement dit « théorique ».
- Les notes n'apparaissent que sur demande ; une capsule signale seulement « note ».
- Le compte de la semaine est distinct par identifiant, sans double compte à minuit.
- Les fermetures partielles sont visibles.
- Le focus n'utilise jamais la couleur signature brute (testé sur tout le dossier).
- Les mentions de minuit ont leur propre ligne, non tronquée.

## 4. Apparence

Même cookie et même contrat : `ambiance.mode.motion.accent.style`, avec une nouvelle valeur de style `ecrin`. Le changement est réversible et sans perte (testé). `ecrin` ignore l'ambiance mais ne l'efface pas. Toute pierre reste lisible : `paletteFor` est testé sur 300 couleurs aléatoires.

**Coordination avec Claude Cloud** : aucune seconde persistance n'est ajoutée. La sauvegarde par compte devra accepter `ecrin` dans ses valeurs de style. Sinon, une préférence Écrin serait rejetée ou rabattue sur une autre.

## 5. Écrans secondaires

Clientes, Prestations, Fidélité, Horaires, Calendar, Apparence, fiches et formulaires gardent leurs composants. Sous `[data-style="ecrin"]`, ils reçoivent la gravure, le Jost, des angles plus doux (jetons `--radius-*`), le fond et la palette.

**Limite connue** : ces écrans lisent le serveur. Hors Apparence, je ne les ai vus localement que dans leur état d'erreur, sans leurs données (pas de Supabase local). Leur réponse HTTP avec le cookie Écrin dépend de la CI (`/app`, `/app/today`) ; les autres routes n'y sont pas parcourues. Les boutons primaires partagés restent encre, alors que le bouton « Nouveau rendez-vous » de l'agenda porte la pierre : décision assumée pour ne pas modifier le composant partagé.

## 6. Encaissement futur

Rien n'est simulé : ni bouton, ni montant, ni mutation. La place naturelle du geste est **la fiche `AppointmentDetails`**, partagée par tous les styles, une fois le créneau terminé. L'Écrin pourra ensuite ajouter une pastille d'état sur la capsule (`looks.ts`) et un total réel dans `Holdings`, quand le backend des paiements existera.

## 7. Cas limites couverts

0, 1 et 15 rendez-vous ; jour fermé, fermeture exceptionnelle et partielle ; chevauchements ; minuit ; changement d'heure d'automne (deux 02:30 réels) ; noms très longs ; erreur réseau avec reprise ; retour sur l'onglet après plus d'une minute ; lien `?rdv=` ; cookies hostiles ; lien vers le rendez-vous d'une autre activité (e2e).

## 8. Vérifications

- `src/features/dashboard/ecrin/*.test.*` : cadran, accueil, coquille, agenda sur le vrai `AgendaView`.
- `tests/e2e/ecrin-agenda.test.ts` : backend réel en CI uniquement (pas de Docker en local).
- Chromium + axe-core 4.14 (WCAG 2.1 AA) sur `/apercu/ecrin/{agenda,aujourdhui}` : 6 teintes dont des pierres difficiles, 6 scénarios, largeurs 320, 375, 390 et 1440.

Les résultats exacts au HEAD sont dans la description de la PR.

## 9. Points à regarder en priorité

1. `agenda-view.tsx` : la délégation ne doit rien changer au Classique ni à Studio.
2. `ecrin-week.tsx` : clic sur un créneau libre (`timeAt`), bandes du changement d'heure.
3. `dial.ts` : journées très longues ou à cheval sur minuit.
4. Dépendance à #29 : toute correction de l'audit de Studio 2 sur `today-model`, `day-flow` ou `AgendaView` s'applique aussi à l'Écrin, à reporter par intégration de la branche.
5. Comme pour Studio, les notes internes restent présentes dans la charge React de la page, même masquées à l'écran.
