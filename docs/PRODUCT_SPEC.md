# Cahier des charges produit — SaaS de réservation et fidélisation beauté

**Statut :** source de vérité produit pour la V1  
**Cible initiale :** indépendantes du secteur beauté  
**Premier cas réel :** technicienne cils disposant déjà d'une clientèle  
**Langue et marché initiaux :** français, devise EUR, fuseau configurable (Europe/Paris par défaut)

## 1. Vision

Le produit est un outil ultra-simple permettant aux indépendantes beauté de prendre leurs rendez-vous, gérer leurs clientes et surtout les faire revenir. Il ne doit pas être présenté comme un simple clone de Planity ou Booksy.

La boucle de valeur centrale est :

> Une cliente réserve → elle vient → le rendez-vous est marqué terminé → elle gagne automatiquement des points → elle se rapproche d'une récompense ou la débloque → elle est incitée à reprendre rendez-vous → si elle ne revient pas, elle peut être relancée.

La réservation est le point d'entrée. La fidélisation et la rétention sont le différenciateur.

## 2. Périmètre de la V1

La V1 doit être réellement utilisable de bout en bout : base de données, authentification professionnelle, réservation publique, agenda, clientes, fidélité et emails automatiques.

Sont explicitement hors périmètre :

- SMS ;
- applications iOS ou Android natives ;
- marketplace ;
- paiement en ligne ;
- gestion de plusieurs employés ;
- caisse et comptabilité ;
- intelligence artificielle ;
- fidélité à niveaux Bronze/Silver/Gold ;
- intégrations non indispensables ;
- fonctions enterprise.

## 3. Proposition technique souhaitée

- Next.js et TypeScript ;
- Supabase PostgreSQL, Auth, Row Level Security et Storage si nécessaire ;
- Vercel pour l'hébergement ;
- Resend pour les emails ;
- Tailwind CSS et composants réutilisables ;
- Cron, Edge Functions ou équivalent simple et robuste pour les traitements programmés ;
- versions stables et compatibles au moment du développement.

n8n ne doit pas être introduit sans nécessité démontrée.

## 4. Multi-tenant et sécurité

Le backend est multi-tenant dès la première version. Toutes les données métier appartiennent à un `business_id`. Une professionnelle ne doit jamais lire ou modifier les données d'un autre business, même en manipulant une URL ou une requête.

Exigences :

- politiques Supabase RLS sur toutes les tables exposées ;
- contrôles de tenant côté base et côté serveur ;
- validation serveur avec Zod ou équivalent ;
- contraintes de base contre les doubles réservations ;
- tokens clientes non devinables, dont seule une empreinte est stockée ;
- aucune clé secrète dans le navigateur ;
- clé `service_role` uniquement dans du code serveur explicitement isolé ;
- entrées validées et erreurs correctement gérées ;
- aucune ressource privée accessible par identifiant seul ;
- tests d'isolation entre au moins deux businesses.

Le frontend n'est jamais une frontière de sécurité.

## 5. Utilisateurs et accès

### Professionnelle

- possède un compte authentifié Supabase Auth ;
- accède à un espace privé ;
- appartient à un business via une relation explicite de membre.

### Cliente

- ne crée pas de compte en V1 ;
- réserve sur la page publique du business, par exemple `/b/jadebeauty` ;
- peut consulter sa fidélité via un lien sécurisé et révocable ;
- l'architecture doit permettre l'ajout ultérieur d'un espace cliente.

## 6. Onboarding et paramètres du business

La professionnelle peut renseigner et modifier :

- nom de l'activité et slug public ;
- prénom et nom ;
- logo ou photo facultative ;
- description ;
- email ;
- adresse ou localisation facultative ;
- horaires habituels et jours travaillés ;
- plusieurs plages horaires par jour si nécessaire ;
- buffer éventuel entre deux rendez-vous ;
- délai minimal avant réservation ;
- horizon maximal de réservation ;
- politique d'annulation ;
- paramètres de fidélité ;
- seuil de réactivation parmi 30, 45, 60 ou 90 jours ;
- activation explicite des relances automatiques.

## 7. Prestations

CRUD complet avec, au minimum : `id`, `business_id`, nom, description facultative, durée en minutes, prix, statut actif/inactif et ordre d'affichage.

Les prestations inactives ne sont jamais proposées publiquement. Exemples : pose cil à cil, volume mixte, remplissage trois semaines, dépose.

## 8. Page publique

La page publique est mobile-first, minimale, moderne et premium, avec beaucoup d'espace, une excellente typographie, des animations discrètes et un responsive soigné.

Elle présente :

- identité, photo/logo et description du business ;
- prestations actives, prix et durée ;
- informations pratiques et politique d'annulation ;
- appel à l'action « Prendre rendez-vous ».

## 9. Réservation publique

Parcours :

1. choisir une prestation ;
2. choisir une date ;
3. voir uniquement les horaires réellement disponibles ;
4. choisir un horaire ;
5. saisir les informations cliente ;
6. confirmer et afficher un succès.

Informations cliente : prénom obligatoire, nom facultatif, email obligatoire, téléphone facultatif. La cliente est créée ou retrouvée par email à l'intérieur du business concerné.

Le calcul des disponibilités tient compte de la durée, des horaires, des plages multiples, des exceptions, des périodes bloquées, des rendez-vous existants et du buffer. Deux clientes ne peuvent jamais réserver des créneaux qui se chevauchent ; la protection est transactionnelle et garantie par PostgreSQL, pas seulement par l'interface.

Après réservation : création du rendez-vous et de la cliente si nécessaire, association des deux, email de confirmation et page de succès.

## 10. Agenda

Vues minimales : aujourd'hui, semaine et prochains rendez-vous.

Un rendez-vous affiche cliente, prestation, heure, durée, prix et statut. Statuts : `confirmed`, `completed`, `cancelled`, `no_show`.

La professionnelle peut :

- créer manuellement, modifier et déplacer un rendez-vous ;
- annuler, marquer terminé ou marquer no-show ;
- bloquer une période ;
- ajouter une note interne facultative.

Une modification ou annulation déclenche l'email approprié.

## 10 bis. Synchronisation avec les agendas externes — prévue

### Vision et sources de vérité

Le SaaS possède son propre moteur de réservation et reste la source de vérité pour les rendez-vous clientes. Les calendriers externes servent à importer les indisponibilités personnelles/professionnelles et à afficher automatiquement les rendez-vous pris via le SaaS. La professionnelle ne doit pas avoir à gérer manuellement deux agendas.

Les événements personnels/externes restent sous l'autorité de leur provider. Un rendez-vous Booking SaaS exporté est une représentation secondaire du rendez-vous métier, pas une deuxième source de vérité.

### Première intégration : Google Calendar

La V1 de cette intégration est prévue après l'agenda professionnel ; elle n'est pas encore implémentée.

**Google → Booking SaaS :**

- la professionnelle connecte son compte Google et choisit explicitement les calendriers à prendre en compte ;
- les événements occupés de ces calendriers rendent les périodes correspondantes indisponibles dans le moteur de réservation ;
- les créations, modifications et suppressions d'événements doivent finir par être reflétées dans les disponibilités locales ;
- les calendriers d'anniversaires et de jours fériés ne bloquent pas les disponibilités sauf sélection explicite.

**Booking SaaS → Google :**

- la professionnelle choisit un calendrier de destination pour les rendez-vous clientes ;
- une réservation crée automatiquement l'événement correspondant ;
- un déplacement ou une annulation depuis Booking SaaS met à jour ou supprime/annule la représentation Google correspondante ;
- la synchronisation est asynchrone : un retard ou un échec est visible et peut être repris sans dupliquer les événements.

### Limites et conflits

Déplacer manuellement dans Google un rendez-vous exporté ne modifie pas automatiquement le rendez-vous métier en V1. Les modifications métier restent effectuées depuis Booking SaaS pour préserver la validation des disponibilités, la gestion des conflits, les emails cliente, la fidélité et l'historique. Une divergence doit être signalée et réconciliée depuis la source Booking, sans modification silencieuse du rendez-vous cliente.

Un événement externe découvert après une réservation peut révéler un conflit : il ne doit pas annuler ni déplacer automatiquement le rendez-vous cliente. Le conflit doit être signalé à la professionnelle ; la politique de traitement des données périmées et des conflits sera précisée avant implémentation. La synchronisation ne garantit pas une visibilité instantanée des changements effectués chez Google.

### Évolution multi-provider

Le concept de `calendar_provider` reste générique : Google Calendar en premier, Microsoft Outlook / Microsoft 365 ensuite, et Apple Calendar uniquement si une intégration fiable est retenue. Les règles métier ne doivent pas dépendre exclusivement de Google.

## 11. Clientes et mini-CRM

La liste clientes affiche prénom, nom, email, téléphone, nombre de rendez-vous, dernière visite, prochaine visite, points et récompenses disponibles.

La fiche cliente contient :

- coordonnées et notes internes facultatives ;
- historique complet des rendez-vous ;
- dépenses cumulées si le calcul reste simple ;
- dernière visite et nombre de visites terminées ;
- solde et historique de fidélité ;
- récompenses et utilisations.

## 12. Fidélité et récompenses

### Règles

La V1 utilise principalement la règle « X rendez-vous terminés = récompense ». Par défaut, un rendez-vous terminé rapporte un point. Le modèle doit pouvoir accueillir plus tard « 1 € dépensé = X points » sans imposer cette interface en V1.

Les points sont crédités uniquement lors du passage explicite à `completed`. Une annulation ou un no-show ne rapporte rien. Répéter l'action « Terminé » ne doit jamais recréditer les points.

### Ledger

Le journal `loyalty_events` est la source de vérité explicable. Chaque événement contient au minimum : `id`, `business_id`, `client_id`, `appointment_id` facultatif, type, `points_delta`, motif et date. Le solde est calculé depuis le ledger ou mis en cache avec un mécanisme cohérent.

### Récompenses

Une récompense contient : business, nom, description, points requis, type, valeur et statut actif. `reward_redemptions` historise chaque utilisation. Le coût en points est représenté dans le ledger.

### Vue cliente

Un lien sécurisé permet de consulter la progression, le prochain palier, les récompenses disponibles, le prochain rendez-vous et un bouton de reprise de rendez-vous, sans exposer aucune autre cliente.

## 13. Emails

Resend est utilisé pour des templates propres :

- confirmation immédiate de réservation ;
- rappel environ 24 heures avant ;
- modification ;
- annulation ;
- points gagnés ;
- récompense débloquée ;
- réactivation.

Chaque email contient le lien public du business. Un journal `email_events` et une clé de déduplication empêchent tout envoi automatique multiple.

## 14. Réactivation

Une cliente est à relancer lorsque sa dernière prestation terminée dépasse le seuil choisi et qu'elle n'a aucun prochain rendez-vous. Le dashboard affiche le nombre de clientes concernées et une liste dédiée.

En V1, les relances automatiques sont désactivées par défaut et doivent être explicitement activées par la professionnelle.

## 15. Dashboard

Pour le mois courant :

- nombre de rendez-vous ;
- clientes uniques ;
- nouvelles clientes ;
- clientes revenues ;
- taux de retour ;
- chiffre d'affaires estimé depuis les rendez-vous terminés ;
- clientes à relancer ;
- récompenses débloquées.

Le taux de retour est défini comme : clientes ayant au moins une visite terminée avant le début de la période et au moins une visite terminée pendant la période, divisées par les clientes uniques ayant une visite terminée pendant la période. Le dénominateur nul produit `0 %`.

## 16. Disponibilités et exceptions

- configuration par jour, avec jour fermé ;
- plusieurs plages par jour, par exemple 10 h–13 h et 14 h–19 h ;
- exceptions : fermeture exceptionnelle, vacances, créneau bloqué, rendez-vous personnel et éventuelle ouverture exceptionnelle.

Les dates sont persistées en UTC ; l'affichage et le calcul des horaires utilisent le fuseau IANA du business.

Lors de la future intégration calendrier, les périodes occupées importées des sources sélectionnées seront également prises en compte, à partir de données synchronisées localement et non d'un appel au provider à chaque consultation publique.

## 17. Modèle de données attendu

Le modèle couvre au minimum :

- `profiles` ;
- `businesses` et `business_members` ;
- `business_settings` ;
- `services` ;
- `business_hours` ;
- `availability_exceptions` ;
- `clients` ;
- `appointments` ;
- `loyalty_programs` et `loyalty_events` ;
- `rewards` et `reward_redemptions` ;
- `email_events`.

Il comprend relations, index, contraintes, `business_id` partout où nécessaire et des clés étrangères composites empêchant les associations inter-tenant.

## 18. UX de l'espace professionnel

Navigation courte : Dashboard, Agenda, Clientes, Prestations, Fidélité, Paramètres. L'usage téléphone est prioritaire, sans sacrifier le desktop.

Chaque absence de données est expliquée et accompagnée d'une action utile, par exemple « Aucun rendez-vous aujourd'hui » avec « Ajouter un rendez-vous » ou « Partager mon lien de réservation ».

## 19. Données de démonstration

Un seed crée « Studio Mila Lashes », ses quatre prestations (cil à cil, volume mixte, remplissage, dépose), plusieurs clientes, des rendez-vous futurs/terminés/annulés et quelques événements de fidélité.

## 20. Qualité de code

- TypeScript strict ;
- composants réutilisables ;
- séparation frontend, accès aux données et logique métier ;
- fichiers et fonctions à responsabilité claire ;
- erreurs et états de chargement traités ;
- UI optimiste seulement si elle ne compromet pas la cohérence ;
- migrations versionnées ;
- README et `.env.example` complets ;
- scripts de développement utiles ;
- architecture proportionnée à la V1.

## 21. Tests prioritaires

1. création d'une réservation ;
2. refus d'un chevauchement/double booking ;
3. isolation multi-tenant ;
4. transition vers `completed` ;
5. attribution des points exactement une fois ;
6. déblocage d'une récompense ;
7. annulation ;
8. calcul des créneaux disponibles ;
9. identification d'une cliente inactive ;
10. idempotence des emails automatiques.

## 22. Priorités de livraison

1. moteur de réservation sécurisé — **TERMINÉ**, intégré sur `main` au commit `3a424e5807f7277a98cfe1ca939c8dd13821a30e` ;
2. authentification et onboarding professionnelle ;
3. agenda professionnel ;
4. intégration Google Calendar ;
5. CRM clientes ;
6. fidélité ;
7. emails automatiques ;
8. réactivation ;
9. statistiques.

Cet ordre indique la direction actuelle, sans imposer un découpage architectural absolu. Le moteur terminé ne signifie pas que les écrans, l'envoi des emails ou la V1 de bout en bout sont déjà livrés.

Une réservation réellement fonctionnelle vaut mieux que dix écrans fictifs.

## 23. Critère d'acceptation de la V1

Une professionnelle configure son activité, ses prestations et ses horaires, puis partage son lien. Une cliente choisit une prestation et un créneau disponible, saisit son email, réserve et reçoit sa confirmation. La professionnelle voit le rendez-vous, la cliente reçoit son rappel J-1, puis gagne exactement un point lorsque le rendez-vous est marqué terminé. Elle reçoit sa progression, débloque une récompense au seuil prévu et, sans retour après le délai configuré, apparaît parmi les clientes à relancer.

La V1 est réussie lorsque ce scénario fonctionne de bout en bout avec l'isolation multi-tenant et les garanties d'idempotence attendues.
