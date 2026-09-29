# Contrat backend — authentification et onboarding

Contrat entre le backend (Server Actions) et l'interface. Toutes les actions sont des Server Functions : elles s'importent dans un Client Component et s'appellent comme une fonction asynchrone (`startTransition`, `useActionState` ou `<form action>`).

Aucune action ne lève d'exception vers l'UI. Toutes renvoient :

```ts
type ActionResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: AppErrorCode;
        message: string;
        fieldErrors?: Record<string, string[]>;
      };
    };
```

- `message` est un message français par défaut, directement affichable.
- `fieldErrors` associe un nom de champ du formulaire à ses messages.
- L'UI ne voit jamais d'erreur PostgreSQL ni Supabase.

## Actions

### `src/features/auth/actions/auth.ts`

| Action                        | Entrée                                       | Succès (`data`)                                                                                            |
| ----------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `signUpAction(input)`         | `{ email, password, firstName?, lastName? }` | `{ status: "signed_in", next: "/onboarding" }` ou `{ status: "confirmation_required", email, next: null }` |
| `signInAction(input)`         | `{ email, password }`                        | `{ next: "/onboarding" \| "/app" }`                                                                        |
| `signOutAction()`             | —                                            | `{ next: "/login" }`                                                                                       |
| `getOnboardingStatusAction()` | —                                            | `OnboardingStatus` (ci-dessous)                                                                            |

```ts
type OnboardingStatus =
  | { status: "unauthenticated"; next: "/login" }
  | {
      status: "onboarding_required";
      next: "/onboarding";
      user: { email: string | null; emailConfirmed: boolean };
    }
  | {
      status: "ready";
      next: "/app";
      user: { email: string | null; emailConfirmed: boolean };
      business: { slug: string; name: string; timezone: string };
    };
```

Règles de saisie :

- mot de passe de 10 à 72 caractères à l'inscription (`auth.minimum_password_length`) ;
- à la connexion, aucune règle de longueur n'est appliquée, pour ne rien révéler de la politique ;
- l'email est normalisé en minuscules.

### `src/features/onboarding/actions/onboarding.ts`

| Action                            | Entrée                         | Succès (`data`)                                                                  |
| --------------------------------- | ------------------------------ | -------------------------------------------------------------------------------- |
| `checkSlugAction(input)`          | `{ slug }` (texte libre saisi) | `{ slug, available, reason: "available" \| "taken" \| "reserved" \| "invalid" }` |
| `completeOnboardingAction(input)` | voir ci-dessous                | `{ businessId, slug, businessName, timezone, next: "/app" }`                     |

Entrée de `completeOnboardingAction` :

| Champ                         | Type    | Obligatoire | Règle / défaut                      |
| ----------------------------- | ------- | ----------- | ----------------------------------- |
| `firstName`                   | string  | oui         | 1–80                                |
| `lastName`                    | string  | oui         | 1–80                                |
| `businessName`                | string  | oui         | 1–120                               |
| `slug`                        | string  | oui         | texte libre, normalisé côté serveur |
| `timezone`                    | string  | non         | fuseau IANA, défaut `Europe/Paris`  |
| `description`                 | string  | non         | ≤ 1000                              |
| `contactEmail`                | string  | non         | email ; défaut : email du compte    |
| `phone`                       | string  | non         | `+?[0-9 ().-]{6,30}`                |
| `location`                    | string  | non         | ≤ 200                               |
| `cancellationPolicy`          | string  | non         | ≤ 2000                              |
| `minimumBookingNoticeMinutes` | integer | non         | 0–10080, défaut 120                 |
| `maximumBookingAdvanceDays`   | integer | non         | 1–365, défaut 90                    |
| `bufferMinutes`               | integer | non         | 0–240, défaut 0                     |

Une chaîne vide est traitée comme absente. Aucun identifiant d'utilisateur ou de propriétaire n'est accepté : un tel champ est ignoré. Le propriétaire est toujours la session serveur (`auth.uid()`).

## Slug public

Le serveur est la seule implémentation de la normalisation. L'UI affiche le `slug` renvoyé par `checkSlugAction`.

- Normalisation : suppression des accents, passage en minuscules ; toute suite de caractères hors `[a-z0-9]` devient un seul tiret ; tirets retirés aux extrémités ; 63 caractères au maximum. Exemples : `"  Écrin de Camille "` → `ecrin-de-camille`, `Straße_Ærø` → `strasse-aero`.
- Longueur : 3 à 63 caractères après normalisation.
- Réservés : `account`, `admin`, `api`, `app`, `auth`, `b`, `dashboard`, `help`, `login`, `logout`, `onboarding`, `register`, `settings`, `signin`, `signup`, `support`, `www`.
- `checkSlugAction` est une aide UX. Seule la contrainte d'unicité en base fait foi : un slug annoncé disponible peut être pris entre-temps, et `completeOnboardingAction` renvoie alors `slug_taken`.

## Codes d'erreur

| Code                  | HTTP | Quand                                                                             |
| --------------------- | ---- | --------------------------------------------------------------------------------- |
| `validation_error`    | 400  | entrée invalide (équivalent de `invalid_input`) ; voir `fieldErrors`              |
| `unauthenticated`     | 401  | pas de session valide (équivalent de `unauthorized`)                              |
| `invalid_credentials` | 401  | email ou mot de passe incorrect (message identique si le compte n'existe pas)     |
| `email_not_confirmed` | 403  | connexion avant confirmation de l'email                                           |
| `email_taken`         | 409  | inscription avec un email déjà confirmé (ou déjà utilisé sans confirmation email) |
| `rate_limited`        | 429  | limite Supabase Auth atteinte                                                     |
| `already_onboarded`   | 409  | l'onboarding a déjà été réalisé : aller sur `/app`                                |
| `slug_taken`          | 409  | slug déjà utilisé (`fieldErrors.slug`)                                            |
| `slug_reserved`       | 409  | slug réservé (`fieldErrors.slug`)                                                 |
| `forbidden`           | 403  | action non autorisée                                                              |
| `internal`            | 500  | erreur inattendue ; détail uniquement dans les logs serveur                       |

## Confirmation email

Le backend ne suppose pas le réglage Supabase `enable_confirmations` :

- **désactivée** : `signUpAction` renvoie `status: "signed_in"`. La session est active, l'UI va sur `/onboarding` ;
- **activée** : `signUpAction` renvoie `status: "confirmation_required"`. L'UI affiche « vérifiez votre boîte de réception ». Le lien de l'email mène à `/auth/callback`, qui ouvre la session puis redirige vers `/app`, lequel renvoie vers `/onboarding` tant qu'aucun business n'existe. Une connexion avant confirmation renvoie `email_not_confirmed`.

La confirmation est **activée en local** (`supabase/config.toml`, comme sur un projet hébergé). Les emails arrivent dans Mailpit : http://127.0.0.1:54324.

Inscription avec un email existant (comportement réel de Supabase Auth, testé) :

- compte **non confirmé** : `confirmation_required`, et l'email de confirmation est renvoyé ;
- compte **confirmé** : `email_taken`. Supabase ne masque pas ce cas ; l'UI doit afficher un message neutre (« Si un compte existe, connectez-vous ») si l'énumération est un souci.

### Hôte canonique et URL de callback

- `NEXT_PUBLIC_APP_URL` est l'unique origine de l'application. En local : `http://localhost:3000`, jamais `127.0.0.1:3000`.
- `signUpAction` envoie `emailRedirectTo = <NEXT_PUBLIC_APP_URL>/auth/callback`.
- Supabase Auth doit avoir `site_url = <origine>` et `<origine>/auth/callback` dans les URL de redirection autorisées. Une URL non autorisée est remplacée par `site_url`, et l'échange PKCE échoue.
- Le cookie `code-verifier` PKCE est posé sur l'hôte de l'app à l'inscription. Il doit être relu sur le **même hôte** par `/auth/callback`. Ouvrir l'app sur un autre hôte fait donc échouer la confirmation (`/login?error=auth_callback_failed`).
- En production : Site URL = origine publique, Redirect URLs = `<origine>/auth/callback` (tableau de bord Supabase → Authentication → URL Configuration), et `NEXT_PUBLIC_APP_URL` identique.

`/auth/callback` n'accepte comme destination `next` que `/app`, `/onboarding` et `/login`. Toute autre valeur donne `/app`. Un code invalide, déjà utilisé, ou échangé sans le cookie `code-verifier` donne `/login?error=auth_callback_failed`.

## Déconnexion

`signOutAction` révoque la session côté serveur Auth (scope `local`) et efface les cookies. Effets réels, testés :

- `getUser` refuse l'ancien jeton d'accès. Toutes les gardes, le proxy et les actions passent par là, donc `/app` et les actions sont fermés immédiatement ;
- le refresh token est révoqué (`refresh_token_not_found`) ;
- **limite** : un jeton d'accès copié avant la déconnexion reste accepté par PostgREST (lectures et RPC, sous RLS) jusqu'à son expiration (`jwt_expiry`, 3600 s par défaut). PostgREST ne vérifie que la signature et la date d'expiration du JWT. Pas de liste noire maison : pour réduire la fenêtre, réduire `jwt_expiry` en production.

## Routage

| État serveur            | `/app/**`       | `/onboarding` | `/login`        | `/b/[slug]`, `/api/public/**` |
| ----------------------- | --------------- | ------------- | --------------- | ----------------------------- |
| non connecté            | → `/login`      | → `/login`    | affiché         | public                        |
| connecté, sans business | → `/onboarding` | affiché       | → `/onboarding` | public                        |
| connecté, business prêt | affiché         | → `/app`      | → `/app`        | public                        |

L'état est calculé côté serveur à chaque requête : session validée par le serveur Auth, puis appartenance lue sous RLS. Il ne dépend jamais d'un état navigateur. Chaque état n'est accepté que par une seule route, ce qui exclut toute boucle.

Les pages `/signup` et `/login` appartiennent à la branche UI. Une page d'inscription devra appeler `redirectAuthenticatedUser()` (`src/features/auth/data/guards.ts`) dans son layout, comme `/login`.
