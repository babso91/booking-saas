-- Widen the existing personal colour-mode domain. Existing choices and defaults still apply.
alter domain public.member_preference_color_mode
  drop constraint member_preference_color_mode;
alter domain public.member_preference_color_mode
  add constraint member_preference_color_mode
  check (value in ('light', 'dark', 'system', 'glass'));
