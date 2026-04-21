const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function xmlEscape(input: string): string {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeDialTarget(raw: string): string {
  const value = String(raw || "").trim();
  // Allow +, digits, *, # for quick dial / extensions.
  return value.replace(/[^0-9+*#]/g, "");
}

/** Prefer E.164 for PSTN Dial (Twilio expects +country... for most outbound). */
function toE164Pstn(normalized: string): string {
  const d = normalized.replace(/[^0-9]/g, "");
  if (!d) return "";
  if (normalized.startsWith("+") && normalized.length > 1) return "+" + d;
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return "+" + d;
}

/** Short numeric extensions (2–6 digits): do not force +1 country code. */
function formatOutboundDestination(normalized: string): string {
  const core = normalized.replace(/[^0-9*#]/g, "");
  if (/^\d{2,6}$/.test(core)) return core;
  return toE164Pstn(normalized);
}

function requiredEnv(name: string, fallback = ""): string {
  const v = Deno.env.get(name);
  if (v) return v;
  return fallback;
}

/**
 * Inbound PSTN → Twilio Voice (browser): ring a registered Client identity.
 * Must match the identity used when minting the access token (e.g. agent_jd).
 */
function twimlInboundRingClient(clientIdentity: string, _from: string): string {
  const id = xmlEscape(clientIdentity);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial answerOnBridge="true">
    <Client>${id}</Client>
  </Dial>
</Response>`;
}

/**
 * Outbound from TwiML App (Voice SDK connect): dial PSTN or extension in `To`.
 * Use explicit <Number> noun (plain text in <Dial> is unreliable).
 */
function twimlOutboundDial(toNormalized: string, callerIdNormalized: string): string {
  let dialAttrs = "";
  const cid = callerIdNormalized ? toE164Pstn(callerIdNormalized) : "";
  if (cid) dialAttrs += ` callerId="${xmlEscape(cid)}"`;
  const dest = formatOutboundDestination(toNormalized);
  if (/^\d{2,6}$/.test(dest)) dialAttrs += " answerOnBridge=\"true\"";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial${dialAttrs}>
    <Number>${xmlEscape(dest)}</Number>
  </Dial>
</Response>`;
}

function twimlFallbackMessage(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Sorry, we could not connect your call. Please try again later.</Say>
  <Hangup/>
</Response>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Twilio posts x-www-form-urlencoded by default.
  const body = await req.text();
  const params = new URLSearchParams(body);

  // Primary-handler failure fallback: Twilio may POST with minimal fields; return polite TwiML.
  if (params.get("ErrorCode") || params.get("errorCode")) {
    return new Response(twimlFallbackMessage(), {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/xml; charset=utf-8",
      },
    });
  }

  const from = params.get("From") || "";
  const toRaw = params.get("To") || params.get("to") || "";
  const direction = (params.get("Direction") || "").toLowerCase();

  const fromIsClient = from.startsWith("client:");
  const toTrimmed = String(toRaw || "").trim();
  const toLooksLikeClientUri = toTrimmed.toLowerCase().startsWith("client:");
  const toNormalized = normalizeDialTarget(toRaw);

  /**
   * Voice JS SDK outbound: From is client:identity; To is the PSTN/extension target.
   * Must run BEFORE any Direction-based inbound branch — Twilio sometimes sends Direction
   * values (e.g. inbound-api) that must NOT be treated as PSTN→browser, or Twilio will
   * <Dial><Client>…</Client></Dial> back to the same browser while it is already in an
   * outbound call ("Device busy; ignoring incoming invite") and audio never bridges.
   */
  const isVoiceSdkOutbound =
    fromIsClient &&
    toNormalized.length > 0 &&
    !toLooksLikeClientUri;

  /**
   * Someone dialing your Twilio phone number → ring the browser Client.
   * From is a PSTN/SIP caller, not client:…
   */
  const isPstnInboundToTwilio =
    !fromIsClient &&
    direction === "inbound";

  if (isVoiceSdkOutbound) {
    const callerIdRaw = params.get("callerId") || params.get("CallerId") || "";
    const callerId = normalizeDialTarget(callerIdRaw);
    const xml = twimlOutboundDial(toNormalized, callerId);
    return new Response(xml, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/xml; charset=utf-8",
      },
    });
  }

  if (isPstnInboundToTwilio) {
    const clientIdentity = requiredEnv(
      "TWILIO_VOICE_CLIENT_IDENTITY",
      "agent_jd",
    );
    const xml = twimlInboundRingClient(clientIdentity, from);
    return new Response(xml, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/xml; charset=utf-8",
      },
    });
  }

  // REST-initiated outbound or edge cases: prefer dialing To if present.
  const callerIdRaw = params.get("callerId") || params.get("CallerId") || "";
  const callerId = normalizeDialTarget(callerIdRaw);

  if (toNormalized.length > 0) {
    const xml = twimlOutboundDial(toNormalized, callerId);
    return new Response(xml, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/xml; charset=utf-8",
      },
    });
  }

  return new Response(twimlFallbackMessage(), {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/xml; charset=utf-8",
    },
  });
});
