/**
 * Northstar Supabase bootstrap for static apps.
 * Reads config from meta tags or global overrides.
 */
(function (global) {
  function readMeta(name) {
    var el = document.querySelector('meta[name="' + name + '"]');
    return el ? String(el.getAttribute('content') || '').trim() : '';
  }

  var config = {
    url: readMeta('northstar-supabase-url') || String(global.NS_SUPABASE_URL || '').trim(),
    anonKey: readMeta('northstar-supabase-anon-key') || String(global.NS_SUPABASE_ANON_KEY || '').trim(),
    twilioTokenFunction: readMeta('northstar-twilio-token-function') || String(global.NS_TWILIO_TOKEN_FUNCTION || '').trim() || 'twilio-access-token',
  };

  var client = null;

  function isConfigured() {
    return !!(config.url && config.anonKey);
  }

  function getClient() {
    if (client) return client;
    if (!isConfigured()) return null;
    if (!global.supabase || typeof global.supabase.createClient !== 'function') return null;
    client = global.supabase.createClient(config.url, config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return client;
  }

  global.NorthstarSupabase = {
    config: config,
    isConfigured: isConfigured,
    getClient: getClient,
  };
})(typeof window !== 'undefined' ? window : this);
