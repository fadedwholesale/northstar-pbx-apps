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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Twilio posts x-www-form-urlencoded by default.
  const body = await req.text();
  const params = new URLSearchParams(body);
  const toRaw = params.get("To") || params.get("to") || "";
  const callerIdRaw = params.get("callerId") || params.get("CallerId") || "";

  const to = normalizeDialTarget(toRaw);
  const callerId = normalizeDialTarget(callerIdRaw);

  let dialAttrs = "";
  if (callerId) dialAttrs += ` callerId="${xmlEscape(callerId)}"`;
  if (/^\d{2,6}$/.test(to)) {
    // Extension-style destination.
    dialAttrs += " answerOnBridge=\"true\"";
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial${dialAttrs}>${xmlEscape(to)}</Dial>
</Response>`;

  return new Response(xml, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/xml; charset=utf-8",
    },
  });
});
