-- The practitioner role (docs/TEAM_CONTRACT.md, « Rôle praticienne »). Alone
-- in its migration: a new enum value cannot be used in the transaction that
-- adds it; its rights come with 20261116110000_team_capabilities.sql.

alter type public.business_member_role add value if not exists 'practitioner';
