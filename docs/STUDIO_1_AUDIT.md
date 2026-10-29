# Studio 1 : dossier d'audit

Branche `feat/dashboard-studio-1`, basée sur `main` à `249aff1`. Trois commits :

1. **Fondations d'apparence** : tokens, ambiances, accent lisible, niveaux d'animation, cookie, page Apparence, aperçus protégés.
2. **Studio 1** : choix du style, coquille Studio, page « Aujourd'hui » branchée sur l'agenda réel.
3. **Renforcement** : chevauchements, confidentialité des notes, lien direct vers un rendez-vous, états honnêtes, journée chargée.

Ce dossier sert à contrôler l'architecture, les régressions et l'isolation des données. Le plan d'ensemble est dans `docs/DASHBOARD_EXPERIENCE.md`.

**Hors périmètre :**

- Les prototypes de directions artistiques restent sur `feat/dashboard-experience`. Ils ne sont pas dans cette PR.
- Rien ne touche aux PR #26 et #27 ni au laboratoire `proto/experience-engine`. Quatre fichiers sont aussi modifiés par #26 (`globals.css`, `icons.tsx`, `sheet.tsx`, `client-profile.tsx`). Une fusion d'essai (`git merge-tree`) avec #26 et avec #27 ne donne aucun conflit, quel que soit l'ordre de fusion.
- Aucune migration, aucun déploiement, aucune nouvelle dépendance.

---

## 1. Intégration de Studio dans le dashboard existant

Le principe : **un moteur métier unique, plusieurs mises en scène.** Studio ne réimplémente aucune règle. Il lit les mêmes données, par les mêmes fonctions, et renvoie vers l'agenda existant pour toute action.

| Couche      | Ce qui change                                                                                                           | Ce qui ne change pas                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Préférence  | `Appearance.style` (`classique` par défaut, `studio`) dans le cookie `dash_appearance`                                  | Aucune donnée serveur                                                                                                   |
| Thème       | Studio a ses propres neutres (`studioPalettes`) et une couleur signature (`--signature`, `--on-signature`)              | Les composants ne connaissent que les tokens sémantiques                                                                |
| Typographie | `[data-style="studio"]` passe le corps en Archivo et met les `.font-display` en condensé noir majuscule (`globals.css`) | Classes des composants inchangées                                                                                       |
| Coquille    | `AppShell` rend `StudioShell` quand le style est Studio (`features/dashboard/components/studio-shell.tsx`)              | La branche Classique d'`AppShell` est identique (seul le type `Section` est partagé : `features/dashboard/sections.ts`) |
| Accueil     | Nouvelle page `/app/today` (Studio uniquement)                                                                          | `/app` reste l'agenda, pour les deux styles                                                                             |
| Agenda      | Un seul ajout : `?rdv=<uuid>` ouvre le panneau de détails d'un rendez-vous déjà lu (voir § 2)                           | Grille, formulaires, actions, protections (versions, jour canonique, DST) : intacts                                     |

Le style est porté par `data-style` sur l'enveloppe de l'espace et sur `<html>` (pour les feuilles rendues dans `<body>`). Il est retiré quand on quitte `/app` (`appearance-provider.tsx`).

## 2. Comment les vraies données alimentent l'accueil

`src/app/(dashboard)/app/today/page.tsx`, composant serveur :

1. `requireReadyBusiness()` : session validée côté Supabase Auth, entreprise résolue par `business_members` sous RLS. C'est la même garde que toutes les pages `/app`.
2. Si le style n'est pas Studio, la page redirige vers `/app`.
3. `readBusinessToday(client, business.id)` : la date civile et l'instant « maintenant » viennent de PostgreSQL, qui fait autorité pour le calendrier. L'horloge du serveur Node n'est pas utilisée.
4. `getAgenda(client, { businessId, timezone }, { semaine de lundi à dimanche, includeCancelled: false })` : **exactement la fonction de lecture de l'agenda** (`features/agenda/data/agenda.ts`), avec le client Supabase de l'utilisatrice (JWT, RLS membres). Plafonds explicites, refus plutôt que troncature.
5. Le DTO est passé tel quel au composant client `StudioToday`.

**Isolation des données :**

- Aucune nouvelle requête SQL, aucune nouvelle action serveur, aucune nouvelle route API, aucun usage de clé de service.
- `businessId` vient uniquement de la session, jamais de l'URL ni du client. La page `/app/today` ne lit aucun paramètre d'URL.
- `?rdv=` (agenda) : seul un UUID bien formé est retenu (`requestedAppointment`). L'agenda l'ouvre **uniquement si ce rendez-vous figure dans sa propre lecture**, faite sous RLS. Un id d'une autre entreprise est simplement introuvable : rien ne s'ouvre et aucune requête n'est faite. Le panneau ne s'ouvre qu'une fois, sur la première réponse (testé).
- Aperçus `/apercu/*` : données fictives en mémoire (`features/dashboard/fixtures/sample-week.ts`), aucune lecture ni écriture. Ils renvoient une 404 en production sauf si `DASHBOARD_PREVIEW=1`, sont marqués `noindex` et rendus dynamiquement.

**Calcul (pur, testé)** : `features/dashboard/client/today-model.ts`, appelé avec `todayModel(agenda, date, now)`.

- **Visites du jour** : rendez-vous non annulés qui couvrent une partie de cette date civile, selon les bornes réelles du jour envoyées par PostgreSQL (journées de 23 h ou 25 h comprises). Une visite qui traverse minuit (23 h 30 → 1 h 30) figure sur les deux jours, marquée « depuis hier » ou « jusqu'à demain ». Triées par instant.
- **État de chaque visite :**
  - `done` si elle est `completed` ou `no_show`, ou si elle est finie ;
  - `now` si elle a commencé et n'est pas finie ;
  - `upcoming` sinon.
    Toutes les comparaisons se font **entre instants**.
- **« Maintenant » en heure murale** : `wallOf(zone, now)` avec les décalages envoyés par PostgreSQL, comme la ligne « maintenant » de l'agenda. Le fuseau du navigateur n'est jamais utilisé.
- **Frise** : l'ouverture réelle du jour (`openRanges`), élargie à toute visite qui en déborde. Les repères horaires sont posés en instants réels et étiquetés à l'heure murale (une heure répétée lors du changement d'heure est marquée deux fois).
- **Chevauchements** : partition en lignes (`lane` / `lanes`) par groupe de visites qui se recouvrent.
- **Remplissage de la semaine** : minutes ouvertes (somme des `openRanges`) et minutes réservées (somme des `durationMinutes` non annulées), jour par jour.
- **Aucun montant.** Un rendez-vous réservé n'est pas un encaissement : les chiffres d'argent attendront le journal des encaissements (backend Claude Cloud, `docs/DASHBOARD_EXPERIENCE.md` § 5). Un test vérifie qu'aucun « € » n'apparaît.

**Fraîcheur :**

- Re-rendu toutes les 30 s pour faire avancer l'heure.
- `router.refresh()` toutes les 5 min (onglet visible) et au retour sur l'onglet : un rendez-vous pris entre-temps n'est pas manqué.
- `router.refresh()` dès que minuit est passé dans le fuseau de l'entreprise.
- Premier rendu avec l'instant de PostgreSQL (`getServerSnapshot`), donc sans écart d'hydratation.

## 3. Classique et Studio

|                       | Classique (défaut)                                     | Studio                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Accueil               | L'agenda (`/app`)                                      | « Aujourd'hui » (`/app/today`)                                                                                                                                                                   |
| Navigation ordinateur | Barre latérale                                         | Nom en titre + dock flottant (Aujourd'hui, Agenda, Clientes, Prestations, Fidélité) + feuille (Horaires, Google Calendar, Apparence, page de réservation, déconnexion) ouverte par le monogramme |
| Navigation téléphone  | Barre d'onglets + feuille « Compte »                   | Dock (Aujourd'hui, Agenda, Clientes, Plus) + même feuille                                                                                                                                        |
| Couleurs              | Ambiance (Atelier, Lin, Sauge) × clair/sombre + accent | Neutres Studio × clair/sombre + couleur signature (aplats)                                                                                                                                       |
| Typographie           | Hanken Grotesk + Instrument Serif                      | Archivo, de condensé à élargi                                                                                                                                                                    |
| Écrans secondaires    | Inchangés                                              | Mêmes composants, habillés par les tokens et la typo Studio                                                                                                                                      |

Invariants : mêmes rubriques, mêmes adresses, mêmes mots (`sections.ts`). Changer de style est instantané et réversible, depuis Apparence.

## 4. Persistance actuelle des préférences

- **Cookie `dash_appearance`**, propre à l'appareil :
  - non `HttpOnly`, car il est écrit par le client au changement ;
  - `Path=/app`, `Max-Age` d'un an, `SameSite=Lax`, `Secure` en HTTPS ;
  - format `ambiance.mode.motion.accent.style`.
- **Lecture stricte** (`parseAppearance`) : chaque valeur est vérifiée dans une liste fermée, sinon la valeur par défaut s'applique. L'accent doit être `#rrggbb`. Le CSS est généré **uniquement** à partir des valeurs validées (test d'injection : `…;}body{display:none`). Un cookie à quatre champs, écrit avant l'arrivée des styles, est lu en Classique.
- **Rendu côté serveur** (le layout `/app` lit le cookie) : le premier affichage est déjà le bon, sans flash.
- **Ce que le cookie contient** : de la présentation uniquement, aucune donnée personnelle ni sensible.
- **Pas encore synchronisé entre appareils** : c'est la PR « Préférences synchronisées » (table par membre, RLS, côté Claude Cloud).

## 5. Routes et navigation mobile

| Route                             | Rôle                                                                                                            |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/app/today`                      | Accueil Studio. Redirige vers `/app` en Classique                                                               |
| `/app?date=AAAA-MM-JJ&rdv=<uuid>` | Agenda ouvert sur ce jour, détails du rendez-vous ouverts. `rdv` est ignoré si absent de la lecture             |
| `/app/settings/appearance`        | Style, ambiance (Classique), clair/sombre, couleur, animations                                                  |
| `/apercu/studio/aujourdhui`       | Aperçu protégé. Paramètres : `?heure=HH:MM`, `?jour=AAAA-MM-JJ`, `?jeu=charge`, `?apparence=<valeur du cookie>` |
| `/apercu/apparence`               | Aperçu protégé de la page Apparence (`?apparence=`)                                                             |

**Mobile :**

- Le dock est fixé en bas, dans la zone du pouce, avec des cibles de 44 px et les marges de sécurité iOS. La zone principale réserve sa hauteur.
- **Le prochain rendez-vous s'atteint en un geste** : le bloc couleur affiche la visite en cours et la suivante, chacune avec un bouton « Voir le rendez-vous » qui ouvre directement ses détails dans l'agenda. Chaque ligne de la liste du jour y mène aussi.
- Vérifié à 320, 390 et 1440 px, sans défilement horizontal.

## 6. États de la journée

| Phase                 | Condition                         | Bloc couleur                                                                                                                                                                                                                                |
| --------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before`              | Aucune visite passée, une à venir | « Premier rendez-vous · HH:MM », cliente, « dans X », bouton ; puis la suivante                                                                                                                                                             |
| `during` (une visite) | Un créneau commencé et pas fini   | « Créneau en cours », cliente, prestation, **avancement théorique** (« fin prévue dans X »), bouton ; « Ensuite ». Un créneau confirmé qui a commencé n'est pas une prestation dont on sait qu'elle a commencé : aucun statut n'est inventé |
| `during` (plusieurs)  | Créneaux qui se chevauchent       | « Créneaux en cours · N » et **toutes** les clientes avec leur heure de fin. **Pas de barre unique**, qui serait trompeuse                                                                                                                  |
| `between`             | Entre deux visites                | « Ensuite · HH:MM », « dans X », bouton ; « Puis »                                                                                                                                                                                          |
| `after`               | Toutes les visites sont passées   | « Journée terminée · N rendez‑vous »                                                                                                                                                                                                        |
| `free`                | Aucune visite                     | « Journée libre · Rien de prévu » ; « Jour de fermeture · Repos » sans horaires ce jour-là ; « Fermeture exceptionnelle » (avec son motif) quand ses fermetures couvrent toute l'ouverture                                                  |
| Minuit passé          | `nowTime` absent                  | L'heure affiche « ··.·· » le temps de la relecture                                                                                                                                                                                          |

Une visite `completed` ou `no_show` est rangée dans le passé, même avant son heure de fin. La liste distingue « Terminé », « Absente » et « Passé » (passée sans statut). Elle ne prétend jamais qu'une visite est terminée si ce n'est pas le cas.

**Notes clientes (sensibles)** : le bloc couleur, lisible de loin, n'affiche **jamais** le contenu d'une note, seulement la mention « Note » sur le bouton du rendez-vous. La section « À ne pas oublier » n'affiche que le nombre de notes. Leur contenu n'est rendu (pas seulement masqué) que lorsqu'elle clique sur « Afficher », et il est retiré quand elle quitte la page.

## 7. Tests et vérifications

- **Unitaires et composants (vitest)** : la suite complète passe (chiffres à jour dans la PR), dont :
  - apparence : 600 couleurs signature aléatoires, chaque paire texte/surface à 4,5:1 au moins, cookie hérité, valeurs inconnues ;
  - modèle du jour : toutes les phases, annulations, absences, minuit, journée fermée, débordement de l'ouverture, chevauchements, remplissage, notes ;
  - `StudioToday` : liens directs, notes masquées puis affichées, aucun montant, journée chargée ;
  - coquille Studio : dock, `aria-current`, feuille ;
  - agenda `?rdv=` : ouverture, id inconnu, ouverture unique.
- **Typage, lint et build** : `typecheck` et `next build --webpack` passent. Il reste un seul avertissement de lint, antérieur et hors de cette PR (`client-hub.ts`).
- **Chromium + axe-core 4.14 (WCAG 2.1 AA)** : 0 violation, 0 erreur de console, 0 défilement horizontal, sur :
  - les cinq phases ;
  - la journée chargée à 14 h 05 et à 21 h ;
  - le jour fermé ;
  - la page Apparence ;
  - 7 apparences (dont un jaune `#FFEE00` et le sombre) ;
  - 3 largeurs (320, 390, 1440 px).
- **Journée chargée** (`?jeu=charge`) : 13 visites dont 3 simultanées, une prestation de 4 h qui commence avant l'ouverture, une visite après la fermeture, une annulation, deux pauses, des noms, prestations et notes très longs.

## 8. Limites (pas de Supabase local)

- **Pas de bout en bout authentifié.** Ni Docker ni Supabase en local : `/app/today` et `/app?rdv=` n'ont pas été exercés contre une vraie base. Le code est vérifié par :
  - les types ;
  - le build ;
  - les tests sur des DTO au format exact de `getAgenda` (fixtures de l'agenda et semaine fictive) ;
  - le rendu réel des mêmes composants dans `/apercu`.

  Recommandation : un passage manuel sur staging (avec ton accord) ou un test e2e authentifié une fois Supabase disponible en CI.

- **Visites qui traversent minuit** : corrigé après l'audit, voir § 10.
- **Heure de l'appareil.** « Maintenant » vient de l'horloge de l'appareil, convertie avec les décalages de PostgreSQL, comme la ligne « maintenant » de l'agenda. Un appareil mal réglé décale l'état « en cours ». Les décisions qui comptent (dates des actions) restent validées par PostgreSQL dans l'agenda.
- **Préférences par appareil**, non synchronisées (voir § 4).
- **En Studio, l'agenda garde sa grille actuelle**, habillée aux couleurs du Studio. Le planning mural est la PR suivante (Studio 2), sur les mêmes actions et protections.
- **Pas de montants** tant que le journal des encaissements n'existe pas.

## 9. Points d'attention pour l'audit

1. Le **balayage des couleurs** (fondations, 23 fichiers) : remplacement mécanique de valeurs littérales par des tokens. Atelier clair garde exactement les valeurs historiques (test). À regarder pour les régressions visuelles en Classique.
2. **`AgendaView`** : seul ajout, la prop `initialAppointmentId`, consommée une fois dans le rappel de la première lecture. Aucune règle, action ni protection modifiée.
3. **Isolation** : aucune nouvelle lecture. `/app/today` réutilise `getAgenda` et `readBusinessToday` avec le client RLS de la session.
4. **Cookie** : lecture stricte, CSS généré uniquement à partir des valeurs validées.
5. **Aperçus** : 404 en production sauf `DASHBOARD_PREVIEW=1`, données fictives uniquement.

## 10. Corrections après l'audit Codex #28

Audit de `0d08f5a` : 0 BLOCKER, 5 IMPORTANT, 2 MINOR. Un commit par correction, chacun avec un test qui échoue sur l'ancien code et passe sur le nouveau.

| #   | Défaut                                                                       | Correction                                                                                                                                     | Reproduction                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Une réponse tardive de `?rdv=` remplaçait un formulaire commencé entre-temps | Toute interaction (panneau ouvert, jour changé) annule l'ouverture en attente (`supersede`) ; les détails ne s'ouvrent que sur un panneau vide | `agenda-view.test.tsx` : brouillon saisi pendant la lecture, puis réponse → le formulaire et son texte restent                                                                                          |
| 2   | Prestations inaccessible sur téléphone                                       | Prestations dans la feuille « Plus » sous 768 px ; dock plus serré sous 360 px                                                                 | `studio-shell.test.tsx` (chaque rubrique atteignable aux deux largeurs) ; Chromium : 8/8 rubriques visibles et cliquables à 320, 390, 768 et 1 440 px (avant : Prestations absente à 320 et 390)        |
| 3   | Boutons illisibles au survol en sombre                                       | Survol, désactivé et succès dérivés des tokens, pour Studio **et** Classique (plus aucune couleur fixe)                                        | `button-contrast.test.ts` lit les classes de chaque variante : 4 états × 12 combinaisons style/ambiance/mode. Chromium (survol, focus, actif) : avant, 1,13 à 1,35:1 en sombre ; après, ≥ 4,5:1 partout |
| 4   | Rendez-vous traversant minuit absent                                         | Bornes réelles du jour (PostgreSQL) ; présent les deux jours ; frise limitée au jour ; minutes comptées sur le jour où elles tombent           | `today-model.test.ts` et `studio-today.test.tsx` : 23 h 30 → 1 h 30, mardi 22 h et mercredi 0 h 30                                                                                                      |
| 5   | Faux état « En cours »                                                       | « Créneau en cours », avancement « théorique », « fin prévue dans X » ; « Terminé » seulement si elle l'a marqué                               | `studio-today.test.tsx` : plus aucun « En cours » affirmé, libellés du bloc et de la liste                                                                                                              |
| 6   | Fermeture exceptionnelle confondue avec une journée vide                     | `closure` : `weekly` ou `exceptional` (avec motif) ; remplissage mesuré sur le temps **réservable** (ouverture moins fermetures et pauses)     | `today-model.test.ts` : jeudi fermé (« Formation ») ≠ jour ouvert sans rendez-vous ; mardi = 600 − 75 min réservables                                                                                   |
| 7   | Cookie `constructor`, `toString`, `__proto__` → erreur 500                   | `Object.hasOwn` au lieu de `in`                                                                                                                | `appearance.test.ts` (6 valeurs) ; Chromium : avant, 500 sur `toString…` et `hasOwnProperty…` ; après, 200                                                                                              |

**E2E contre le vrai backend** (nouveau, exécuté par la CI avec Supabase) : `tests/e2e/studio-today.test.ts`.

- Déconnectée, `/app/today` renvoie vers `/login`.
- En Studio, la page affiche **son** créneau en cours, lu par sa propre lecture RLS. Ni le nom ni l'identifiant d'un rendez-vous d'une autre entreprise n'apparaissent, même dans le payload.
- En Classique, `/app/today` renvoie vers `/app`.
- Les cookies d'apparence hostiles ne provoquent jamais d'erreur 500, sur `/app`, `/app/today` et `/app/settings/appearance`.

C'est la première exécution authentifiée de bout en bout de Studio 1. Elle réduit la limite du § 8.

**CI** : les trois tests calendaires qui échouaient déjà sur `main` sont corrigés par le commit de #27 (`7462aaa`), reporté à l'identique (`git cherry-pick -x`) dans un commit séparé. Les quatre fichiers de tests ont un patch identique octet pour octet, et #27 n'est pas modifiée.

**Confidentialité des notes : la différence exacte.** Les notes ne sont jamais _affichées_ dans les grandes zones, et leur liste n'est rendue qu'à la demande. Mais elles **sont présentes dans le payload React** : `getAgenda` renvoie `internalNotes`, et le DTO complet est passé au composant client.

- Concrètement, une personne qui inspecte la page ou le réseau sur la session de la professionnelle peut les lire.
- Les autorisations, elles, ne changent pas : seule une membre de l'entreprise reçoit ces données (RLS), exactement comme pour l'agenda, qui les reçoit aussi.
- Pour les retirer du payload, il faudrait ne pas transmettre `internalNotes` à l'accueil et les charger à la demande. L'action existante `getAgendaAppointmentAction` (RLS) le permet sans nouvelle API, mais c'est un changement de contrat à coordonner. Rien n'a été ajouté sans cette coordination.

## 11. Contre-audit de `fc24a56` : 0 BLOCKER, 1 IMPORTANT, 2 MINOR

Passe strictement ciblée. Chaque défaut est reproduit sur l'ancien code, en vitest et dans Chromium, puis corrigé.

| #   | Défaut                                                                                     | Cause                                                                                                                         | Correction                                                                                                                                                                                                                                                                                                                                                        | Reproduction (avant → après)                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Une réservation du mardi 23 h 30 au mercredi 1 h 30 donnait « Cette semaine : 2 »          | Le compteur additionnait les visites **par jour**, et cette réservation est (à juste titre) sur deux jours                    | `weekVisits` : réservations **distinctes par identifiant**, non annulées, comptées dans la semaine où elles **commencent** (bornes réelles des jours PostgreSQL). Les vues quotidiennes et la répartition des minutes ne changent pas                                                                                                                             | vitest : 27 → 26. Semaine du changement d'heure : les deux 02:30 de l'heure répétée comptent pour 2, et dimanche 23 h 30 → lundi 1 h 30 compte pour 1. Frontière de semaine : présente le lundi suivant, mais non recomptée. Annulée : exclue. Chromium à 320, 390 et 1 440 px : 27 → 26 |
| 2   | Fermeture partielle invisible sans rendez-vous (« Journée libre » à 11 h, fermé 10 h–12 h) | Seules les fermetures **complètes** étaient signalées, et la frise (qui montre les fermetures) n'apparaît qu'avec des visites | `closures` : les fermetures exceptionnelles qui couvrent une **partie** du jour, à l'heure murale. Le bloc couleur affiche « Fermeture partielle » et « Fermé de 10:00 à 12:00 · Formation. Le reste de la journée est libre. ». « Ta journée » le rappelle aussi, avec ou sans rendez-vous. Le temps réservable et le remplissage (déjà validés) ne changent pas | vitest : jour libre, fermé, partiellement fermé, partiellement fermé avec rendez-vous. Chromium : « Journée libre » → « Fermeture partielle »                                                                                                                                            |
| 3   | « jusqu'à demain 01:30 » disparaissait sur mobile                                          | La mention était dans la même ligne tronquée que le nom de la prestation                                                      | La mention temporelle a **sa propre ligne**, jamais tronquée. Seul le nom de la prestation peut l'être                                                                                                                                                                                                                                                            | vitest : la mention n'est plus dans un élément `truncate`. Chromium à 320 et 390 px, avec un nom et une prestation très longs : mention entière, dans l'écran, sans défilement horizontal                                                                                                |

**Les quatre cas de journée** :

- **vraiment libre** : « Journée libre · Rien de prévu » ;
- **entièrement fermée** : « Jour de fermeture · Repos », ou « Fermeture exceptionnelle » avec son motif ;
- **partiellement fermée sans rendez-vous** : « Fermeture partielle », avec le créneau fermé et son motif ;
- **avec rendez-vous et une fermeture partielle** : le bloc couleur garde le rendez-vous, et « Ta journée » affiche la fermeture, que la frise montre aussi.

Les pauses (« blocked ») restent dans la frise et dans le temps réservable, mais ne déclenchent pas la mention « Fermeture partielle ». Un déjeuner n'est pas une fermeture.

**Autres indicateurs vérifiés** :

- « Aujourd'hui » et « Pris en ligne » comptent les visites **du jour** : une visite à cheval sur minuit compte une fois par jour, comme le demande la vue quotidienne.
- Le remplissage répartit les minutes entre les jours, sans double compte.
- Seul le compteur de la semaine additionnait des jours : c'est celui qui est corrigé.

**Non-régression** :

- les vérifications Chromium du premier audit passent toujours : les 8 rubriques atteignables, des boutons à 4,5:1 au moins dans tous les états, aucune erreur 500 avec un cookie piégé ;
- états de journée (« Créneau en cours », « Jour de fermeture », « Journée terminée ») ;
- axe-core 4.14 : 0 violation, nouveaux scénarios compris ;
- aperçu protégé : nouveaux jeux fictifs `?jeu=nuit` et `?jeu=formation`.
