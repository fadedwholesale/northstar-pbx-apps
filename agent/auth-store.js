/**
 * Supabase Auth + northstar_profiles → resolved agent seat (Twilio identity, numbers).
 */
(function (global) {
  var profileRow = null;
  var authUser = null;
  var listeners = [];
  var signInInFlight = null;
  var sessionInitInFlight = null;
  var signInStartedAt = 0;

  function emit() {
    listeners.forEach(function (fn) {
      try {
        fn();
      } catch (e) {}
    });
  }

  function getClient() {
    return global.NorthstarSupabase && typeof global.NorthstarSupabase.getClient === 'function'
      ? global.NorthstarSupabase.getClient()
      : null;
  }

  function clearStaleAuthStorage(fullSessionReset) {
    try {
      if (typeof global.localStorage === 'undefined') return;
      var cfgKey =
        global.NorthstarSupabase &&
        global.NorthstarSupabase.config &&
        global.NorthstarSupabase.config.storageKey
          ? String(global.NorthstarSupabase.config.storageKey)
          : 'northstar-supabase-auth';
      if (fullSessionReset) {
        global.localStorage.removeItem('northstar-supabase-auth');
        global.localStorage.removeItem('northstar-supabase-auth-v2');
        global.localStorage.removeItem(cfgKey);
      }
      global.localStorage.removeItem('lock:northstar-supabase-auth');
      global.localStorage.removeItem('lock:' + cfgKey);
    } catch (_e) {}
  }

  function withTimeout(promise, ms, label) {
    var timer = null;
    return Promise.race([
      promise,
      new Promise(function (_, reject) {
        timer = setTimeout(function () {
          reject(new Error((label || 'Operation') + ' timed out after ' + ms + 'ms'));
        }, ms);
      }),
    ]).then(
      function (value) {
        if (timer) clearTimeout(timer);
        return value;
      },
      function (err) {
        if (timer) clearTimeout(timer);
        throw err;
      }
    );
  }

  function requireAuthMeta() {
    var el = document.querySelector('meta[name="northstar-require-auth"]');
    if (!el) return global.NorthstarSupabase && global.NorthstarSupabase.isConfigured && global.NorthstarSupabase.isConfigured();
    var v = String(el.getAttribute('content') || '').trim().toLowerCase();
    if (v === 'false' || v === '0') return false;
    return !!(global.NorthstarSupabase && global.NorthstarSupabase.isConfigured && global.NorthstarSupabase.isConfigured());
  }

  function initialsFromName(name) {
    return String(name || '')
      .trim()
      .split(/\s+/)
      .map(function (p) {
        return p[0];
      })
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'NA';
  }

  async function fetchProfile(userId) {
    var client = getClient();
    if (!client) return null;
    var res = await withTimeout(
      client.from('northstar_profiles').select('*').eq('id', userId).maybeSingle(),
      7000,
      'Load employee profile'
    );
    if (res.error) throw res.error;
    return res.data || null;
  }

  async function upsertMinimalProfile(user) {
    var client = getClient();
    if (!client) return null;
    var row = {
      id: user.id,
      email: user.email || '',
      display_name:
        (user.user_metadata && user.user_metadata.full_name) ||
        String(user.email || '').split('@')[0] ||
        'Agent',
      updated_at: new Date().toISOString(),
    };
    var res = await withTimeout(
      client.from('northstar_profiles').upsert(row, { onConflict: 'id' }).select().maybeSingle(),
      7000,
      'Create employee profile'
    );
    if (res.error) throw res.error;
    return res.data;
  }

  async function ensureProfile(user) {
    try {
      var p = await fetchProfile(user.id);
      if (p) return p;
      return await upsertMinimalProfile(user);
    } catch (_e) {
      // Never block login just because profile lookup/upsert was slow.
      return {
        id: user.id,
        email: user.email || '',
        display_name:
          (user.user_metadata && user.user_metadata.full_name) ||
          String(user.email || '').split('@')[0] ||
          'Agent',
      };
    }
  }

  /**
   * Merge profile with team roster row (Supabase northstar_team_members).
   */
  function resolveAgent(user, profile) {
    var roster = [];
    if (global.NorthstarTeamRoster && typeof global.NorthstarTeamRoster.getMembers === 'function') {
      roster = NorthstarTeamRoster.getMembers();
    }
    var tw = profile && profile.twilio_client_identity ? String(profile.twilio_client_identity).trim() : '';
    var extFromProfile = profile && profile.extension ? String(profile.extension).trim() : '';
    var uid = String(user.id || '').trim();
    var rosterRow = null;
    for (var pi = 0; pi < roster.length; pi++) {
      var rid = roster[pi].profileId != null ? String(roster[pi].profileId).trim() : '';
      if (rid && rid === uid) {
        rosterRow = roster[pi];
        break;
      }
    }
    if (!rosterRow && tw) {
      for (var i = 0; i < roster.length; i++) {
        if ((roster[i].twilioIdentity || roster[i].id) === tw) {
          rosterRow = roster[i];
          break;
        }
      }
    }
    if (!rosterRow && extFromProfile) {
      for (var j = 0; j < roster.length; j++) {
        if (String(roster[j].ext || '') === extFromProfile) {
          rosterRow = roster[j];
          break;
        }
      }
    }

    /** Voice token, CRM, channels, inbox — always auth user id (never phone / Twilio string). */
    var id = uid;

    var name =
      (rosterRow && rosterRow.name) ||
      (profile && profile.display_name) ||
      String(user.email || '').split('@')[0] ||
      'Agent';

    var initials = (rosterRow && rosterRow.av) || initialsFromName(name);
    var extension = (rosterRow && rosterRow.ext) || extFromProfile || '';

    return {
      id: id,
      twilioIdentity: tw,
      name: name,
      initials: initials,
      extension: extension,
      smsNumberE164: profile && profile.sms_number_e164 ? String(profile.sms_number_e164).trim() : '',
      voiceEdge:
        profile && profile.voice_edge != null && String(profile.voice_edge).trim()
          ? String(profile.voice_edge).trim().toLowerCase()
          : null,
      linkedToSeat: !!(rosterRow || (profile && profile.twilio_client_identity)),
      pendingSeat: !(profile && profile.twilio_client_identity),
      profile: profile,
      user: user,
      rosterRow: rosterRow,
    };
  }

  async function hydrate(user) {
    authUser = user;
    profileRow = await withTimeout(ensureProfile(user), 9000, 'Hydrate employee profile');
    emit();
    return resolveAgent(user, profileRow);
  }

  async function refreshProfile() {
    if (!authUser) return null;
    profileRow = await withTimeout(fetchProfile(authUser.id), 7000, 'Refresh profile');
    emit();
    return resolveAgent(authUser, profileRow);
  }

  /** Persist voice region on the employee profile so it survives hard refresh and new devices. */
  async function updateVoiceEdge(voiceEdge) {
    var client = getClient();
    if (!client || !authUser) {
      return { ok: false, reason: 'not-signed-in' };
    }
    var v = String(voiceEdge || 'auto').trim().toLowerCase() || 'auto';
    var res = await withTimeout(
      client
        .from('northstar_profiles')
        .update({
          voice_edge: v,
          updated_at: new Date().toISOString(),
        })
        .eq('id', authUser.id)
        .select('*')
        .maybeSingle(),
      7000,
      'Save voice region'
    );
    if (res.error) throw res.error;
    if (res.data) profileRow = res.data;
    else if (profileRow) profileRow.voice_edge = v;
    emit();
    return { ok: true, voiceEdge: v, profile: profileRow };
  }

  function isAuthLockContention(err) {
    var msg = err && err.message ? String(err.message).toLowerCase() : String(err || "").toLowerCase();
    if (msg.indexOf("stole it") !== -1) return true;
    if (msg.indexOf("northstar-supabase-auth") !== -1) return true;
    if (msg.indexOf("lock:") !== -1 && msg.indexOf("released") !== -1) return true;
    return false;
  }

  async function retryOnLock(fn, attempts) {
    var max = typeof attempts === "number" ? attempts : 4;
    var delay = 80;
    var lastErr = null;
    for (var i = 0; i < max; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (!isAuthLockContention(e) || i === max - 1) throw e;
        await new Promise(function (r) {
          setTimeout(r, delay);
        });
        delay = Math.min(delay * 2, 600);
      }
    }
    throw lastErr;
  }

  global.NorthstarAuth = {
    requireAuthEnabled: requireAuthMeta,

    getUser: function () {
      return authUser;
    },

    getProfile: function () {
      return profileRow;
    },

    /** Resolved seat for CRM / Twilio / inbox (mutable AGENT shape). */
    resolveSeat: function () {
      if (!authUser || !profileRow) return null;
      return resolveAgent(authUser, profileRow);
    },

    subscribe: function (fn) {
      listeners.push(fn);
      return function () {
        listeners = listeners.filter(function (f) {
          return f !== fn;
        });
      };
    },

    /** Restore session + profile; returns { session, seat } or null if signed out. */
    initializeSession: async function () {
      if (sessionInitInFlight) return sessionInitInFlight;
      var client = getClient();
      if (!client) return null;
      clearStaleAuthStorage(false);
      sessionInitInFlight = withTimeout(
        retryOnLock(function () {
          return client.auth.getSession();
        }),
        7000,
        'Restore session'
      )
        .then(async function (sessionRes) {
          var session = sessionRes.data && sessionRes.data.session;
          if (!session || !session.user) return null;
          var seat = await hydrate(session.user);
          return { session: session, seat: seat };
        })
        .finally(function () {
          sessionInitInFlight = null;
        });
      return sessionInitInFlight;
    },

    signInWithPassword: async function (email, password) {
      var client = getClient();
      if (!client) throw new Error('Supabase not configured');
      if (signInInFlight) {
        if (Date.now() - signInStartedAt < 20000) return signInInFlight;
        signInInFlight = null;
      }
      if (sessionInitInFlight) {
        try {
          await sessionInitInFlight;
        } catch (_e) {}
      }
      var em = String(email || '').trim();
      var pw = String(password || '');
      signInStartedAt = Date.now();
      signInInFlight = withTimeout(
        retryOnLock(function () {
          return client.auth.signInWithPassword({ email: em, password: pw });
        }),
        9000,
        'Supabase SDK sign-in'
      )
        .catch(async function (sdkErr) {
          var lockMsg = sdkErr && sdkErr.message ? String(sdkErr.message).toLowerCase() : '';
          if (isAuthLockContention(sdkErr) || lockMsg.indexOf('timed out') !== -1) {
            clearStaleAuthStorage(true);
          }
          // Fallback: direct Auth REST token exchange + setSession.
          var cfg =
            global.NorthstarSupabase && global.NorthstarSupabase.config
              ? global.NorthstarSupabase.config
              : { url: '', anonKey: '' };
          if (!cfg.url || !cfg.anonKey) throw new Error('Supabase config missing for login fallback');
          var authUrl = String(cfg.url).replace(/\/+$/, '') + '/auth/v1/token?grant_type=password';
          var resp = await withTimeout(
            fetch(authUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                apikey: cfg.anonKey,
              },
              body: JSON.stringify({ email: em, password: pw }),
            }),
            12000,
            'Auth API sign-in'
          );
          var body = await resp.json().catch(function () {
            return null;
          });
          if (!resp.ok) {
            var msg =
              (body && (body.msg || body.error_description || body.error)) ||
              ('Auth API failed (' + resp.status + ')');
            throw new Error(msg);
          }
          var accessToken = body && body.access_token;
          var refreshToken = body && body.refresh_token;
          if (!accessToken || !refreshToken) throw new Error('Auth API did not return a session');
          var setRes = await withTimeout(
            retryOnLock(function () {
              return client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
            }),
            9000,
            'Set session'
          );
          if (setRes && setRes.error) throw setRes.error;
          return setRes;
        })
        .then(async function (res) {
          if (res && res.error) throw res.error;
          var user = res && res.data ? res.data.user : null;
          if (!user) {
            var gotUser = await retryOnLock(function () {
              return client.auth.getUser();
            });
            user = gotUser && gotUser.data ? gotUser.data.user : null;
          }
          if (!user) throw new Error('Sign-in succeeded but user session could not be resolved');
          var seat = await hydrate(user);
          return { user: user, seat: seat };
        })
        .finally(function () {
          signInInFlight = null;
          signInStartedAt = 0;
        });
      return signInInFlight;
    },

    signOut: async function () {
      var client = getClient();
      if (client) await client.auth.signOut();
      authUser = null;
      profileRow = null;
      emit();
      global.location.reload();
    },

    refreshProfile: refreshProfile,

    updateVoiceEdge: updateVoiceEdge,

    /** Wire auth listener (login elsewhere / token refresh). */
    attachAuthListener: function (onSeatChange) {
      var client = getClient();
      if (!client || typeof client.auth.onAuthStateChange !== 'function') return function () {};
      var sub = client.auth.onAuthStateChange(async function (_event, session) {
        if (session && session.user) {
          try {
            await hydrate(session.user);
          } catch (he) {
            if (!isAuthLockContention(he)) throw he;
            await new Promise(function (r) {
              setTimeout(r, 120);
            });
            await hydrate(session.user);
          }
          if (typeof onSeatChange === 'function') onSeatChange(resolveAgent(session.user, profileRow));
        } else {
          authUser = null;
          profileRow = null;
          emit();
          if (typeof onSeatChange === 'function') onSeatChange(null);
        }
      });
      return function () {
        try {
          if (sub && sub.data && sub.data.subscription) sub.data.subscription.unsubscribe();
        } catch (e) {}
      };
    },
  };
})(typeof window !== 'undefined' ? window : this);
