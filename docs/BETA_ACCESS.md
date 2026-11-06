# Bêta privée par invitation

Pendant la bêta, seule une adresse invitée peut créer son espace. Le parcours existant ne change pas : inscription (`signUpAction`, Supabase Auth), confirmation de l'email, onboarding (`completeOnboardingAction`), `/app`. On y ajoute seulement :

- un contrôle d'invitation à l'inscription ;
- une barrière en base sur la création d'un établissement.

Migration : `supabase/migrations/20261107090000_beta_invitations.sql`.

## Parcours

1. **L'opérateur autorise une adresse** avec `scripts/beta-invite.mjs`. La commande crée une invitation et **affiche** son lien. **Rien n'est envoyé** : c'est l'opérateur qui transmet le lien.
2. **La professionnelle ouvre son lien** `/signup?invitation=inv_…` et choisit elle-même son mot de passe, dans le formulaire d'inscription existant.
3. **Le serveur vérifie l'invitation avant de créer le compte** : elle doit être valide, liée à cette adresse, non expirée et non utilisée. Sinon, aucun compte n'est créé.
4. **Une fois le compte créé, l'invitation est acceptée pour le compte de l'adresse invitée.** C'est la base qui trouve ce compte : l'identifiant n'est jamais pris de l'appelant. Le compte reçoit alors l'accès bêta.
5. **Elle confirme son email** (lien de Supabase Auth), puis suit l'onboarding existant, puis arrive sur `/app`.

## Garanties

- **Pas d'établissement sans accès.** Un déclencheur sur `public.businesses` refuse toute création au nom d'un utilisateur sans accès bêta (`beta_invitation_required`). C'est vrai quel que soit le chemin : l'action, un appel direct à `complete_onboarding` avec sa session, ou un futur chemin. Un compte créé directement auprès de Supabase Auth, sans passer par le produit, ne peut donc rien créer. Le service et le propriétaire de la base ne sont pas concernés.
- **Le jeton** : 32 octets aléatoires, préfixe `inv_`, en base64url. **Seul son SHA-256 est stocké** : le lien ne peut pas être reconstitué depuis la base. Il n'est jamais journalisé.
- **Une adresse par invitation, une durée de 1 à 30 jours** (7 par défaut). Une nouvelle invitation pour la même adresse révoque la précédente, si celle-ci n'a pas encore été acceptée.
- **Usage unique.** L'acceptation se fait sous verrou de la ligne de l'invitation. Des tentatives simultanées l'acceptent une seule fois, pour un seul compte (testé). Une fois l'établissement créé, le lien répond `invitation_used`.
- **Reprise après interruption.** Relancer l'inscription avec le même lien, pour la même adresse, avant la création de l'établissement, redonne l'accès :
  - si le compte n'est pas encore confirmé, Auth renvoie l'email de confirmation, ou demande de patienter (`rate_limited`) ;
  - si le compte est déjà confirmé, la réponse est `email_taken`, et elle se connecte.

  Dans tous ces cas, l'accès est donné.

- **Aucun mot de passe** dans nos tables, aucun mot de passe choisi par l'opérateur : Supabase Auth seul les gère.
- **Comptes existants.** Tous les comptes présents au moment de la migration reçoivent l'accès (`source = 'existing'`). Leurs établissements ne sont pas touchés (test de montée de version).
- **Tables `private.beta_invitations` et `private.beta_access`** : aucun droit pour `anon` ni `authenticated`. Les fonctions qui créent, vérifient, acceptent ou révoquent une invitation sont réservées à `service_role`. Une professionnelle connectée ne peut ni s'inviter ni se donner l'accès (testé).

## Erreurs (`ActionResult`)

| Code                        | HTTP | Quand                                                                             |
| --------------------------- | ---- | --------------------------------------------------------------------------------- |
| `beta_invitation_required`  | 403  | inscription sans lien d'invitation, ou onboarding d'un compte sans accès bêta     |
| `invitation_invalid`        | 400  | jeton mal formé, inconnu ou révoqué                                               |
| `invitation_expired`        | 410  | invitation non acceptée à temps                                                   |
| `invitation_used`           | 409  | invitation déjà utilisée (son établissement existe, ou un autre compte l'a prise) |
| `invitation_email_mismatch` | 403  | invitation liée à une autre adresse, qui n'est pas révélée                        |

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

- **`/signup`** lit `?invitation=` et le passe à `SignupForm` (`invitationToken`), qui l'envoie à `signUpAction`. Rien d'autre ne change visuellement : les refus s'affichent dans l'encart d'erreur existant, avec les textes de `error-copy.ts`.
- **`getOnboardingStatusAction`** renvoie maintenant `betaAccess: boolean` pour `onboarding_required`. À `false`, l'onboarding sera refusé : la page peut l'annoncer avant que la professionnelle remplisse le formulaire. Aujourd'hui, l'erreur `beta_invitation_required` s'affiche seulement à la validation.
- **À considérer, sans urgence :**
  - un `/signup` sans invitation pourrait dire d'emblée « bêta sur invitation » ;
  - avec `invitation_used` ou `email_taken`, le lien « Me connecter » suffit ;
  - un lien d'invitation ouvert alors qu'une autre session est active redirige comme aujourd'hui (garde existante).
