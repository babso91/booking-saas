# Écrin : dossier d'audit (le cadran)

Branche `feat/dashboard-ecrin`, synchronisée avec Studio 2 `2ee3795` (PR #29, déclarée READY par Codex). Écrin n'est pas déclaré READY : ce dossier prépare son audit. La PR Écrin est **empilée sur `feat/dashboard-studio-2`** : son diff ne contient que l'Écrin.

Plan d'ensemble : `docs/DASHBOARD_EXPERIENCE.md`. Dossiers précédents : `docs/STUDIO_1_AUDIT.md`, `docs/STUDIO_2_AUDIT.md`.

**Hors périmètre** : aucune migration, aucune nouvelle action serveur, aucune route API, aucune dépendance de production (`axe-core` en développement seulement). Deux polices Google chargées par `next/font` (Marcellus, Jost), sans préchargement. Le style Carnet n'est pas commencé.

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

Classique et Studio ne changent pas de code, à quelques lignes de routage près (`app-shell.tsx`, `today/page.tsx`, `agenda-view.tsx`). Exceptions, détaillées au § 15 : la fiche partagée et l'hôte de réservation, qui touche une ligne de `studio-shell.tsx`.

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

Ces écrans sont parcourus en CI avec de vraies données et une vraie session (§ 12). Les boutons primaires partagés restent encre, comme en Studio : la pierre marque le temps présent et le geste de création de l'agenda, l'encre marque les validations. C'est un choix de hiérarchie, conservé pour ne pas toucher au composant commun de tous les styles.

## 6. Encaissement futur

Rien n'est simulé : ni bouton, ni montant, ni mutation. La place naturelle du geste est **la fiche `AppointmentDetails`**, partagée par tous les styles, une fois le créneau terminé. L'Écrin pourra ensuite ajouter une pastille d'état sur la capsule (`looks.ts`) et un total réel dans `Holdings`, quand le backend des paiements existera.

## 7. Cas limites couverts

0, 1 et 15 rendez-vous ; jour fermé, fermeture exceptionnelle et partielle ; chevauchements ; minuit ; changement d'heure d'automne (deux 02:30 réels) ; noms très longs ; erreur réseau avec reprise ; retour sur l'onglet après plus d'une minute ; lien `?rdv=` ; cookies hostiles ; lien vers le rendez-vous d'une autre activité (e2e).

## 8. Vérifications

- `src/features/dashboard/ecrin/*.test.*` : cadran, accueil, coquille, agenda sur le vrai `AgendaView`.
- `tests/e2e/ecrin-agenda.test.ts` : backend réel en CI uniquement (pas de Docker en local).
- Chromium + axe-core 4.14 (WCAG 2.1 AA) sur `/apercu/ecrin/{agenda,aujourdhui}` : 6 teintes dont des pierres difficiles, 6 scénarios, largeurs 320, 375, 390 et 1440.

Les résultats exacts sont au § 15.

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

**Levée depuis** : l'isolation et la lecture après hydratation avec session, d'abord non prouvées, le sont par les e2e navigateur du § 12.

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
- **Erreur d'hydratation React #418 sur le cadre Classique** : analysée et corrigée au § 16.

## 15. Résultats

**CI sur `ce2635b`** (run `41252389518`), les deux jobs verts, avec le passage répété temporaire. Le HEAD final ne diffère de ce commit que par le retrait de cette étape et par la documentation ; la CI de ce HEAD est à lire sur la PR.

| Contrôle                                 | Résultat                                                            |
| ---------------------------------------- | ------------------------------------------------------------------- |
| Format, lint, types, build               | verts ; 1 avertissement antérieur (`client-hub.ts`)                 |
| Tests unitaires et de composants (local) | 1508 sur 1508                                                       |
| Montée de version (`test:upgrade`)       | 52 sur 52 (12 fichiers)                                             |
| PostgreSQL (`test:db`)                   | 990 sur 990 (27 fichiers)                                           |
| E2E (`test:e2e`)                         | 51 sur 51 (8 fichiers)                                              |
| `ecrin-agenda-browser.test.ts`, répété   | 5 passages sur 5, 21 sur 21 à chacun, serveur neuf à chaque passage |

**Stabilité.** Les trois échecs e2e successifs venaient des tests : champ date non renseigné et filtre trop large, actions serveur exécutées l'une après l'autre, Échap envoyé avant l'ouverture de la fiche. Aucun n'était un défaut applicatif ni une course de l'application. `hydrated()` recherche désormais l'élément à chaque essai. Six passages verts (suite normale comprise) montrent une stabilité sur un même environnement, pas une absence absolue de course. Le test de création ne dépend pas du jour de la semaine : l'onboarding ne crée aucun horaire.

**Modifications de ce qui est partagé.**

| Fichier                                                                  | Changement                                              | Styles touchés                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------- | --------------------------------------------- |
| `src/app/layout.tsx`                                                     | Polices Écrin, fournisseur de l'hôte                    | tous                                          |
| `agenda-view.tsx`                                                        | `designed` remplace `studio`, délégation                | Studio, Écrin ; Classique lit la même période |
| `app-shell.tsx`, `today/page.tsx`                                        | Routage vers Écrin, hôte                                | tous                                          |
| `appointment-details.tsx`                                                | Balisage `dl` valide, sans changement visuel            | tous                                          |
| `studio-shell.tsx`, trois composants d'onboarding                        | Hôte lu via `BookingHost`                               | Studio, onboarding                            |
| `appearance.ts`, `appearance-settings.tsx`, `palettes.ts`, `globals.css` | Valeur `ecrin`, sous `[data-style="ecrin"]` pour le CSS | tous pour le réglage                          |

`ci.yml` ne diffère plus de la base.

**Limites résiduelles.**

- Pas de Docker sur ce poste : les parcours avec backend ne tournent qu'en CI, sur Chromium seulement.
- L'axe utilisé ne couvre pas la règle expérimentale `label-content-name-mismatch` : le monogramme d'Écrin, comme celui de Studio, enfreint WCAG 2.5.3. Suivi dans `docs/TRANSVERSAL_FOLLOWUPS.md`, avec `periodLabel` et la distinction entre temps libre et temps réservable, qu'Écrin affiche aussi (`X libres`).
- Les notes internes restent dans la charge React, comme en Studio (§ 9).
- `bookingUrl` (`lib/brand.ts`) n'a aucun appelant. Elle porte le même piège si quelqu'un l'appelle côté navigateur.

## 16. `NEXT_PUBLIC_APP_URL` et l'erreur #418

**Cause.** Next.js n'intègre une variable `NEXT_PUBLIC_` au code que si elle existe au build. Absente au build, elle manque au navigateur (`booking.app`), alors que le serveur la lit au démarrage. Le défaut touchait aussi l'onboarding, et laissait `booking.app` affiché après la reprise de React.

**Correction.** `src/app/layout.tsx` transmet l'hôte lu par le serveur, via `components/shared/booking-host.tsx`. Le réglage ajouté dans `ci.yml` est retiré : la CI construit sans la variable et démarre avec, ce qui rejoue le cas d'échec à chaque exécution. Un test unitaire d'hydratation et un cas e2e par style complètent la protection.

Mesure sur de vrais builds de production, en cadre Classique :

| Au build    | À l'exécution | Avant                       | Après                  |
| ----------- | ------------- | --------------------------- | ---------------------- |
| absente     | présente      | #418, `booking.app` affiché | sans erreur, hôte réel |
| présente    | différente    | sans erreur, hôte du build  | identique              |
| présente    | absente       | sans erreur, hôte du build  | identique              |
| même valeur | même valeur   | sans erreur                 | identique              |

**Risque restant.** Une valeur présente au build l'emporte aussi sur le serveur : une image construite avec la mauvaise origine l'affiche sans erreur, et le code serveur (redirections d'authentification, liens des emails) lit la même valeur intégrée. Le dépôt ne contient aucune configuration de déploiement : la cohérence en staging et en production n'est donc pas vérifiée ici. Aucun environnement n'a été modifié.

## 17. Points à auditer en priorité

1. `agenda-view.tsx` : lecture élargie pour Studio et Écrin, Classique inchangé ; `restrictToDays` avec tampons.
2. `ecrin-week.tsx` : tampons (frontières de semaine, minuit, changement d'heure), non cliquables, comptés une fois ; clic sur créneau libre.
3. `dayFlow.freeMinutes` dans le cadran, et son libellé.
4. Isolation entre établissements après hydratation : suffisance de `forbidden` et de la capture réseau.
5. `booking-host.tsx` et `layout.tsx` : pages statiques, onboarding, absence de lecture d'environnement côté navigateur.
6. Protection du brouillon face à `?rdv=` : les deux scénarios à lecture retenue.
7. Fiche partagée et écrans secondaires : non-régression Classique et Studio, contraste du mode sombre.
8. Contrat d'apparence : compatibilité avec la PR #31 et les valeurs `classique`, `studio`, `ecrin`, `carnet`.
