-- Read-only list of the Auth accounts of a hosted project, to decide which
-- test accounts (if any) should not inherit beta access when 20261107 runs
-- (every account present then gets source = 'existing').
--
-- PERSONAL DATA (emails): audit.mjs writes it to a local, git-ignored file
-- only and never prints it. Do not paste it in a chat, a ticket or a PR.
-- Nothing is deleted by this file or by any script of this folder.

select
  u.email,
  u.created_at::date as created,
  u.email_confirmed_at is not null as confirmed,
  u.last_sign_in_at::date as last_sign_in,
  (select count(*) from public.business_members m where m.user_id = u.id)
    as businesses
from auth.users u
order by u.created_at;
