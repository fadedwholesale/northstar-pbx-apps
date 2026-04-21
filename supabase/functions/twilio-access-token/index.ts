import twilio from "npm:twilio@5.4.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value || !String(value).trim()) throw new Error(`Missing required env var: ${name}`);
  return String(value).trim();
}

/**
 * Confirms SK + secret authenticate to Twilio REST.
 * Note: GET /Accounts/{Sid}.json returns 401 when using API Key Basic auth even for valid keys;
 * use a scoped resource Twilio documents for API-key auth instead.
 */
async function assertApiKeyAuthenticates(
  accountSid: string,
  apiKeySid: string,
  apiSecret: string,
): Promise<void> {
  const auth = btoa(`${apiKeySid}:${apiSecret}`);
  const url =
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PageSize=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      "Twilio rejected the API Key (HTTP 401/403). TWILIO_API_SECRET must match TWILIO_API_KEY (SK…) from Console → Account → API keys & tokens — not your Auth Token.",
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Twilio credentials check failed (${res.status}): ${body.slice(0, 240)}`);
  }
}

/** Voice grant AP… must exist on this account or the browser often shows 20101. */
async function assertTwiMLApplicationExists(
  accountSid: string,
  apiKeySid: string,
  apiSecret: string,
  applicationSid: string,
): Promise<void> {
  const auth = btoa(`${apiKeySid}:${apiSecret}`);
  const url =
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Applications/${applicationSid}.json`;
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${auth}` },
  });
  if (res.status === 404) {
    throw new Error(
      `TwiML App ${applicationSid} was not found on this Account. Set TWILIO_TWIML_APP_SID to your Voice TwiML App under Console → Develop → Tools → TwiML apps (SID starts with AP).`,
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TwiML App lookup failed (${res.status}): ${body.slice(0, 240)}`);
  }
}

/** Twilio Voice JWT must use API Key SID (SK…), Account SID (AC…), TwiML App (AP…). Wrong shapes cause 20101 in the browser. */
function assertTwilioCredentialShapes(accountSid: string, apiKeySid: string, twimlAppSid: string): void {
  const ac = accountSid.trim();
  const sk = apiKeySid.trim();
  const ap = twimlAppSid.trim();
  if (!ac.startsWith("AC")) {
    throw new Error("TWILIO_ACCOUNT_SID must be your Account SID (starts with AC)");
  }
  if (!sk.startsWith("SK")) {
    throw new Error(
      "TWILIO_API_KEY must be an API Key SID from Twilio Console → Account → API keys & tokens (starts with SK). Do not use your Account SID or Auth Token here",
    );
  }
  if (!ap.startsWith("AP")) {
    throw new Error("TWILIO_TWIML_APP_SID must be a TwiML Application SID (starts with AP)");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const requestBody = await req.json().catch(() => ({}));
    const identity = String(requestBody?.identity || "northstar-agent");

    const accountSid = requiredEnv("TWILIO_ACCOUNT_SID");
    const apiKey = requiredEnv("TWILIO_API_KEY");
    const apiSecret = requiredEnv("TWILIO_API_SECRET");
    const twimlAppSid = requiredEnv("TWILIO_TWIML_APP_SID");

    assertTwilioCredentialShapes(accountSid, apiKey, twimlAppSid);
    await assertApiKeyAuthenticates(accountSid, apiKey, apiSecret);
    await assertTwiMLApplicationExists(accountSid, apiKey, apiSecret, twimlAppSid);

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const token = new AccessToken(accountSid, apiKey, apiSecret, {
      identity,
      ttl: 3600,
    });

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: twimlAppSid,
      incomingAllow: true,
    });
    token.addGrant(voiceGrant);

    const jwt = token.toJwt();

    return new Response(JSON.stringify({ token: jwt }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Failed to generate Twilio access token",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
