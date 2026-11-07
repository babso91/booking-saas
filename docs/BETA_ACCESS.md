# Bêta privée par invitation

Pendant la bêta, seule une adresse invitée peut créer son espace. Le parcours existant ne change pas : inscription (`signUpAction`, Supabase Auth), confirmation de l'email, onboarding (`completeOnboardingAction`), `/app`. On y ajoute seulement :

- un contrôle d'invitation à l'inscription ;
- une barrière en base sur la création d'un établissement.

Migration : `supabase/migrations/20261107090000_beta_invitations.sql`.

## Parcours

1. **L'opérateur autorise une adresse** avec `scripts/beta-invite.mjs`. La commande crée une invitation et **affiche** son lien. **Rien n'est envoyé** : c'est l'opérateur qui transmet le lien.
2. **La professionnelle ouvre son lien** `/signup?invitation=inv_…` et choisit elle-même son mot de passe, dans le formulaire d'inscription existant.
3. **Le serveur vérifie l'invitation avant de créer le compte** : elle doit être valide, liée à cette adresse, non expirée et non utilisée. Sinon, aucun compte n'est créé.
4. **Le serveur crée son compte**, avec son mot de passe, d'un seul geste : la création échoue si un compte existe déjà, ce qui supprime toute fenêtre de course. L'invitation est ensuite acceptée pour ce compte, et la base vérifie qu'il s'agit bien du compte de l'adresse invitée.
5. **Un lien de confirmation lui est envoyé** (Supabase Auth, flux PKCE de son appareil). Son accès compte une fois l'adresse confirmée ; elle suit ensuite l'onboarding existant, puis arrive sur `/app`.

**Si un compte existait déjà pour son adresse, non confirmé** (créé par elle lors d'un essai interrompu, ou par n'importe qui) : le serveur **ne modifie rien** de ce compte. Il envoie à son adresse un **lien de récupération** Supabase Auth (flux PKCE de son appareil, email « Choisis ton mot de passe »), garde l'invitation sur l'appareil (cookie httpOnly, 2 h) et répond comme d'habitude `confirmation_required`. En suivant le lien, elle arrive sur **`/invitation`**, où elle choisit son mot de passe (`completeInvitationAction`). L'invitation n'est acceptée qu'à ce moment-là.

**Si le compte est déjà confirmé** : l'inscription répond `email_taken`. Elle se connecte avec son mot de passe **et** son lien (`/login?invitation=`).

## Garanties

- **Pas d'établissement sans accès.** Un déclencheur sur `public.businesses` refuse tout établissement créé par l'API (session d'un utilisateur ou rôle service) pour un utilisateur sans accès bêta (`beta_invitation_required`). L'utilisateur est celui de la session, ou, quand le service agit sans session (`auth.uid()` NULL), celui qu'il désigne comme créateur. Sans personne, la création est refusée. C'est vrai quel que soit le chemin : l'action, un appel direct à `complete_onboarding`, une insertion par le service. Seul le SQL du propriétaire de la base (migrations, administration explicite) n'est pas concerné.
- **L'accès ne compte qu'une fois l'adresse confirmée** : c'est la preuve que la personne détient la boîte mail invitée.
- **L'accès est lié à la session de la preuve** (contre-audit Codex). Le jeton d'accès d'une session fermée ou révoquée reste cryptographiquement valide jusqu'à son expiration (1 h) : PostgREST l'accepte (vérifié). Pour un accès donné par invitation, `private.has_beta_access` exige donc, quand la requête porte un JWT, que sa session (`session_id`) :
  - existe encore chez Auth (`auth.sessions`) et appartienne au compte ;
  - **et** soit la session de la preuve (`beta_access.proof_session_id`), ou une session ouverte après l'octroi (`granted_at`).

  Une session antérieure, même rafraîchie, même si sa révocation a échoué ou n'a pas eu lieu, ne crée rien : ni par l'action, ni par un appel direct à `complete_onboarding`, ni via `my_beta_access` (testé). Cette règle ne s'applique pas au service agissant sans JWT, ni aux comptes `existing`.

- **La même règle pour toutes les permissions professionnelles** (réaudit Codex). Après l'onboarding, l'établissement est atteint par les primitives communes, et chacune exige maintenant que la session de la requête soit de confiance (`private.request_session_trusted`) :
  - `is_business_member` et `has_business_role`, par lesquelles passent toutes les politiques RLS ;
  - `assert_agenda_access` et `member_preferences_membership`, qui lisent l'appartenance directement ;
  - `assert_catalog_access` et `crm_assert_member`, qui passent par `is_business_member`.

  Une session antérieure à la preuve, révoquée ou gardée, ne lit ni ne modifie donc plus rien de l'établissement, par l'action comme par PostgREST ou SQL : établissement, membres, catalogue, `create_service_category`, préférences, agenda, CRM, et même une `UPDATE` qui ne lit aucune colonne (testé, 6 mutations détectées). Les sessions légitimes fonctionnent, comme les comptes `existing` et le service.
  - **Coût** : le résultat est gardé pour la transaction, c'est-à-dire la requête. Il est mémorisé par utilisateur et par session dans un réglage local à la transaction. Lire 5 000 lignes sous RLS prend 95 ms (66 ms sans la règle).
  - Poser ce réglage à la main exige du SQL brut, qui permettrait déjà de réécrire `request.jwt.claims` : cela n'ouvre aucun nouveau chemin.

- **Un compte créé d'abord par un tiers** (audit Codex). N'importe qui peut créer auprès d'Auth un compte non confirmé pour n'importe quelle adresse, et Auth garde le premier mot de passe lors d'une nouvelle inscription (vérifié).
  - **Le lien d'invitation n'est jamais une preuve suffisante pour modifier un compte préexistant** (contre-audit Codex). Le serveur ne change jamais le mot de passe d'un compte, quel que soit son état : aucun appel à l'API d'administration (testé). Sinon, l'adresse pourrait être confirmée entre deux appels du serveur (par l'email d'Auth envoyé au tiers), et le mot de passe d'un compte confirmé serait remplacé (reproduit sur l'ancien code).
  - **Compte non confirmé** : la preuve, c'est le **lien de récupération reçu dans sa boîte mail**. `completeInvitationAction` exige :
    - la session ouverte par ce lien (`amr` = `recovery`, moins d'une heure) ;
    - une adresse confirmée (la récupération la confirme) ;
    - l'invitation gardée sur l'appareil, valide pour ce compte.

    Ensuite, dans cet ordre : son mot de passe remplace celui du tiers, **toutes les autres sessions sont fermées** (en cas d'échec : `session_revocation_failed`, rien n'est donné), puis l'invitation est acceptée pour cette session. Le mot de passe du tiers est refusé, même si l'adresse a été confirmée pendant l'inscription (testé).

  - **Compte déjà confirmé** : l'inscription ne lui donne rien (`email_taken`). Elle se connecte avec son mot de passe **et** son lien (`/login?invitation=`). Les autres sessions du compte sont d'abord fermées (en cas d'échec : `session_revocation_failed`, rien n'est donné), puis l'invitation est acceptée pour cette session (testé). Un tiers qui connaît le mot de passe n'a pas le lien ; elle a le lien et son propre mot de passe.
  - **Limite connue** (inchangée) : un compte confirmé dont elle ne connaît pas le mot de passe, parce qu'un tiers l'a créé et qu'elle a cliqué sur l'email d'Auth, reste sans accès. Le produit n'a pas encore de réinitialisation de mot de passe : l'opérateur supprime ce compte (il n'a ni accès ni établissement), puis elle s'inscrit avec son lien.
- **Le jeton** : 32 octets aléatoires, préfixe `inv_`, en base64url. **Seul son SHA-256 est stocké** : le lien ne peut pas être reconstitué depuis la base. Il n'est jamais journalisé.
- **Une adresse par invitation, une durée de 1 à 30 jours** (7 par défaut). Une nouvelle invitation pour la même adresse révoque la précédente si elle n'a pas encore été acceptée. Les émissions simultanées sont sérialisées par un verrou sur l'adresse, et un index unique garantit une seule invitation en attente par adresse (testé sur un entrelacement déterministe).
- **Usage unique.** L'acceptation se fait sous verrou de la ligne de l'invitation. Des tentatives simultanées l'acceptent une seule fois, pour un seul compte (testé). Une fois l'établissement créé, le lien répond `invitation_used`.
- **Reprise après interruption.** Relancer l'inscription avec le même lien, pour la même adresse, avant la création de l'établissement, redonne l'accès :
  - si le compte n'est pas encore confirmé (créé par Auth, réponse perdue), un lien de récupération part (ou Auth demande de patienter : `rate_limited`). Le compte n'est jamais modifié par l'inscription, et l'accès ne vient qu'après `/invitation` ;
  - si le compte est déjà confirmé, la réponse est `email_taken`, et elle se connecte avec son lien (voir plus haut).

- **Aucun mot de passe** dans nos tables, aucun mot de passe choisi par l'opérateur : Supabase Auth seul les gère.
- **Comptes existants.** Tous les comptes présents au moment de la migration reçoivent l'accès (`source = 'existing'`). Leurs établissements ne sont pas touchés (test de montée de version).
- **Tables `private.beta_invitations` et `private.beta_access`** : aucun droit pour `anon` ni `authenticated`. Les fonctions qui créent, vérifient, acceptent ou révoquent une invitation sont réservées à `service_role`. Une professionnelle connectée ne peut ni s'inviter ni se donner l'accès (testé).

## Erreurs (`ActionResult`)

| Code                        | HTTP | Quand                                                                                 |
| --------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `beta_invitation_required`  | 403  | inscription sans lien d'invitation, ou onboarding d'un compte sans accès bêta         |
| `invitation_invalid`        | 400  | jeton mal formé, inconnu ou révoqué                                                   |
| `invitation_expired`        | 410  | invitation non acceptée à temps                                                       |
| `invitation_used`           | 409  | invitation déjà utilisée (son établissement existe, ou un autre compte l'a prise)     |
| `invitation_email_mismatch` | 403  | invitation liée à une autre adresse, qui n'est pas révélée                            |
| `session_revocation_failed` | 503  | les autres sessions du compte n'ont pas pu être fermées : rien n'est donné, réessayer |

Les messages se trouvent dans `src/lib/errors.ts` et dans `src/features/auth/client/error-copy.ts`.

## Opérateur : créer une invitation

```sh
SUPABASE_URL=https://<projet>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<clé service, jamais commitée> \
APP_URL=https://<domaine de l'application> \
  node scripts/beta-invite.mjs camille@example.com --days 7 --note "première testeuse"
```

- La commande affiche l'identifiant de l'invitation, sa date d'expiration et le **lien**. Le lien est le secret : il n'est affiché qu'une fois, et seul son hash est stocké.
- Pour révoquer une invitation non acceptée : `select public.revoke_beta_invitation('<id>')`, avec le rôle service.
- Il n'existe **aucune route, publique ou privée**, qui crée une invitation : la commande tourne depuis le poste de l'opérateur.

## Pour Claude UI (adaptations minimales faites ici)

- **`/signup`** lit `?invitation=` et le passe à `SignupForm` (`invitationToken`), qui l'envoie à `signUpAction`.
- **`/login`** lit aussi `?invitation=` et le passe à `LoginForm`, puis à `signInAction`. Celle-ci renvoie `invitation: 'accepted'` ou le code du refus. Les liens « Me connecter », « Se connecter » et « Crée ton espace » gardent l'invitation. Rien d'autre ne change visuellement : les refus s'affichent dans l'encart d'erreur existant, avec les textes de `error-copy.ts`.
- **`/invitation`** (nouvelle page, `InvitationPasswordForm`, composants existants `AuthShell` et `PasswordField`) : c'est là qu'arrive le lien de récupération. Elle n'est pas protégée par la garde « déjà connectée », puisque le lien ouvre une session. `/auth/callback` accepte `next=/invitation`. L'URL `…/auth/callback` (avec paramètres) doit figurer dans la liste des redirections autorisées d'Auth, ce qui est déjà le cas.
- **Email de récupération** : `supabase/templates/recovery.html`, avec le sujet « Choisis ton mot de passe ». **Au déploiement**, reporter le même texte dans le projet hébergé (Authentication > Email Templates > Reset Password).
- **`signInAction`** peut maintenant échouer avec `session_revocation_failed`, alors que la connexion a réussi : elle reste connectée, et se reconnecter avec son lien suffit à réessayer.
- **`getOnboardingStatusAction`** renvoie maintenant `betaAccess: boolean` pour `onboarding_required`. À `false`, l'onboarding sera refusé : la page peut l'annoncer avant que la professionnelle remplisse le formulaire. Aujourd'hui, l'erreur `beta_invitation_required` s'affiche seulement à la validation.
- **À considérer, sans urgence :**
  - un `/signup` sans invitation pourrait dire d'emblée « bêta sur invitation » ;
  - avec `invitation_used` ou `email_taken`, le lien « Me connecter » suffit ;
  - un lien d'invitation ouvert alors qu'une autre session est active redirige comme aujourd'hui (garde existante).

## Annoncé avant toute saisie (UI)

- **`/signup` sans `?invitation=`** : `BetaNotice reason="signup"` (« Bêta privée · Sur invitation, pour l'instant. »), sans formulaire, avec « Se connecter ». Le formulaire n'est rendu qu'avec un jeton ; c'est toujours le serveur qui le vérifie.
- **`/onboarding` d'un compte sans accès** : la page lit `my_beta_access()` (`hasBetaAccess`) et affiche `BetaNotice reason="onboarding"` au lieu des quatre étapes : pourquoi la création serait refusée, et quoi faire (se déconnecter, ouvrir son lien d'invitation), avec « Se déconnecter ».
- Tests : `beta-notice.test.tsx` ; `tests/e2e/ui-routes.test.ts` (`/signup` avec et sans invitation, `/onboarding` sans accès).

## Hypothèses de sécurité et risques résiduels

- **Hypothèses.**
  - Seule la titulaire de la boîte mail peut suivre le lien de récupération : il n'est valable qu'une heure, et le flux PKCE impose l'appareil qui l'a demandé.
  - Les horloges d'Auth (`auth.sessions.created_at`) et de PostgreSQL (`granted_at`) sont alignées.
  - `secure_password_change` est désactivé : la session de récupération suffit pour définir le mot de passe.
- **Décalage d'horloge.** Une session ouverte dans la fenêtre de décalage autour de l'octroi pourrait être classée du mauvais côté. La session de la preuve, elle, est toujours désignée explicitement.
- **Ancien jeton d'un compte invité.** Il ne donne plus accès à l'établissement. Jusqu'à son expiration (≤ 1 h), il lit encore son propre profil (`profiles`, fondé sur `auth.uid()` seul).
- **Chemins des mini-sites (#40, #43), une fois intégrés.** Leurs actions résolvent l'établissement avec `getBusinessContext` : `getUser` côté Auth, puis `business_members` sous RLS (`is_business_member`), avant toute écriture par le service. Une session révoquée y est refusée (`unauthenticated`), une session gardée par Auth aussi (`no_business`). Testé sur la combinaison (`tests/integration/beta-minisite-session.test.ts`).
- **Texte de l'email de récupération.** Il parle d'invitation ; le jour où le produit ajoutera une réinitialisation de mot de passe générale, il faudra le revoir.
