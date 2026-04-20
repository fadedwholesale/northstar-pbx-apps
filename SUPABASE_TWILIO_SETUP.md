# Supabase + Twilio Setup

This repo now supports:
- Supabase-backed CRM data sync (`northstar_contacts`, `northstar_activities`)
- Twilio token retrieval via Supabase Edge Function (`twilio-access-token`)
- Twilio Voice SDK bootstrap in `agent/index.html` and runtime call control in `agent/telephony-layer.js`

## 1) Configure Supabase in HTML

In both `agent/index.html` and `admin/index.html`, set:

```html
<meta name="northstar-supabase-url" content="https://YOUR_PROJECT.supabase.co" />
<meta name="northstar-supabase-anon-key" content="YOUR_SUPABASE_ANON_KEY" />
```

Agent-only (already present):

```html
<meta name="northstar-twilio-token-function" content="twilio-access-token" />
```

## 2) Create CRM tables in Supabase

Run `supabase/schema.sql` (or paste in SQL editor):

```sql
create table if not exists public.northstar_contacts (
  id text primary key,
  business text not null,
  name text,
  phone text,
  city text,
  vertical text,
  stage text,
  last_outcome text,
  updated_at timestamptz default now()
);

create table if not exists public.northstar_activities (
  id text primary key,
  type text not null default 'call',
  agent_id text,
  agent_name text,
  contact_id text,
  business text,
  vertical text,
  disposition text,
  notes text,
  duration_sec integer,
  recording boolean default false,
  created_at timestamptz default now()
);

alter table public.northstar_contacts enable row level security;
alter table public.northstar_activities enable row level security;

create policy "anon read contacts" on public.northstar_contacts
for select to anon using (true);
create policy "anon write contacts" on public.northstar_contacts
for insert to anon with check (true);
create policy "anon update contacts" on public.northstar_contacts
for update to anon using (true) with check (true);

create policy "anon read activities" on public.northstar_activities
for select to anon using (true);
create policy "anon write activities" on public.northstar_activities
for insert to anon with check (true);
create policy "anon update activities" on public.northstar_activities
for update to anon using (true) with check (true);
```

Note: these anon write policies are for fast development. Tighten them before production.

## 3) Create Twilio token edge function

This repo includes `supabase/functions/twilio-access-token/index.ts`.
Deploy that function from this repo's `supabase/` directory:

```ts
import { AccessToken } from "npm:twilio@5";
import { VoiceGrant } from "npm:twilio@5";

Deno.serve(async (req) => {
  const { identity } = await req.json();
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const apiKey = Deno.env.get("TWILIO_API_KEY")!;
  const apiSecret = Deno.env.get("TWILIO_API_SECRET")!;
  const twimlAppSid = Deno.env.get("TWILIO_TWIML_APP_SID")!;

  const token = new AccessToken(accountSid, apiKey, apiSecret, {
    identity: identity || "northstar-agent",
    ttl: 3600,
  });
  token.addGrant(new VoiceGrant({ outgoingApplicationSid: twimlAppSid, incomingAllow: true }));

  return new Response(JSON.stringify({ token: token.toJwt() }), {
    headers: { "Content-Type": "application/json" },
  });
});
```

Set Supabase function secrets:
- `TWILIO_ACCOUNT_SID`
- `TWILIO_API_KEY`
- `TWILIO_API_SECRET`
- `TWILIO_TWIML_APP_SID`

Deploy:

```bash
supabase functions deploy twilio-access-token
```

The function response must include:

```json
{ "token": "eyJ..." }
```

## 4) Deploy voice webhook function

This repo includes `supabase/functions/twilio-voice/index.ts`.

Deploy:

```bash
supabase functions deploy twilio-voice
```

Your request URL will be:

`https://<project-ref>.functions.supabase.co/twilio-voice`

## 5) TwiML App setup

In Twilio Console:
- Create a TwiML App
- Set Voice Request URL to your deployed `twilio-voice` function URL
- Use that TwiML App SID as `TWILIO_TWIML_APP_SID` in Supabase function secrets

Example outbound TwiML behavior:
- Dial PSTN number passed as `To`
- Apply caller ID from selected line in the dialer

## 6) Phone number webhooks (replace Twilio demo URL)

Do **not** leave `https://demo.twilio.com/welcome/voice/` on your purchased number. Use the same production voice function:

**Voice webhook (when a call comes in)**  
- **URL:** `https://gbffglopzqxmsvzazkfj.functions.supabase.co/twilio-voice`  
- **HTTP:** `POST`

That endpoint returns TwiML that routes **inbound** PSTN callers to your browser agent via `<Dial><Client>…</Client></Dial>`.

Set the client identity Twilio should ring (must match the identity in your access token, e.g. `agent_jd`):

```bash
supabase secrets set TWILIO_VOICE_CLIENT_IDENTITY=agent_jd
```

**Primary handler fails (recommended)**  
Use the same URL so callers hear a short message instead of silence:

- **URL:** `https://gbffglopzqxmsvzazkfj.functions.supabase.co/twilio-voice`  
- **HTTP:** `POST`

**Call status changes (optional)**  
Point to your own analytics webhook later, or leave empty for now.

## 7) What is already wired in this repo

- `agent/crm-store.js` and `admin/crm-store.js`:
  - local-first caching
  - async upsert + pull sync to Supabase
- `agent/telephony-layer.js`:
  - `fetchTwilioAccessToken(identity)` to call Supabase Edge Function
- `agent/dialer-app.js`:
  - attempts Twilio token fetch on startup
  - CRM panel shows local vs Supabase status
