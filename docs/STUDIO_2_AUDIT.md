# Studio 2 : dossier d'audit (le planning mural)

Branche `feat/dashboard-studio-2`, partie du HEAD Studio 1 validé `e6c95bc` (PR #28, toujours en brouillon). La PR Studio 2 est **empilée sur `feat/dashboard-studio-1`** : son diff ne contient que Studio 2.

Plan d'ensemble : `docs/DASHBOARD_EXPERIENCE.md`. Dossier de Studio 1 : `docs/STUDIO_1_AUDIT.md`.

**Hors périmètre** : aucune migration, aucune nouvelle action serveur, aucune route API, aucune dépendance. Rien ne touche #26, #27 ni le laboratoire. Les prototypes de directions artistiques restent sur `feat/dashboard-experience`.

---

## 1. Architecture : un seul agenda, deux mises en scène

`AgendaView` (`features/agenda/components/agenda-view.tsx`) reste **le contrôleur unique** de l'agenda. Il garde intacts :

- la lecture de la période ;
- le « aujourd'hui » validé par PostgreSQL (`useCanonicalToday`, `withToday`) ;
- les panneaux, formulaires et actions ;
- l'annulation des intentions dépassées (`supersede`) ;
- l'ouverture unique par `?rdv=` ;
- les erreurs.

En style Studio, il ne fait que **déléguer le dessin** à `StudioAgenda` (`features/dashboard/agenda/studio-agenda.tsx`), à qui il passe :

| Passé à Studio                                                            | Origine                                                                                                                            |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `days`, `anchor`, `today`, `data`, `nowMs`, `loading`, `includeCancelled` | État du contrôleur, inchangé                                                                                                       |
| `onShift`, `onSelectDay`, `onToday`                                       | `navigate(...)` (qui appelle `supersede`) et `withToday(navigate)`                                                                 |
| `onOpenAppointment`, `onOpenBlock`                                        | `setPanel(...)`, les mêmes fiches                                                                                                  |
| `onCreateAt`, `onNewAppointment`, `onNewBlock`                            | `openCreateAppointment(date, time)` et `openCreateBlock()`, les mêmes formulaires                                                  |
| `banners`, `panels`                                                       | Le même JSX que le Classique (avis, erreurs, `Sheet` + `AppointmentDetails`, `AppointmentForm`, `BlockForm`), extrait en variables |
| `onRefresh`                                                               | `reload()` : relecture de la période au retour sur l'onglet (§ 6)                                                                  |
| `onView`                                                                  | Semaine ou jour sur ordinateur : `supersede()` puis changement de vue                                                              |

**Ce qui n'est pas réimplémenté** :

- disponibilités, anti-double réservation, mutations, statuts, autorisations, fuseaux, Google Calendar ;
- les validations : elles restent celles des formulaires et du serveur ;
- le placement, qui réutilise le moteur de l'agenda (`features/agenda/client/layout.ts`) :
  - `buildAxis`, avec les bandes du changement d'heure ;
  - `segmentOn` et `placeAppointments`, avec les chevauchements en couloirs ;
  - `placeBlocks`, `allDayBlocks`, `openSegments` ;
  - `yOf` et `timeAt` ;
- les heures murales, qui viennent toujours des décalages envoyés par PostgreSQL (`zoneOf`, `wallOf`).

**Classique** : son rendu est identique ; seul l'emplacement du JSX des avis et des panneaux a changé (des variables). Ses 292 tests passent sans modification.

## 2. Ordinateur : la semaine en planning mural, ou le jour en profondeur

`StudioWeekWall` (`studio-week-wall.tsx`) :

- **Une ligne par jour, le temps de gauche à droite**, sur un axe commun.
- **L'axe couvre sa semaine réelle** : de la première ouverture ou visite à la dernière, arrondi aux heures, avec un peu de marge. Rien de ce qu'elle a n'est hors du mur.
- **Fond de chaque ligne** : l'ouverture est plus claire, le reste est en sable. Les fermetures de journée entière sont hachurées. Les bandes sans heure du changement d'heure sont hachurées, avec une infobulle.
- **Visites** : de vrais boutons, posés en couloirs quand elles se chevauchent (`placeAppointments`). L'étiquette accessible donne l'heure (avec « 1re/2e fois » si l'heure est répétée), la cliente, la prestation, la durée et l'état.
  - **Texte adapté à la largeur** (container queries) : initiales sous 34 px, prénom, puis nom complet, heure et prestation quand il y a la place.
  - **Traversée de minuit** : les visites qui traversent minuit sont sur les deux lignes, avec un bord plat du côté coupé.
- **Temps bloqué** : des boutons qui ouvrent le formulaire de blocage existant.
- **Créneau libre** : un clic (pointeur) propose un rendez-vous à cette heure (`timeAt`, au quart d'heure). Le formulaire existant décide, le serveur valide.
- **Aujourd'hui** :
  - la ligne du jour est teintée ;
  - la ligne « maintenant » passe **sous** les visites, pour ne jamais masquer un nom ;
  - l'heure s'affiche en pastille sur l'échelle.
- **Étiquette du jour** : un bouton qui ouvre ce jour en vue « Jour ».
- **Compteurs** : le jour compte ses réservations distinctes qui y commencent ; l'en-tête compte celles qui commencent dans la semaine. **Jamais deux fois** une réservation à cheval sur minuit (`distinctBookings`).

**Vue jour** : le fil chronologique (§ 3), plus large, avec à côté `StudioDaySummary`, qui reste fixé :

- nombre de visites (hors annulées) ;
- temps réservé (coupé aux bornes du jour) ;
- temps libre encore réservable ;
- prochain rendez-vous (bouton vers sa fiche) ;
- temps bloqué.

## 3. Téléphone : la journée à une main

`StudioDayFlow` (`studio-day-flow.tsx`), avec le modèle pur `dayFlow` (`day-flow.ts`, testé) :

- **Un fil chronologique, pas une grille réduite.**
  - Les visites sont dans l'ordre, plus hautes quand elles sont plus longues ; les visites passées sont compactes.
  - Les chevauchements forment une rangée « En même temps · N » (côte à côte si deux, trois sur ordinateur ; empilés au-delà).
  - Pauses et fermetures apparaissent à leur place.
  - **Le temps libre encore à venir est proposé** : « Libre · 45 min », qui ouvre le formulaire existant à cette heure. Le temps libre déjà passé est seulement mentionné.
- **« Maintenant »** se place entre deux éléments, ou à l'intérieur de la visite en cours (barre d'avancement **théorique**, « fin prévue dans X »). Le **prochain rendez-vous** est encadré, avec « Prochain · dans X ».
- **Ouverture** : sur le jour d'aujourd'hui, l'écran se place directement sur ce qui compte (créneau en cours, « maintenant » ou prochain), une fois par jour affiché.
- **Navigation** :
  - bande des 7 jours (deux lettres sous 400 px), flèches de semaine (±7 jours) et balayage horizontal (jour ±1, seuils 70 px horizontaux et 45 px verticaux) ;
  - « Aujourd'hui » n'apparaît que si l'on n'y est pas, et passe par `withToday`.
- **Création** : bouton rond fixé au-dessus du dock, à portée du pouce. Le menu « ⋯ » contient « Bloquer un créneau » et « Afficher les annulés ».

## 4. États : rien d'inventé

`visitLookOf` (`visit-look.ts`) applique d'abord ses statuts, puis le temps :

| État             | Condition                                        | Aspect                    |
| ---------------- | ------------------------------------------------ | ------------------------- |
| Annulé           | `cancelled` (seulement si « annulés » est coché) | Contour, nom barré        |
| Absente          | `no_show`                                        | Fond avertissement, filet |
| Terminé          | `completed`                                      | Contour succès            |
| Passé            | Confirmé, fin ≤ maintenant                       | Contour neutre            |
| Créneau en cours | Confirmé, début ≤ maintenant < fin               | Aplat signature           |
| Confirmé         | Confirmé, à venir                                | Aplat encre               |

Un créneau commencé n'est pas une prestation commencée : il est dit « Créneau en cours », et son avancement est « théorique ». Aucun montant, aucun statut deviné.

Le **temps libre** est l'ouverture, moins ce qui occupe du temps : visites non annulées, pauses, fermetures. Une fermeture complète (aucune ouverture, ou des fermetures qui couvrent toute l'ouverture) donne « Fermé ».

## 5. Apparence, accessibilité, mouvement

- **Couleurs** : tout vient des tokens, et chaque paire texte/fond est couverte par les tests de palette.
  - L'aplat signature utilise l'encre calculée pour lui, à **pleine** opacité. Une opacité de 90 % donnait 4,06:1 avec un gris moyen ; corrigé.
  - Les hachures sont faites avec les tokens.
- **Focus** : jamais la couleur signature brute, qui peut disparaître (un jaune pâle). L'accent sert sur la page, le papier sur le dock d'encre. Règle testée sur tous les fichiers Studio ; accent à 3:1 au moins pour toute signature.
- **Navigation au clavier** :
  - toutes les visites et pauses sont de vrais boutons ;
  - les morceaux secondaires (DST, minuit) sont hors tabulation ;
  - le focus revient sur la visite après fermeture de sa fiche (Chromium).
- **Mouvement** : quelques transitions courtes au survol et à l'appui, désactivées avec `motion-reduce`. Le niveau « Aucune » de l'apparence et la préférence système s'appliquent (`data-motion`, Studio 1). Aucune animation ne retarde une action.

## 6. Retour sur l'onglet, chargements, erreurs

- **Retour sur l'onglet** : après plus d'une minute d'absence, la période affichée est relue (`reload`). Un coup d'œil ailleurs ne relit rien. La date du jour est déjà revalidée par l'agenda au réveil (`TodayTracker`).
- **Chargement** : une barre en haut de la zone. Les données de la période précédente ne sont jamais montrées sur de nouvelles dates (contrôleur).
- **Erreurs** : les mêmes messages et les mêmes « Réessayer » que le Classique (`AgendaError`, testé).
- **`?rdv=`** : comportement du contrôleur inchangé. La fiche s'ouvre une fois, sur la première lecture, jamais par-dessus un panneau ouvert entre-temps (testé en Studio).

## 7. Tests et vérifications

- **Unitaires et composants (vitest)** :
  - `day-flow.test.ts` :
    - ordre, pauses, temps libre (passé ou réservable), « maintenant » ;
    - chevauchements, annulés, minuit, fermeture partielle ou complète ;
    - `distinctBookings`.
  - `studio-agenda.test.tsx`, sur le **vrai** `AgendaView` avec des actions simulées :
    - **ordinateur** :
      - semaine (une seule requête) ;
      - fiche d'une visite et formulaire de blocage ;
      - passage jour ↔ semaine et étiquette du jour ;
      - temps libre, qui ouvre le formulaire à 11:15 ;
      - annulés ;
    - **téléphone** : fil, bouton de création, menu (bloquer, annulés), flèches ±7, bande des jours, « Aujourd'hui » ;
    - **`?rdv=`** : ouverture, et brouillon préservé ;
    - **cas difficiles** : erreur réseau, changement d'heure (les deux 2 h 30 dans l'ordre), minuit sur deux lignes et compté une fois ;
    - **retour sur l'onglet** : relecture après plus d'une minute, pas après 20 s ;
    - `isoWeek`.
  - `focus-rings.test.ts` : règle du focus.
  - Studio 1 et Classique : aucun test modifié, hormis le libellé « Cette semaine » (commit isolé) ; tous passent.
- **E2E contre le vrai backend** (CI) : `tests/e2e/studio-agenda.test.ts`.
  - déconnectée : redirection vers `/login` ;
  - en Studio, `/app` répond dans le cadre Studio, et le retour au Classique est réversible ;
  - un `?rdv=` vers le rendez-vous d'une autre entreprise ne lit rien d'elle ;
  - les liens malformés ne provoquent jamais d'erreur.

  Les outils E2E de Studio 1 sont mis en commun dans `tests/e2e/support/studio.ts`, sans changement de comportement.

- **Chromium + axe-core 4.14 (WCAG 2.1 AA)** sur l'aperçu protégé `/apercu/studio/agenda` : 100 pages, avec **0 violation, 0 erreur, 0 défilement horizontal**.
  - 6 apparences : clair, sombre, signature très claire `#FFEE00`, très sombre `#1B1B2F`, pistache sans animations, gris moyen `#808080` ;
  - 6 scénarios : semaine normale, chargée, nuit, fermeture partielle, dense (90 visites), dimanche fermé ;
  - largeurs 320, 375, 390 et 1 440 px ; vues semaine et jour.
- **Performance** (semaine dense, 90 visites, serveur de dev) : passage jour ↔ semaine en 35 à 55 ms.
- **Parcours Chromium** :
  - la fiche s'ouvre puis le focus revient ;
  - sur téléphone, le prochain rendez-vous est visible sans défiler ;
  - un balayage à gauche passe au lendemain.

## 8. Limites et besoins

- **Glisser-déposer** : non livré, volontairement. Un déplacement fiable demande :
  - la mise à jour versionnée existante (`updateAppointmentAction`, avec `expectedVersion`) ;
  - le contrôle de disponibilité du serveur ;
  - un retour visuel si c'est refusé ;
  - **aucun déplacement optimiste**.

  Architecture prête : `timeAt` donne déjà l'heure sous le pointeur, et le formulaire d'édition reste la voie sûre. À faire dans une PR dédiée, sans nouveau contrat backend si `updateAppointmentAction` suffit (à confirmer avec Claude Cloud pour les messages de conflit).

- **Création depuis un créneau** : au pointeur sur le mur (comme le Classique) et par bouton sur les créneaux libres du fil. Au clavier, on passe par « Nouveau rendez-vous ».
- **Retour sur l'onglet** : relecture de la période en Studio seulement. Le Classique garde son comportement.
- **Hachures du Classique** (`.agenda-hatch`) : couleurs fixes héritées, peu visibles en sombre. Le Studio n'en dépend pas. Hors périmètre : je l'ai laissé en l'état pour ne pas toucher au rendu du Classique.
- **Pas de Supabase local** : les parcours authentifiés passent par l'E2E de la CI ; le rendu, par l'aperçu protégé sur des semaines fictives au format exact de `getAgenda`.
