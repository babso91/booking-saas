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

**Limite connue** : ces écrans lisent le serveur. Hors Apparence, je ne les ai vus localement que dans leur état d'erreur, sans leurs données (pas de Supabase local). Leur réponse HTTP avec le cookie Écrin dépend de la CI (`/app`, `/app/today`) ; les autres routes n'y sont pas parcourues. Les boutons primaires partagés restent encre, comme en Studio : la pierre marque le temps présent et le geste de création de l'agenda, l'encre marque les validations. C'est un choix de hiérarchie, conservé pour ne pas toucher au composant commun de tous les styles.

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

## 10. Stabilisation avant audit

**Échec e2e sur `ac3f5ac`.** Le HTML en échec portait `data-style="ecrin"` : aucune fuite entre styles. Le cookie fautif, `x.y.z.w.ecrin`, a un style valide et `parseAppearance` lit chaque champ séparément. L'assertion était fausse. Le test vérifie désormais :

- le `data-style` réellement écrit et la classe `ecrin-ground` de l'enveloppe ;
- six valeurs interdites (`constructor`, `__proto__`, `ECRIN`, espace encodé, `carnet`, injection HTML), qui donnent toutes `classique`.

**Échec de typecheck sur `6a62be6`.** La CI compile la PR fusionnée avec sa base, déjà passée à Studio 2 `2ee3795`. Cette base utilise la variable `studio` dans `AgendaView`, que j'avais renommée. Git ne voyait aucun conflit. La variable est rétablie.

**Boutons primaires** : voir § 5.

**Vérifications après hydratation** (Chromium sur les aperçus) : valeurs hostiles, allers-retours Écrin, Studio, Classique sans reste d'enveloppe ni de police, menu d'options dans l'écran, fiche, retour à aujourd'hui, fin de journée accessible au-dessus des commandes du pouce, à 320, 375 et 390 px.

**Limite** : tant que le navigateur connecté au vrai backend n'est pas disponible sur cette branche (Playwright arrive avec Studio 2), l'isolation et la lecture après hydratation avec session restent à prouver par un e2e navigateur Écrin. Les e2e actuels d'Écrin lisent le HTML de la première réponse ; ils ne suffisent pas à eux seuls à prouver l'isolation.

## 11. Synchronisation avec Studio 2

Studio 2 validé par Codex (`2ee3795`, READY) est intégré par un merge, sans réécriture d'historique. Git n'a signalé aucun conflit ; le résultat est compilé et testé.

| Adaptation            | Résultat                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lecture élargie       | `AgendaView` lit la veille pour Studio et Écrin (`designed`). Le Classique lit la même période qu'avant.                                                                        |
| Temps libre du cadran | `DaySays` utilise `flow.freeMinutes` ; un intervalle de 4 min compte sans être proposé (testé).                                                                                 |
| Semaine               | Tampon dessiné en queue pointillée sous la visite, distinct des pauses hachurées. Pas une cible de clic, aucun formulaire ne s'ouvre (testé). Une visite annulée ne garde rien. |
| Fil                   | « Maintenant » suit l'état affiché, annulée ou non ; visite en cours, chevauchements et minuit testés.                                                                          |

La validation serveur reste l'autorité finale : l'interface ne duplique aucune règle de réservation.

## 12. Parcours navigateur avec session réelle

Exécutés uniquement en CI (Supabase local et `next start` ; pas de Docker sur ce poste).

- `tests/e2e/ecrin-agenda-browser.test.ts` : hydratation et vrais rendez-vous, fiche et retour du focus, accueil vers fiche, isolation entre établissements avec inspection des réponses réseau, création puis refus d'un chevauchement (page et base), brouillon protégé contre `?rdv=`, liens malformés, retour sur l'onglet, changement de style avec rechargement, cookies interdits, axe clair et sombre, téléphone à 320, 375 et 390 px.
- `tests/e2e/ecrin-secondary-browser.test.ts` : Clientes (liste, ajout, fiche), Prestations, Fidélité, Horaires, Calendar, Apparence, sur ordinateur et téléphone, en clair et en sombre, avec axe sur les écrans et les panneaux. Aucune sauvegarde.

`axe-core` devient une dépendance de développement explicite (même version que celle déjà présente dans l'arbre).

## 13. Contrat d'apparence

Les valeurs `classique`, `studio` et `ecrin` sont actives. `carnet` n'existe pas encore : un cookie qui la porte retombe sur `classique`, sans erreur (testé), et l'ajouter à `styleIds` suffira le moment venu. Le format du cookie ne change pas. La PR #31 n'est pas intégrée.

## 14. Ce que les parcours réels ont révélé

- **Fiche partagée** : `AppointmentDetails` avait une liste de définitions invalide (`dl > div > div > dt`), tous styles confondus. Chaque ligne a désormais sa propre `dl`, sans changement visuel.
- **Erreur d'hydratation React #418 sur le cadre Classique** : `next build` sans `NEXT_PUBLIC_APP_URL`, puis `next start` avec cette variable. Le serveur et le navigateur n'écrivent pas le même hôte de réservation. Reproduit localement sur un build de production ; Écrin et Studio n'affichent cet hôte que dans une feuille fermée. La CI construit maintenant avec la même origine. **Point de vigilance hors de cette PR** : tout déploiement doit fournir cette variable dès le build.
