-- Supabase schema for the SMS booking engine.
-- Applied 2026-09-10 to project "Lead SMS Booking Engine" (ref uhfeehdwxbzdxvltjxbx).

create table if not exists public.client_configs (
  client_id            text primary key,
  business_name        text not null,
  twilio_phone_number  text not null,
  calcom_api_key       text not null,
  calcom_username      text,
  event_type_id        bigint not null,
  system_prompt_rules  text default '',
  google_sheet_id      text not null,
  business_hours       jsonb default '{}'::jsonb,
  timezone             text default 'America/New_York',
  notification_email   text,
  status               text default 'active',
  onboarded_via        text,
  typeform_response_id text,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now()
);
-- Tenant lookup in Module 3 filters on twilio_phone_number OR client_id.
create unique index if not exists client_configs_twilio_uniq
  on public.client_configs (twilio_phone_number) where status = 'active';

create table if not exists public.conversation_history (
  id             bigint generated always as identity primary key,
  client_id      text references public.client_configs(client_id) on delete cascade,
  lead_phone     text not null,
  role           text not null check (role in ('user','assistant','system')),
  content        text not null,
  channel_source text,
  turn           int,
  booking_intent text,
  twilio_sid     text,
  execution_id   text,
  created_at     timestamptz default now()
);
create index if not exists conv_thread_idx
  on public.conversation_history (client_id, lead_phone, created_at);

create table if not exists public.error_log (
  id            bigint generated always as identity primary key,
  workflow_id   text,
  workflow_name text,
  execution_id  text,
  failed_node   text,
  error_message text,
  error_stack   text,
  http_status   int,
  payload       text,
  client_id     text,
  lead_phone    text,
  severity      text default 'error',
  created_at    timestamptz default now()
);

-- ============================================================
-- MODULE 6 : cold-lead re-engagement
-- ============================================================

alter table public.client_configs
  add column if not exists followup_enabled        boolean default true,
  add column if not exists followup_cadence_hours  int[]   default '{2,24,72}',
  add column if not exists followup_skip_weekends  boolean default false,
  -- Quiet hours are evaluated in the tenant's own timezone (TCPA: 8am-9pm local).
  add column if not exists quiet_hours_start       int     default 8,
  add column if not exists quiet_hours_end         int     default 21;

alter table public.conversation_history
  add column if not exists is_followup   boolean default false,
  add column if not exists followup_step int;

-- One row per (tenant, lead). This is the follow-up ladder's state machine.
create table if not exists public.lead_threads (
  client_id        text not null references public.client_configs(client_id) on delete cascade,
  lead_phone       text not null,
  client_phone     text,
  lead_name        text,
  lead_email       text,
  channel_source   text,
  status           text not null default 'nurturing'
                   check (status in ('nurturing','booked','dead','opted_out')),
  followup_count   int  not null default 0,
  next_followup_at timestamptz,
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  qualified        boolean default false,
  booking_intent   text,
  booking_uid      text,
  opt_out_keyword  text,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  primary key (client_id, lead_phone)
);

-- Drives the sweep query; partial index keeps it small as threads close out.
create index if not exists lead_threads_due_idx
  on public.lead_threads (next_followup_at)
  where status = 'nurturing';

-- The STOP/START PATCH filters on this pair, so it must be indexed.
create index if not exists lead_threads_optout_idx
  on public.lead_threads (lead_phone, client_phone);

-- ============================================================
-- MIGRATION : first nudge 1h -> 2h
-- Only needed if you already ran the block above when the
-- default was '{1,24,72}'. "add column if not exists" is a
-- no-op on an existing column, so it will NOT move the default
-- and it will NOT touch rows already written.
-- ============================================================

alter table public.client_configs
  alter column followup_cadence_hours set default '{2,24,72}';

-- Existing tenants still on the old ladder.
update public.client_configs
   set followup_cadence_hours = '{2,24,72}'
 where followup_cadence_hours = '{1,24,72}';

-- Threads already scheduled under the old cadence would still fire at the
-- 1h mark. Push the ones that have not fired yet out to 2h.
update public.lead_threads
   set next_followup_at = last_outbound_at + interval '2 hours',
       updated_at       = now()
 where status = 'nurturing'
   and followup_count = 0
   and last_outbound_at is not null
   and next_followup_at > now();

-- ============================================================
-- RLS : deny by default
-- n8n reaches these tables with the service_role key, which
-- bypasses RLS, so enabling it changes nothing for the workflow.
-- It does close the anon key, which is public by design and
-- would otherwise expose every tenant's calcom_api_key.
-- Add policies only if you later query these from a browser.
-- ============================================================

alter table public.client_configs        enable row level security;
alter table public.conversation_history  enable row level security;
alter table public.lead_threads          enable row level security;
alter table public.error_log             enable row level security;

-- ============================================================
-- Public intake authorisation
-- /webhook/web-lead has no transport auth. Without a per-tenant
-- secret, any caller can supply a client_id and an arbitrary
-- phone number and cause an SMS from that tenant's Twilio number
-- to a target of their choosing -- cost, spam and TCPA exposure
-- landing on the client. The gate fails closed.
-- ============================================================

alter table public.client_configs
  add column if not exists webhook_secret text;

comment on column public.client_configs.webhook_secret is
  'Shared secret the web-form intake must present. NULL = web-form intake disabled for this tenant (fail closed).';

update public.client_configs
   set webhook_secret = encode(gen_random_bytes(24), 'hex')
 where webhook_secret is null;

-- ============================================================
-- Twilio webhook signature validation
-- The voice and SMS webhooks have no transport auth and accept
-- a forged From/To. X-Twilio-Signature closes that; it needs the
-- tenant's auth token. Same sensitivity as calcom_api_key.
-- ============================================================

alter table public.client_configs
  add column if not exists twilio_auth_token text;

comment on column public.client_configs.twilio_auth_token is
  'Twilio Auth Token for X-Twilio-Signature validation. NULL with verification on = fail closed.';

-- Explicit opt-out, so a missing token fails closed rather than
-- silently accepting forged webhooks.
alter table public.client_configs
  add column if not exists twilio_verify_signatures boolean not null default true;

comment on column public.client_configs.twilio_verify_signatures is
  'When true (default) Twilio webhooks must carry a valid X-Twilio-Signature. Set false only for local testing.';
