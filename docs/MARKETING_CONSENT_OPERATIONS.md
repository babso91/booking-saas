# Consentement marketing : procédure de l'administrateur de la plateforme

L'administrateur de la plateforme (l'« opérateur ») enregistre puis active
les textes présentés aux clientes. **Activer un texte n'est pas une
certification juridique.** La conformité du dispositif complet (textes,
notice, parcours) doit être vérifiée avant toute utilisation réelle.

## Ce que le système garantit

- **Textes archivés en entier** (`private.consent_texts`) : corps intégral,
  empreinte SHA-256, version, dates d'activation et de retrait. Un texte ne
  change jamais : une nouvelle version le remplace.
- **Une seule version active par type :**
  - `email` et `sms` : les deux cases, indépendantes et jamais précochées ;
  - `information` : le paragraphe sous les cases ;
  - `notice` : la notice de confidentialité.
- **Double opt-in** : une case cochée en réservant n'est enregistrée qu'au
  clic sur le lien de confirmation envoyé à l'adresse de la fiche.
- **Chaque accord garde sa preuve** : l'établissement, le canal, la date
  serveur, l'origine (`booking`), le rendez-vous, et les versions exactes de
  la case, de l'information et de la notice affichées.
- **L'accord vient de la cliente elle-même** (sa réservation). Une
  professionnelle peut enregistrer un retrait, jamais un accord
  (`consent_direct_only`).
- **Verrou de production** : l'interrupteur `marketing_consent_collection`
  est **éteint**. Tant qu'il l'est, aucun accord n'est enregistré, même avec
  des textes actifs, et les pages n'affichent aucune case. Les retraits et
  désinscriptions restent toujours possibles.

## Textes V1 déjà enregistrés (brouillons, non actifs)

| Version          | Type          | Texte                                                                                                                                                                                        |
| ---------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email-v1`       | `email`       | J'accepte de recevoir par e-mail les offres, promotions et nouveautés commerciales de cet établissement.                                                                                     |
| `sms-v1`         | `sms`         | J'accepte de recevoir par SMS les offres, promotions et nouveautés commerciales de cet établissement.                                                                                        |
| `information-v1` | `information` | Ces choix sont facultatifs et n'affectent pas votre réservation. Vous pouvez retirer votre accord à tout moment, gratuitement. Les messages concernant vos rendez-vous restent indépendants. |

**La notice n'est pas enregistrée** : elle demande des informations légales
réelles, à compléter (voir `docs/consent/notice-template.md`). Sans notice
active, aucun accord ne peut être enregistré.

## Procédure

Sur une machine de confiance, avec la clé service dans l'environnement. Elle
n'est jamais affichée.

```sh
export SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=…

# 1. Voir l'état
node scripts/consent-admin.mjs list

# 2. Enregistrer la notice complétée (un fichier texte), en brouillon.
#    Le texte intégral et son SHA-256 s'affichent : c'est ce que vous relisez.
node scripts/consent-admin.mjs register notice-v1 notice docs/consent/notice-v1.txt

# 3. Relire chaque texte en entier, avec son empreinte : `show` affiche le
#    texte archivé. Activer avec l'empreinte affichée par `show`. Un autre
#    contenu pour une version existante est refusé (consent_text_conflict).
node scripts/consent-admin.mjs show email-v1

# 4. Activer chaque version, avec l'empreinte relue. Sans --confirm, rien
#    ne change. Une empreinte différente : refus (consent_text_changed).
node scripts/consent-admin.mjs activate email-v1 --sha256 <empreinte> --note "relu le …" --confirm
node scripts/consent-admin.mjs activate sms-v1 --sha256 <empreinte> --note "…" --confirm
node scripts/consent-admin.mjs activate information-v1 --sha256 <empreinte> --note "…" --confirm
node scripts/consent-admin.mjs activate notice-v1 --sha256 <empreinte> --note "…" --confirm

# 5. Ouvrir la collecte : seulement sur autorisation explicite du
#    responsable de la plateforme, après vérification de la conformité.
node scripts/consent-admin.mjs collection on --note "autorisé par … le …" --confirm

# Fermer à tout moment (les accords déjà donnés restent, les retraits aussi)
node scripts/consent-admin.mjs collection off --confirm
```

Activer une nouvelle version d'un type retire la précédente. Les accords déjà
donnés gardent la version qu'ils citent : leur preuve ne change jamais.
