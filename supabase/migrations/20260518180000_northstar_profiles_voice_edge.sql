-- Per-employee Twilio Voice edge preset (auto, us, apac, singapore, …).
-- null / auto = SDK roaming (closest edge to the rep — correct for overseas staff).

alter table public.northstar_profiles
  add column if not exists voice_edge text;

comment on column public.northstar_profiles.voice_edge is
  'Twilio Voice edge preset: auto, us, apac, eu, singapore, ashburn, etc. Null = auto (roaming).';
