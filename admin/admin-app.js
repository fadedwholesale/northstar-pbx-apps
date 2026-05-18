/* global NorthstarCRM, NorthstarTeamRoster, NorthstarSupabase, NorthstarAdminAuth */
(function () {
  var teamEditId = null;
  var liveOpsRealtimeStarted = false;
  var crmRealtimeStarted = false;
  var metricsRealtimeStarted = false;
  var numberByAgent = {};
  var numbersCache = [];
  var didBoot = false;
  /** Legacy local-only key; migrated once into northstar_admin_ui_preferences. */
  var LEAD_ASSIGN_REP_STORAGE_KEY = 'northstar_admin_lead_assign_rep_id';
  var leadAssignRepChangeBound = false;
  /** In-memory copy of server prefs for this signed-in admin (authoritative when sync succeeds). */
  var adminUiPrefsCache = {};
  var FALLBACK_ADMIN_EMAIL = 'hello@northstaragents.us';
  var FALLBACK_ADMIN_PASSWORD = 'Northstar1!';

  var PRES_LABELS = { g: 'Available', a: 'On break', y: 'Busy', gr: 'Offline' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /** Canonical CRM / inventory key = Supabase auth user id when linked; else Twilio client label / roster id. */
  function seatAgentKey(m) {
    if (!m) return '';
    return String(m.profileId || m.twilioIdentity || m.id || '').trim();
  }

  function seatWrapClass(status) {
    if (status === 'gr') return 'seat off';
    if (status === 'a' || status === 'y') return 'seat brk';
    return 'seat';
  }

  function dotWrapClass(status) {
    if (status === 'g') return 'g';
    if (status === 'a') return 'a';
    if (status === 'y') return 'a';
    return 'gr';
  }

  function getClient() {
    return typeof NorthstarSupabase !== 'undefined' && NorthstarSupabase.getClient ? NorthstarSupabase.getClient() : null;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function syncChromeHintVisibility() {
    var hint = $('authChromeHint');
    if (!hint) return;
    if (typeof location !== 'undefined' && String(location.hostname || '').indexOf('vercel.app') === -1) {
      hint.style.display = 'none';
    } else {
      hint.style.display = '';
    }
  }

  function showAuthGate(msg) {
    var gate = $('authGate');
    var shell = $('adminShell');
    var err = $('authErr');
    if (shell) shell.style.display = 'none';
    if (gate) gate.style.display = 'flex';
    syncChromeHintVisibility();
    if (err) err.textContent = msg || '';
  }

  function showAppShell() {
    var gate = $('authGate');
    var shell = $('adminShell');
    if (gate) gate.style.display = 'none';
    if (shell) shell.style.display = '';
  }

  function applyAdminIdentity(ctx) {
    var initialsEl = $('adminInitials');
    var idEl = $('adminIdentity');
    var signOut = $('btnAdminSignOut');
    if (initialsEl) initialsEl.textContent = (ctx && ctx.initials) || 'NA';
    if (idEl) {
      idEl.textContent =
        ctx && ctx.displayName
          ? ctx.displayName + (ctx.role ? ' (' + ctx.role + ')' : '')
          : 'Not signed in';
    }
    if (signOut) signOut.style.display = ctx ? '' : 'none';
  }

  function setAuthSigningIn(busy) {
    var submit = $('authSubmit');
    var email = $('authEmail');
    var pass = $('authPass');
    if (submit) {
      submit.disabled = !!busy;
      submit.textContent = busy ? 'Signing in…' : 'Sign in';
    }
    if (email) email.disabled = !!busy;
    if (pass) pass.disabled = !!busy;
  }

  function canUseLocalFallback(email, password) {
    return (
      String(email || '').trim().toLowerCase() === FALLBACK_ADMIN_EMAIL &&
      String(password || '') === FALLBACK_ADMIN_PASSWORD
    );
  }

  function enterWithLocalFallback() {
    var ctx = {
      displayName: 'Northstar Admin',
      role: 'Admin',
      isAdmin: true,
      initials: 'NA',
    };
    applyAdminIdentity(ctx);
    showAppShell();
    boot();
  }

  function wireAdminAuthForm() {
    var form = $('adminAuthForm');
    var submit = $('authSubmit');
    var email = $('authEmail');
    var pass = $('authPass');
    var err = $('authErr');
    var signOut = $('btnAdminSignOut');
    if (signOut && !signOut.dataset.bound) {
      signOut.dataset.bound = '1';
      signOut.addEventListener('click', function () {
        if (typeof NorthstarAdminAuth === 'undefined' || !NorthstarAdminAuth.signOut) return;
        NorthstarAdminAuth.signOut().catch(function (e) {
          alert('Sign out failed: ' + (e && e.message ? e.message : String(e)));
        });
      });
    }
    if (!submit || submit.dataset.bound) return;
    submit.dataset.bound = '1';
    function runAdminSignIn(ev) {
      if (ev) ev.preventDefault();
      if (err) err.textContent = '';
      var inEmail = (email && email.value) || '';
      var inPass = (pass && pass.value) || '';
      if (canUseLocalFallback(inEmail, inPass)) {
        enterWithLocalFallback();
        return;
      }
      if (typeof NorthstarAdminAuth === 'undefined') {
        if (err) err.textContent = 'Auth module failed to load. Refresh the page or check that scripts are not blocked.';
        return;
      }
      if (!NorthstarAdminAuth.signInWithPassword) {
        if (err) err.textContent = 'Sign-in is unavailable (missing handler).';
        return;
      }
      if (!NorthstarSupabase || !NorthstarSupabase.getClient || !NorthstarSupabase.getClient()) {
        if (err) err.textContent = 'Supabase client is not configured. Check site settings / meta tags.';
        return;
      }
      setAuthSigningIn(true);
      var slowHintTimer = setTimeout(function () {
        if (err) {
          err.textContent =
            'Still working… If this sits here a long time, Chrome may be throttling requests on this preview URL. Try Details → Visit this unsafe site, or use a custom domain (e.g. admin.northstaragents.us).';
          err.style.color = '#92400e';
        }
      }, 12000);
      NorthstarAdminAuth.signInWithPassword(inEmail, inPass)
        .then(function (res) {
          clearTimeout(slowHintTimer);
          if (err) err.style.color = '#b91c1c';
          if (!res || !res.context) {
            throw new Error('No employee profile found after sign-in.');
          }
          if (!res.context.isAdmin) {
            throw new Error('Your account is valid but does not have Admin or Supervisor access in the team directory.');
          }
          applyAdminIdentity(res.context);
          showAppShell();
          boot();
        })
        .catch(function (e) {
          clearTimeout(slowHintTimer);
          if (err) err.style.color = '#b91c1c';
          if (canUseLocalFallback(inEmail, inPass)) {
            enterWithLocalFallback();
            return;
          }
          var msg = e && e.message ? e.message : String(e);
          if (err) err.textContent = msg;
          try {
            console.error('[Northstar admin] sign-in failed', e);
          } catch (_e) {}
        })
        .then(function () {
          setAuthSigningIn(false);
        });
    }
    if (form && !form.dataset.bound) {
      form.dataset.bound = '1';
      form.addEventListener('submit', runAdminSignIn);
    } else {
      submit.addEventListener('click', runAdminSignIn);
    }
  }

  function setTeamSaveFeedback(message, kind) {
    var el = document.getElementById('tmSaveStatus');
    if (!el) return;
    el.textContent = message || '';
    el.style.color = kind === 'error' ? '#b91c1c' : kind === 'ok' ? '#15803d' : '#374151';
    if (message) {
      try {
        console.log('[Northstar admin] employee save:', kind || 'info', message);
      } catch (_e) {}
    }
  }

  function setTeamSaveBusy(busy) {
    var btn = document.getElementById('tmSaveBtn');
    if (!btn) return;
    btn.disabled = !!busy;
    btn.textContent = busy ? 'Saving…' : 'Save employee';
  }

  function fmtPhone(v) {
    var s = String(v || '').trim();
    if (!s) return '—';
    var d = s.replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') {
      return '+1 (' + d.slice(1, 4) + ') ' + d.slice(4, 7) + '-' + d.slice(7);
    }
    return s;
  }

  function refreshNumbersInventory() {
    var client = getClient();
    var numTb = document.getElementById('numbersBody');
    if (!client) {
      numbersCache = [];
      numberByAgent = {};
      if (numTb) numTb.innerHTML = '<tr><td colspan="5">Supabase not configured.</td></tr>';
      return Promise.resolve();
    }
    function applyNumbers(rows) {
      numbersCache = rows || [];
      numberByAgent = {};
      numbersCache.forEach(function (n) {
        if (n.assigned_agent_id) numberByAgent[n.assigned_agent_id] = n;
        if (n.assigned_profile_id) numberByAgent[String(n.assigned_profile_id)] = n;
      });
      if (numTb) {
        numTb.innerHTML =
          numbersCache
            .map(function (n) {
              return (
                '<tr data-e164="' + esc(n.e164) + '">' +
                '<td class="mono">' +
                esc(fmtPhone(n.e164)) +
                '</td><td>' +
                esc(n.number_type || 'Main') +
                '</td><td>' +
                esc((n.routes_to || '—') + (n.webhook_sync_status === 'error' ? ' (webhook error)' : '')) +
                '</td><td>' +
                (n.sms_enabled ? 'Enabled' : 'Off') +
                '</td><td>' +
                esc(n.e911_location || '—') +
                '<div style="margin-top:6px;display:flex;gap:6px">' +
                '<button type="button" class="db blu" style="font-size:10px;padding:3px 7px" onclick="editNumber(\'' + esc(n.e164) + '\')">Edit</button>' +
                '<button type="button" class="db" style="font-size:10px;padding:3px 7px" onclick="deleteNumber(\'' + esc(n.e164) + '\')">Delete</button>' +
                '</div>' +
                '</td></tr>'
              );
            })
            .join('') || '<tr><td colspan="5">No live Twilio numbers found.</td></tr>';
      }
    }

    return client.functions
      .invoke('admin-number-list-live', { body: {} })
      .then(function (res) {
        if (res.error) throw res.error;
        if (res.data && res.data.error) throw new Error(res.data.error);
        applyNumbers((res.data && res.data.numbers) || []);
      })
      .catch(function (err) {
        console.warn('[Northstar admin] numbers', err);
        // Fallback when edge function preflight/CORS fails on preview domains.
        return client
          .from('northstar_phone_numbers')
          .select('*')
          .order('e164', { ascending: true })
          .then(function (res2) {
            if (res2.error) throw res2.error;
            applyNumbers(res2.data || []);
          })
          .catch(function (err2) {
            console.warn('[Northstar admin] numbers fallback', err2);
            if (numTb) {
              numTb.innerHTML =
                '<tr><td colspan="5">Could not fetch phone numbers (edge + fallback failed).</td></tr>';
            }
          });
      });
  }

  function populatePhoneOptions(currentAgentId) {
    var sel = document.getElementById('tmPhone');
    if (!sel) return;
    var twField = document.getElementById('tmTwilio');
    var agentKey = String(currentAgentId || (twField && twField.value) || '').trim();
    var previous = String(sel.value || '').trim();
    var memberById = {};
    if (typeof NorthstarTeamRoster !== 'undefined' && NorthstarTeamRoster.getMembers) {
      NorthstarTeamRoster.getMembers().forEach(function (m) {
        var label = m.name || seatAgentKey(m);
        var pk = seatAgentKey(m);
        if (pk) memberById[pk] = label;
        if (m.twilioIdentity && m.twilioIdentity !== pk) memberById[m.twilioIdentity] = label;
      });
    }
    var opts = ['<option value="">Unassigned</option>'];
    numbersCache.forEach(function (n) {
      var assigned = n.assigned_agent_id ? String(n.assigned_agent_id) : '';
      var assignedProf = n.assigned_profile_id ? String(n.assigned_profile_id) : '';
      var suffix = '';
      var mine =
        !!agentKey &&
        ((assigned && assigned === agentKey) || (assignedProf && assignedProf === agentKey));
      var other = '';
      if (agentKey && !mine) {
        if (assignedProf && assignedProf !== agentKey) other = assignedProf;
        else if (assigned && assigned !== agentKey) other = assigned;
      } else if (!agentKey && (assignedProf || assigned)) {
        other = assignedProf || assigned;
      }
      if (other) {
        suffix = ' (assigned to ' + (memberById[other] || other) + ')';
      } else if (mine) {
        suffix = ' (currently assigned)';
      }
      opts.push('<option value="' + esc(n.e164) + '">' + esc(fmtPhone(n.e164)) + suffix + '</option>');
    });
    sel.innerHTML = opts.join('');
    var desired = '';
    if (previous && numbersCache.some(function (n) { return String(n.e164 || '').trim() === previous; })) {
      desired = previous;
    } else if (agentKey && numberByAgent[agentKey]) {
      desired = String(numberByAgent[agentKey].e164 || '').trim();
    }
    if (desired) sel.value = desired;
  }

  function numberByE164(e164) {
    var norm = String(e164 || '').trim();
    return numbersCache.filter(function (n) {
      return String(n.e164 || '').trim() === norm;
    })[0] || null;
  }

  function clearNumberForm() {
    ['numE164', 'numLabel', 'numType', 'numRoutes', 'numE911', 'numTwilioSid'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    var sms = document.getElementById('numSmsEnabled');
    if (sms) sms.checked = true;
    var sync = document.getElementById('numSyncTwilio');
    if (sync) sync.checked = true;
  }

  function invokeNumberUpsert(payload) {
    var client = getClient();
    if (!client) return Promise.reject(new Error('Supabase not configured'));
    return client.functions
      .invoke('admin-number-upsert', { body: payload })
      .then(function (res) {
        if (res.error) throw res.error;
        if (res.data && res.data.error) throw new Error(res.data.error);
        return res.data || {};
      });
  }

  window.saveNumberFromForm = function saveNumberFromForm() {
    var e164 = (document.getElementById('numE164') || {}).value || '';
    var label = (document.getElementById('numLabel') || {}).value || '';
    var type = (document.getElementById('numType') || {}).value || '';
    var routes = (document.getElementById('numRoutes') || {}).value || '';
    var e911 = (document.getElementById('numE911') || {}).value || '';
    var sid = (document.getElementById('numTwilioSid') || {}).value || '';
    var sms = !!((document.getElementById('numSmsEnabled') || {}).checked);
    var sync = !!((document.getElementById('numSyncTwilio') || {}).checked);
    if (!String(e164).trim()) {
      alert('Phone number is required.');
      return;
    }
    invokeNumberUpsert({
      e164: String(e164).trim(),
      label: String(label).trim(),
      numberType: String(type).trim() || 'Agent',
      routesTo: String(routes).trim(),
      e911Location: String(e911).trim(),
      twilioPhoneSid: String(sid).trim(),
      smsEnabled: sms,
      syncTwilio: sync,
    })
      .then(function (r) {
        return refreshNumbersInventory().then(function () {
          populatePhoneOptions('');
          clearNumberForm();
          var msg = 'Number saved.';
          if (r && r.synced) msg += ' Twilio webhooks synced.';
          if (r && r.syncError) msg += ' Twilio sync warning: ' + r.syncError;
          alert(msg);
        });
      })
      .catch(function (err) {
        alert('Save number failed: ' + (err && err.message ? err.message : String(err)));
      });
  };

  window.clearNumberForm = clearNumberForm;

  window.editNumber = function editNumber(e164) {
    var n = numberByE164(e164);
    if (!n) return;
    var eEl = document.getElementById('numE164');
    var lEl = document.getElementById('numLabel');
    var tEl = document.getElementById('numType');
    var rEl = document.getElementById('numRoutes');
    var pEl = document.getElementById('numE911');
    var sEl = document.getElementById('numTwilioSid');
    var smsEl = document.getElementById('numSmsEnabled');
    if (eEl) eEl.value = n.e164 || '';
    if (lEl) lEl.value = n.label || '';
    if (tEl) tEl.value = n.number_type || 'Agent';
    if (rEl) rEl.value = n.routes_to || '';
    if (pEl) pEl.value = n.e911_location || '';
    if (sEl) sEl.value = n.twilio_phone_sid || '';
    if (smsEl) smsEl.checked = !!n.sms_enabled;
    var nav = document.querySelector('.admin-nav button[data-adm="numbers"]');
    if (nav) nav.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  window.deleteNumber = function deleteNumber(e164) {
    if (!confirm('Delete this number from inventory?')) return;
    var client = getClient();
    if (!client) return;
    client
      .from('northstar_phone_numbers')
      .delete()
      .eq('e164', e164)
      .then(function (res) {
        if (res.error) throw res.error;
        return refreshNumbersInventory();
      })
      .then(function () {
        populatePhoneOptions('');
      })
      .catch(function (err) {
        alert('Delete failed: ' + (err && err.message ? err.message : String(err)));
      });
  };

  window.renderOverviewSeats = function renderOverviewSeats() {
    var grid = document.getElementById('overviewSeatsGrid');
    if (!grid || typeof NorthstarTeamRoster === 'undefined') return;
    var raw = NorthstarTeamRoster.getMembers();
    var members =
      typeof NorthstarTeamRoster.overlayCrmTodayStats === 'function'
        ? NorthstarTeamRoster.overlayCrmTodayStats(raw, null)
        : raw;
    var html = members.map(function (m) {
      var seatClass = seatWrapClass(m.status);
      var dotClass = dotWrapClass(m.status);
      var avExtra = m.bg && m.col ? ' style="background:' + esc(m.bg) + ';color:' + esc(m.col) + '"' : '';
      var pct = Math.min(100, Math.max(0, Number(m.pct) || 0));
      return (
        '<div class="' +
        esc(seatClass) +
        '">' +
        '<div class="seat-top">' +
        '<div class="av av-md"' +
        avExtra +
        '>' +
        esc(m.av) +
        '</div>' +
        '<div class="seat-info">' +
        '<div class="seat-name">' +
        esc(m.name) +
        ' · Ext ' +
        esc(m.ext) +
        '</div>' +
        '<div class="seat-role" style="display:flex;align-items:center;gap:5px">' +
        '<span class="dot ' +
        dotClass +
        '"></span> ' +
        esc(m.statusTxt) +
        '</div></div>' +
        '<button type="button" class="db blu" style="font-size:10px;padding:4px 8px;width:auto" onclick="adminGo(\'users\')">Edit</button>' +
        '</div>' +
        '<div class="seat-stats">' +
        '<div class="ss"><div class="ssv">' +
        (m.dials != null ? esc(String(m.dials)) : '—') +
        '</div><div class="ssl">Dials*</div></div>' +
        '<div class="ss"><div class="ssv">' +
        (m.appts != null ? esc(String(m.appts)) : '—') +
        '</div><div class="ssl">Appts*</div></div>' +
        '<div class="ss"><div class="ssv">' +
        pct +
        '%</div><div class="ssl">Perf</div></div>' +
        '<div class="ss"><div class="ssv">—</div><div class="ssl">QA</div></div>' +
        '</div>' +
        '<div class="seat-bar"><div class="seat-fill" style="width:' +
        pct +
        '%;background:#22c55e"></div></div>' +
        '</div>'
      );
    }).join('');
    if (!html) {
      html = '<div class="panel" style="grid-column:1/-1"><p class="hint">No seats found in <code>northstar_team_members</code>.</p></div>';
    }
    html +=
      '<button type="button" class="add-seat" onclick="adminGo(\'users\')">' +
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.2"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
      'Add / edit seats' +
      '</button>';
    grid.innerHTML = html;
  };

  window.renderTeamAdminTable = function renderTeamAdminTable() {
    var tb = document.getElementById('adminTeamBody');
    if (!tb || typeof NorthstarTeamRoster === 'undefined') return;
    var members = NorthstarTeamRoster.getMembers();
    tb.innerHTML = members
      .map(function (m) {
        return (
          '<tr data-id="' +
          esc(m.id) +
          '">' +
          '<td>' +
          esc(m.name) +
          '</td>' +
          '<td class="mono" style="font-size:11px">' +
          esc(m.loginEmail || '—') +
          '</td>' +
          '<td class="mono">' +
          esc(m.ext) +
          '</td>' +
          '<td>' +
          esc(m.role) +
          '</td>' +
          '<td class="mono" style="font-size:11px">' +
          esc(m.twilioIdentity || '') +
          '</td>' +
          '<td>' +
          esc(m.statusTxt) +
          '</td>' +
          '<td class="mono" style="font-size:11px">' +
          esc(numberByAgent[seatAgentKey(m)] ? fmtPhone(numberByAgent[seatAgentKey(m)].e164) : '—') +
          '</td>' +
          '<td>' +
          '<button type="button" class="db blu" style="font-size:10px;padding:4px 8px" data-team-edit="' +
          esc(m.id) +
          '">Edit</button> ' +
          '<button type="button" class="db" style="font-size:10px;padding:4px 8px" data-team-del="' +
          esc(m.id) +
          '">Remove</button>' +
          '</td></tr>'
        );
      })
      .join('');

    tb.onclick = function (ev) {
      var eid = ev.target.getAttribute && ev.target.getAttribute('data-team-edit');
      var did = ev.target.getAttribute && ev.target.getAttribute('data-team-del');
      if (eid) window.NorthstarTeamAdmin.edit(eid);
      if (did) window.NorthstarTeamAdmin.remove(did);
    };
  };

  function fmtWaitSec(sec) {
    var n = Number(sec) || 0;
    if (n <= 0) return '—';
    if (n < 60) return n + 's';
    var m = Math.floor(n / 60);
    var s = n % 60;
    return m + 'm' + (s ? ' ' + s + 's' : '');
  }

  function setLiveMetricEl(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function fmtDur(sec) {
    var n = Math.max(0, Number(sec) || 0);
    var m = Math.floor(n / 60);
    var s = n % 60;
    if (!m) return s + 's';
    return m + ':' + String(s).padStart(2, '0');
  }

  function startOfTodayIso() {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  function isBookedDisposition(v) {
    return /appointment|booked/i.test(String(v || ''));
  }

  function isAbandonDisposition(v) {
    return /abandon|missed queue/i.test(String(v || ''));
  }

  function fetchCrmAbandonEstimate(client) {
    var start = new Date();
    start.setHours(0, 0, 0, 0);
    return client
      .from('northstar_activities')
      .select('disposition')
      .gte('created_at', start.toISOString())
      .limit(4000)
      .then(function (res) {
        if (res.error) return null;
        var rows = res.data || [];
        if (!rows.length) return null;
        function isAbandon(d) {
          var t = String(d || '').toLowerCase();
          return t.indexOf('abandon') !== -1 || t.indexOf('missed queue') !== -1;
        }
        var ab = rows.filter(function (r) {
          return isAbandon(r.disposition);
        }).length;
        return Math.round((ab / rows.length) * 1000) / 10;
      });
  }

  window.refreshLiveTelephonyMetrics = function refreshLiveTelephonyMetrics() {
    var client =
      typeof NorthstarSupabase !== 'undefined' && NorthstarSupabase.getClient ? NorthstarSupabase.getClient() : null;
    var updatedEl = document.getElementById('liveMetricUpdated');
    if (!client) {
      setLiveMetricEl('liveMetricActive', '—');
      setLiveMetricEl('liveMetricQueue', '—');
      setLiveMetricEl('liveMetricWait', '—');
      setLiveMetricEl('liveMetricAbandon', '—');
      if (updatedEl) updatedEl.textContent = 'Add Supabase meta tags on this page to stream live metrics.';
      return Promise.resolve();
    }

    var pActive = client
      .from('northstar_active_calls')
      .select('id', { count: 'exact', head: true })
      .is('ended_at', null);

    var pCarrier = client.from('northstar_carrier_metrics').select('*').eq('id', 'default').maybeSingle();

    return Promise.all([pActive, pCarrier, fetchCrmAbandonEstimate(client)]).then(function (parts) {
      var activeRes = parts[0];
      var carrierRes = parts[1];
      var crmAbandon = parts[2];

      var activeCount = typeof activeRes.count === 'number' ? activeRes.count : 0;
      if (activeRes.error) {
        console.warn('[Northstar admin] active calls count', activeRes.error);
        activeCount = '—';
      }

      setLiveMetricEl('liveMetricActive', String(activeCount));

      var carrier = carrierRes && carrierRes.data ? carrierRes.data : null;
      if (carrierRes && carrierRes.error) {
        console.warn('[Northstar admin] carrier metrics', carrierRes.error);
      }

      var qWait = carrier && carrier.queue_waiting != null ? carrier.queue_waiting : 0;
      var longest = carrier && carrier.longest_wait_sec != null ? carrier.longest_wait_sec : 0;
      var carAb = carrier && carrier.abandon_pct != null ? Number(carrier.abandon_pct) : 0;

      setLiveMetricEl('liveMetricQueue', String(qWait));
      setLiveMetricEl('liveMetricWait', fmtWaitSec(longest));

      var abandonDisp =
        carAb > 0 ? Math.round(carAb * 10) / 10 + '%' : crmAbandon != null ? Math.round(crmAbandon * 10) / 10 + '%*' : '0%';
      setLiveMetricEl('liveMetricAbandon', abandonDisp);

      if (updatedEl) {
        var ts = carrier && carrier.updated_at ? new Date(carrier.updated_at).toLocaleString() : '';
        updatedEl.textContent =
          'Refreshed ' +
          new Date().toLocaleTimeString() +
          (carrier && carrier.updated_at ? ' · Carrier KPIs ' + ts : '') +
          (abandonDisp.indexOf('*') !== -1 ? ' · *Abandon estimated from CRM when carrier KPI is 0.' : '');
      }
    });
  };

  window.refreshOverviewMetrics = function refreshOverviewMetrics() {
    var client =
      typeof NorthstarSupabase !== 'undefined' && NorthstarSupabase.getClient ? NorthstarSupabase.getClient() : null;
    if (!client) {
      setText('ovLegsToday', '—');
      setText('ovAnsweredToday', '—');
      setText('ovBookedToday', '—');
      setText('ovRecordingsToday', '—');
      setText('ovConnectRate', 'Connect rate —');
      return Promise.resolve();
    }
    var startIso = startOfTodayIso();
    var legsQ = client
      .from('northstar_call_legs')
      .select('duration_sec, recording_url')
      .gte('started_at', startIso)
      .limit(5000);
    var actsQ = client
      .from('northstar_activities')
      .select('disposition')
      .gte('created_at', startIso)
      .limit(5000);
    return Promise.all([legsQ, actsQ]).then(function (parts) {
      var legsRes = parts[0];
      var actsRes = parts[1];
      var legs = legsRes && legsRes.data ? legsRes.data : [];
      var acts = actsRes && actsRes.data ? actsRes.data : [];
      if (legsRes && legsRes.error) console.warn('[Northstar admin] overview legs', legsRes.error);
      if (actsRes && actsRes.error) console.warn('[Northstar admin] overview activities', actsRes.error);

      var totalLegs = legs.length;
      var answered = legs.filter(function (r) {
        return Number(r.duration_sec) > 0;
      }).length;
      var recordings = legs.filter(function (r) {
        return !!(r.recording_url && String(r.recording_url).trim());
      }).length;
      var booked = acts.filter(function (r) {
        return isBookedDisposition(r.disposition);
      }).length;

      setText('ovLegsToday', String(totalLegs));
      setText('ovAnsweredToday', String(answered));
      setText('ovBookedToday', String(booked));
      setText('ovRecordingsToday', String(recordings));
      setText(
        'ovConnectRate',
        'Connect rate ' + (totalLegs ? (Math.round((answered / totalLegs) * 1000) / 10).toFixed(1) : '0.0') + '%'
      );
      setText('ovBookedNote', 'Live from northstar_activities');
    });
  };

  window.refreshOrgCallLog = function refreshOrgCallLog() {
    var tb = document.getElementById('adminCallRows');
    if (!tb) return Promise.resolve();
    var client =
      typeof NorthstarSupabase !== 'undefined' && NorthstarSupabase.getClient ? NorthstarSupabase.getClient() : null;
    if (!client) {
      tb.innerHTML = '<tr><td colspan="8" style="color:#6b7280;font-size:12px">Supabase not configured.</td></tr>';
      return Promise.resolve();
    }
    var startIso = startOfTodayIso();
    return client
      .from('northstar_call_legs')
      .select('*')
      .gte('started_at', startIso)
      .order('started_at', { ascending: false })
      .limit(120)
      .then(function (res) {
        if (res.error) throw res.error;
        var rows = res.data || [];
        tb.innerHTML =
          rows
            .map(function (r) {
              var disp = String(r.disposition || 'Open');
              var pill = 'pill-b';
              if (isBookedDisposition(disp)) pill = 'pill-g';
              else if (isAbandonDisposition(disp)) pill = 'pill-a';
              else if (/not interested|lost/i.test(disp)) pill = 'pill-r';
              return (
                '<tr>' +
                '<td>' +
                esc(new Date(r.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) +
                '</td>' +
                '<td>' +
                esc(r.direction || '—') +
                '</td>' +
                '<td>' +
                esc(r.agent_name || 'Queue') +
                '</td>' +
                '<td>' +
                esc(r.party_display || '—') +
                '</td>' +
                '<td>' +
                esc(r.queue_name || '—') +
                '</td>' +
                '<td>' +
                esc(fmtDur(r.duration_sec)) +
                '</td>' +
                '<td><span class="pill ' +
                pill +
                '">' +
                esc(disp) +
                '</span></td>' +
                '<td>' +
                (r.recording_url
                  ? '<a href="' + esc(r.recording_url) + '" target="_blank" rel="noopener" style="color:#2563eb">▶</a>'
                  : '—') +
                '</td>' +
                '</tr>'
              );
            })
            .join('') ||
          '<tr><td colspan="8" style="color:#6b7280;font-size:12px">No call legs logged yet today.</td></tr>';
      })
      .catch(function (err) {
        console.warn('[Northstar admin] call log', err);
        tb.innerHTML = '<tr><td colspan="8" style="color:#6b7280;font-size:12px">Call log unavailable.</td></tr>';
      });
  };

  window.refreshAnalyticsMetrics = function refreshAnalyticsMetrics() {
    var client =
      typeof NorthstarSupabase !== 'undefined' && NorthstarSupabase.getClient ? NorthstarSupabase.getClient() : null;
    if (!client) {
      setText('anServiceLevel', '—');
      setText('anAvgAnswer', '—');
      setText('anAbandonRate', '—');
      setText('anOccupancy', '—');
      return Promise.resolve();
    }
    var startIso = startOfTodayIso();
    return client
      .from('northstar_call_legs')
      .select('direction,queue_wait_sec,duration_sec,agent_id,disposition')
      .gte('started_at', startIso)
      .limit(5000)
      .then(function (res) {
        if (res.error) throw res.error;
        var rows = res.data || [];
        var inbound = rows.filter(function (r) {
          return r.direction === 'inbound';
        });
        var answeredInbound = inbound.filter(function (r) {
          return Number(r.duration_sec) > 0;
        });
        var withinSla = answeredInbound.filter(function (r) {
          return Number(r.queue_wait_sec) <= 60;
        });
        var avgAnswer = answeredInbound.length
          ? Math.round(
              answeredInbound.reduce(function (a, r) {
                return a + (Number(r.queue_wait_sec) || 0);
              }, 0) / answeredInbound.length
            )
          : 0;
        var abandons = inbound.filter(function (r) {
          return isAbandonDisposition(r.disposition) || Number(r.duration_sec) <= 0;
        }).length;
        var distinctAgents = {};
        rows.forEach(function (r) {
          if (r.agent_id) distinctAgents[r.agent_id] = 1;
        });
        var agentCount = Math.max(1, Object.keys(distinctAgents).length);
        var occupancy = rows.length ? rows.length / agentCount : 0;

        var service = inbound.length ? (withinSla.length / inbound.length) * 100 : 0;
        var abandon = inbound.length ? (abandons / inbound.length) * 100 : 0;

        setText('anServiceLevel', (Math.round(service * 10) / 10).toFixed(1) + '%');
        setText('anAvgAnswer', fmtWaitSec(avgAnswer));
        setText('anAbandonRate', (Math.round(abandon * 10) / 10).toFixed(1) + '%');
        setText('anOccupancy', (Math.round(occupancy * 10) / 10).toFixed(1));
      })
      .catch(function (err) {
        console.warn('[Northstar admin] analytics', err);
      });
  };

  function refreshAllDashboardMetrics() {
    return Promise.all([
      window.refreshOverviewMetrics(),
      window.refreshOrgCallLog(),
      window.refreshLiveTelephonyMetrics(),
      window.refreshAnalyticsMetrics(),
    ]);
  }

  function ensureLiveOpsRealtime() {
    if (liveOpsRealtimeStarted) return;
    var client =
      typeof NorthstarSupabase !== 'undefined' && NorthstarSupabase.getClient ? NorthstarSupabase.getClient() : null;
    if (!client) return;
    liveOpsRealtimeStarted = true;

    var ch = client.channel('northstar-live-ops');
    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'northstar_active_calls' },
      function () {
        window.refreshLiveTelephonyMetrics();
      }
    );
    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'northstar_carrier_metrics' },
      function () {
        window.refreshLiveTelephonyMetrics();
      }
    );
    ch.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'northstar_activities' },
      function () {
        window.refreshLiveTelephonyMetrics();
        window.refreshOverviewMetrics();
      }
    );
    ch.subscribe();

    setInterval(function () {
      window.refreshLiveTelephonyMetrics();
    }, 12000);

    window.refreshLiveTelephonyMetrics();
  }

  function ensureMetricsRealtime() {
    if (metricsRealtimeStarted) return;
    var client =
      typeof NorthstarSupabase !== 'undefined' && NorthstarSupabase.getClient ? NorthstarSupabase.getClient() : null;
    if (!client) return;
    metricsRealtimeStarted = true;
    var ch = client.channel('northstar-dashboard-metrics');
    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'northstar_call_legs' },
      function () {
        refreshAllDashboardMetrics();
      }
    );
    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'northstar_activities' },
      function () {
        refreshAllDashboardMetrics();
      }
    );
    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'northstar_phone_numbers' },
      function () {
        refreshNumbersInventory().then(function () {
          renderTeamAdminTable();
          populatePhoneOptions('');
        });
      }
    );
    ch.subscribe();

    setInterval(function () {
      refreshAllDashboardMetrics();
    }, 15000);
  }

  function provisionEmployeeAccount(opts) {
    var client = getClient();
    if (!client) return Promise.reject(new Error('Supabase not configured'));
    return client.functions
      .invoke('admin-employee-upsert', {
        body: {
          email: opts.email || '',
          password: opts.password || '',
          name: opts.name,
          extension: opts.extension,
          twilioIdentity: opts.twilioIdentity,
          smsNumberE164: opts.smsNumberE164 || '',
          voiceEdge: opts.voiceEdge || 'auto',
          notifyUser: !!opts.notifyUser,
        },
      })
      .then(function (res) {
        if (res.error) throw res.error;
        if (res.data && res.data.error) throw new Error(res.data.error);
        return res.data || {};
      });
  }

  function ensureCrmRealtime() {
    if (crmRealtimeStarted) return;
    var client =
      typeof NorthstarSupabase !== 'undefined' && NorthstarSupabase.getClient ? NorthstarSupabase.getClient() : null;
    if (!client) return;
    crmRealtimeStarted = true;
    var ch = client.channel('northstar-crm-admin');
    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'northstar_contacts' },
      function () {
        if (typeof NorthstarCRM !== 'undefined' && NorthstarCRM.syncFromRemote) {
          NorthstarCRM.syncFromRemote()
            .then(function () {
              pumpCrmPaint();
            })
            .catch(function (err) {
              console.error('[Northstar admin] CRM contacts realtime resync', err);
              pumpCrmPaint();
            });
        } else {
          pumpCrmPaint();
        }
      }
    );
    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'northstar_activities' },
      function () {
        if (typeof NorthstarCRM !== 'undefined' && NorthstarCRM.syncFromRemote) {
          NorthstarCRM.syncFromRemote()
            .then(function () {
              pumpCrmPaint();
            })
            .catch(function (err) {
              console.error('[Northstar admin] CRM activities realtime resync', err);
              pumpCrmPaint();
            });
        } else {
          pumpCrmPaint();
        }
      }
    );
    ch.subscribe();
  }

  window.NorthstarTeamAdmin = {
    edit: function (id) {
      var list = NorthstarTeamRoster.getMembers();
      var m = list.filter(function (x) {
        return x.id === id;
      })[0];
      if (!m) return;
      teamEditId = id;
      populatePhoneOptions(seatAgentKey(m));
      var nameEl = document.getElementById('tmName');
      var extEl = document.getElementById('tmExt');
      var roleEl = document.getElementById('tmRole');
      var twEl = document.getElementById('tmTwilio');
      var voiceEdgeEl = document.getElementById('tmVoiceEdge');
      var presEl = document.getElementById('tmPres');
      var emailEl = document.getElementById('tmEmail');
      var passEl = document.getElementById('tmPassword');
      var phoneEl = document.getElementById('tmPhone');
      var notifyEl = document.getElementById('tmNotifyUser');
      if (nameEl) nameEl.value = m.name;
      if (extEl) extEl.value = m.ext;
      if (roleEl) roleEl.value = m.role || 'Agent';
      if (twEl) twEl.value = m.twilioIdentity || '';
      if (voiceEdgeEl) {
        if (m.profileId && typeof getClient === 'function' && getClient()) {
          getClient()
            .from('northstar_profiles')
            .select('voice_edge')
            .eq('id', m.profileId)
            .maybeSingle()
            .then(function (res) {
              voiceEdgeEl.value = (res.data && res.data.voice_edge) || 'auto';
            })
            .catch(function () {
              voiceEdgeEl.value = 'auto';
            });
        } else {
          voiceEdgeEl.value = 'auto';
        }
      }
      if (presEl) presEl.value = m.status || 'g';
      if (emailEl) emailEl.value = m.loginEmail || '';
      if (passEl) passEl.value = '';
      if (phoneEl) {
        var assigned = numberByAgent[seatAgentKey(m)];
        phoneEl.value = assigned ? assigned.e164 : '';
      }
      var dialsEl = document.getElementById('tmDials');
      var apptsEl = document.getElementById('tmAppts');
      var pctEl = document.getElementById('tmPct');
      if (dialsEl) dialsEl.value = m.dials != null ? String(m.dials) : '';
      if (apptsEl) apptsEl.value = m.appts != null ? String(m.appts) : '';
      if (pctEl) pctEl.value = m.pct != null ? String(m.pct) : '';
    },
    clearForm: function (opts) {
      var skipStatus = opts && opts.skipStatus;
      teamEditId = null;
      if (!skipStatus) setTeamSaveFeedback('', 'info');
      ['tmEmail', 'tmPassword', 'tmName', 'tmExt', 'tmTwilio', 'tmDials', 'tmAppts', 'tmPct'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
      });
      populatePhoneOptions('');
      var phoneEl = document.getElementById('tmPhone');
      if (phoneEl) phoneEl.value = '';
      var roleEl = document.getElementById('tmRole');
      if (roleEl) roleEl.value = 'Agent';
      var presEl = document.getElementById('tmPres');
      if (presEl) presEl.value = 'g';
      var notifyEl = document.getElementById('tmNotifyUser');
      if (notifyEl) notifyEl.checked = true;
    },
    saveForm: function () {
      var emailEl = document.getElementById('tmEmail');
      var passEl = document.getElementById('tmPassword');
      var notifyEl = document.getElementById('tmNotifyUser');
      var nameEl = document.getElementById('tmName');
      var extEl = document.getElementById('tmExt');
      var roleEl = document.getElementById('tmRole');
      var twEl = document.getElementById('tmTwilio');
      var voiceEdgeEl = document.getElementById('tmVoiceEdge');
      var phoneEl = document.getElementById('tmPhone');
      var presEl = document.getElementById('tmPres');
      var email = emailEl ? emailEl.value.trim() : '';
      var password = passEl ? passEl.value.trim() : '';
      var name = nameEl ? nameEl.value.trim() : '';
      var ext = extEl ? extEl.value.trim() : '';
      var role = roleEl ? roleEl.value : 'Agent';
      var tw = twEl ? twEl.value.trim() : '';
      var voiceEdge = voiceEdgeEl ? voiceEdgeEl.value : 'auto';
      var smsNumber = phoneEl ? phoneEl.value.trim() : '';
      var notifyUser = notifyEl ? !!notifyEl.checked : true;
      var st = presEl ? presEl.value : 'g';
      var dialsIn = document.getElementById('tmDials');
      var apptsIn = document.getElementById('tmAppts');
      var pctIn = document.getElementById('tmPct');
      setTeamSaveFeedback('', 'info');
      if (!name || !ext) {
        setTeamSaveFeedback('Name and extension are required.', 'error');
        return;
      }
      if (!tw) tw = 'agent_' + ext.replace(/\D/g, '');
      if (!email && !teamEditId) {
        setTeamSaveFeedback('Email is required so Supabase can create the employee login.', 'error');
        return;
      }
      var roster = typeof NorthstarTeamRoster !== 'undefined' && NorthstarTeamRoster.getMembers ? NorthstarTeamRoster.getMembers() : [];
      var extDup = roster.some(function (m) {
        return String(m.ext || '') === String(ext) && (!teamEditId || m.id !== teamEditId);
      });
      var twDup = roster.some(function (m) {
        return String(m.twilioIdentity || '').trim() === String(tw).trim() && (!teamEditId || m.id !== teamEditId);
      });
      if (extDup) {
        setTeamSaveFeedback('That extension is already assigned to another seat. Choose a unique extension.', 'error');
        return;
      }
      if (twDup) {
        setTeamSaveFeedback(
          'That Twilio identity is already used by another seat. Each rep needs a unique identity (e.g. agent_julio).',
          'error'
        );
        return;
      }
      var existing = teamEditId
        ? NorthstarTeamRoster.getMembers().filter(function (x) {
            return x.id === teamEditId;
          })[0]
        : null;
      var id =
        teamEditId ||
        'seat_' +
        ext.replace(/\D/g, '') +
        '_' +
        Date.now().toString(36);
      var sortOrder =
        existing && existing.sortOrder != null
          ? existing.sortOrder
          : NorthstarTeamRoster.getMembers().reduce(function (acc, x) {
              return Math.max(acc, x.sortOrder != null ? x.sortOrder : 0);
            }, 0) + 1;

      function parseOptNum(el, fallback) {
        if (!el || !String(el.value).trim()) return fallback;
        var n = parseInt(el.value, 10);
        return isNaN(n) ? fallback : n;
      }
      function parseOptPct(el, fallback) {
        if (!el || !String(el.value).trim()) return fallback;
        var n = parseInt(el.value, 10);
        if (isNaN(n)) return fallback;
        return Math.min(100, Math.max(0, n));
      }
      var dialsVal = parseOptNum(dialsIn, existing ? existing.dials : 0);
      var apptsVal = parseOptNum(apptsIn, existing ? existing.appts : 0);
      var pctVal = parseOptPct(pctIn, existing ? existing.pct : 0);

      var payload = {
        id: id,
        av: NorthstarTeamRoster.initials(name),
        name: name,
        ext: ext,
        role: role,
        twilioIdentity: tw,
        status: st,
        statusTxt: PRES_LABELS[st] || 'Available',
        dials: dialsVal,
        appts: apptsVal,
        pct: pctVal,
        bg: existing ? existing.bg : null,
        col: existing ? existing.col : null,
        sortOrder: sortOrder,
        loginEmail: email,
        profileId: existing && existing.profileId ? existing.profileId : null,
      };

      setTeamSaveBusy(true);
      setTeamSaveFeedback('Saving employee…', 'info');
      NorthstarTeamRoster.upsertMember(payload)
        .then(function () {
          return provisionEmployeeAccount({
            email: email,
            password: password,
            name: name,
            extension: ext,
            twilioIdentity: tw,
            smsNumberE164: smsNumber,
            voiceEdge: voiceEdge,
            notifyUser: notifyUser,
          });
        })
        .then(function (provisionRes) {
          return (typeof NorthstarTeamRoster !== 'undefined' && NorthstarTeamRoster.refresh
            ? NorthstarTeamRoster.refresh()
            : Promise.resolve()
          ).then(function () {
            return refreshNumbersInventory();
          }).then(function () {
            var notes = [];
            if (provisionRes && provisionRes.createdUser) notes.push('New login created.');
            if (provisionRes && provisionRes.notified) notes.push('Email notification sent.');
            if (provisionRes && provisionRes.notifyWarning) notes.push('Email warning: ' + provisionRes.notifyWarning);
            var msg = 'Employee saved.' + (notes.length ? ' ' + notes.join(' ') : '');
            window.NorthstarTeamAdmin.clearForm({ skipStatus: true });
            renderTeamAdminTable();
            renderOverviewSeats();
            setTeamSaveFeedback(msg, 'ok');
            try {
              alert(msg);
            } catch (_e) {}
          });
        })
        .catch(function (err) {
          var msg = 'Save failed: ' + (err && err.message ? err.message : String(err));
          setTeamSaveFeedback(msg, 'error');
          try {
            alert(msg);
          } catch (_e) {}
        })
        .then(function () {
          setTeamSaveBusy(false);
        });
    },
    remove: function (id) {
      if (!confirm('Remove this user from the directory? Agents can no longer transfer to them.')) return;
      NorthstarTeamRoster.deleteMember(id)
        .then(function () {
          renderTeamAdminTable();
          renderOverviewSeats();
        })
        .catch(function (err) {
          alert('Remove failed: ' + (err && err.message ? err.message : String(err)));
        });
    },
  };

  function adminGo(id) {
    document.querySelectorAll('.admin-nav button[data-adm]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-adm') === id);
    });
    document.querySelectorAll('.admin-section').forEach(function (s) {
      s.classList.toggle('on', s.id === 'adm-' + id);
    });
    if (id === 'crm') refreshCrmView();
    if (id === 'integrations') hydrateIntegrationHints();
    if (id === 'users') {
      renderTeamAdminTable();
      populatePhoneOptions('');
    }
    if (id === 'numbers') refreshNumbersInventory();
    if (id === 'overview') {
      renderOverviewSeats();
      window.refreshOverviewMetrics();
      window.refreshOrgCallLog();
    }
    if (id === 'telephony' && typeof window.refreshLiveTelephonyMetrics === 'function') window.refreshLiveTelephonyMetrics();
    if (id === 'analytics') window.refreshAnalyticsMetrics();
  }

  function hydrateIntegrationHints() {
    var el = document.getElementById('webhookEp');
    if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';
    el.placeholder = '/api/webhooks/' + pseudoId();
    function pseudoId() {
      return Math.random().toString(36).slice(2, 10);
    }
  }

  window.adminGo = adminGo;

  /** Re-read local CRM store and repaint; repeat on next frames to avoid Safari/static DOM glitches. */
  function pumpCrmPaint() {
    refreshCrmView();
    if (typeof window.renderOverviewSeats === 'function') window.renderOverviewSeats();
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(function () {
        refreshCrmView();
        if (typeof window.renderOverviewSeats === 'function') window.renderOverviewSeats();
      });
    }
    setTimeout(function () {
      refreshCrmView();
      if (typeof window.renderOverviewSeats === 'function') window.renderOverviewSeats();
    }, 60);
  }

  window.syncCrmFromDb = async function syncCrmFromDb() {
    if (typeof NorthstarCRM === 'undefined' || !NorthstarCRM.syncFromRemote) {
      alert('CRM sync is not available.');
      return;
    }
    try {
      var r = await NorthstarCRM.syncFromRemote();
      if (r && r.synced === false && r.reason === 'supabase-not-configured') {
        alert('Supabase is not configured; nothing to sync.');
      }
    } catch (e) {
      var msg = e && e.message ? e.message : String(e);
      alert('Sync failed: ' + msg);
    } finally {
      pumpCrmPaint();
    }
  };

  /**
   * Deletes northstar_contacts not referenced by any active daily list (northstar_call_lists.status = active).
   * Archived lists still keep list_items rows; counting all items made purge a no-op for “list archived only.”
   */
  window.purgeOrphanCrmFromDb = async function purgeOrphanCrmFromDb() {
    var client = getClient();
    if (!client) {
      alert('Supabase client unavailable.');
      return;
    }
    var ok = confirm(
      'Delete CRM contacts that are not on any active daily call list?\n\n' +
        'Contacts only tied to archived lists (or not on any list) are removed. ' +
        'Contacts on at least one active list are kept.'
    );
    if (!ok) return;
    var page = 1000;

    var activeListIds = [];
    var from = 0;
    while (true) {
      var listsRes = await client
        .from('northstar_call_lists')
        .select('id')
        .eq('status', 'active')
        .order('id', { ascending: true })
        .range(from, from + page - 1);
      if (listsRes.error) {
        alert('Could not read call lists: ' + (listsRes.error.message || String(listsRes.error)));
        return;
      }
      var lrows = listsRes.data || [];
      lrows.forEach(function (row) {
        if (row && row.id) activeListIds.push(String(row.id));
      });
      if (lrows.length < page) break;
      from += page;
    }

    var linked = {};
    var listChunk = 40;
    for (var li = 0; li < activeListIds.length; li += listChunk) {
      var idChunk = activeListIds.slice(li, li + listChunk);
      var iFrom = 0;
      while (true) {
        var itemsRes = await client
          .from('northstar_call_list_items')
          .select('contact_id')
          .in('list_id', idChunk)
          .not('contact_id', 'is', null)
          .order('id', { ascending: true })
          .range(iFrom, iFrom + page - 1);
        if (itemsRes.error) {
          alert('Could not read call list items: ' + (itemsRes.error.message || String(itemsRes.error)));
          return;
        }
        var rows = itemsRes.data || [];
        rows.forEach(function (row) {
          var cid = row && row.contact_id ? String(row.contact_id).trim() : '';
          if (cid) linked[cid] = true;
        });
        if (rows.length < page) break;
        iFrom += page;
      }
    }

    var contactIds = [];
    from = 0;
    while (true) {
      var cRes = await client
        .from('northstar_contacts')
        .select('id')
        .order('id', { ascending: true })
        .range(from, from + page - 1);
      if (cRes.error) {
        alert('Could not read contacts: ' + (cRes.error.message || String(cRes.error)));
        return;
      }
      var crows = cRes.data || [];
      crows.forEach(function (row) {
        if (row && row.id) contactIds.push(String(row.id));
      });
      if (crows.length < page) break;
      from += page;
    }

    var orphans = contactIds.filter(function (id) {
      return !linked[id];
    });
    if (!orphans.length) {
      alert(
        'No contacts qualify for removal.\n\n' +
          'Every CRM row is still referenced by at least one active daily list. ' +
          'If old leads remain because their list is still active, archive or delete that list first, then run this again.'
      );
      return;
    }

    var warn =
      activeListIds.length === 0
        ? 'WARNING: There are no active daily lists. This will remove ALL ' +
          orphans.length +
          ' CRM contact(s).\n\nContinue?'
        : 'Remove ' + orphans.length + ' contact(s) from the database (not on any active list)?';
    var ok2 = confirm(warn);
    if (!ok2) return;
    var chunk = 200;
    try {
      for (var i = 0; i < orphans.length; i += chunk) {
        var slice = orphans.slice(i, i + chunk);
        if (typeof NorthstarCRM !== 'undefined' && typeof NorthstarCRM.removeContactsLocal === 'function') {
          NorthstarCRM.removeContactsLocal(slice);
          pumpCrmPaint();
        }
        var da = await client.from('northstar_activities').delete().in('contact_id', slice);
        if (da.error) throw da.error;
        var dc = await client.from('northstar_contacts').delete().in('id', slice);
        if (dc.error) throw dc.error;
      }
      if (typeof syncCrmFromDb === 'function') await syncCrmFromDb();
      else pumpCrmPaint();
      alert('Removed ' + orphans.length + ' contact(s) not linked to any active daily list.');
    } catch (e) {
      var msg = e && e.message ? e.message : String(e);
      alert('Purge failed: ' + msg + '\n\nIf this mentions RLS or policy, apply the latest Supabase migration (northstar_crm_delete_policies) and retry.');
      pumpCrmPaint();
    }
  };

  window.refreshCrmView = function refreshCrmView() {
    if (typeof NorthstarCRM === 'undefined' || !NorthstarCRM.listContacts) return;
    var crmEl = document.getElementById('crmContacts');
    var actEl = document.getElementById('crmActivities');
    var stEl = document.getElementById('crmStages');
    if (!crmEl || !actEl || !stEl) return;
    var contacts = NorthstarCRM.listContacts();
    if (typeof crmEl.replaceChildren === 'function') crmEl.replaceChildren();
    else crmEl.textContent = '';
    if (typeof actEl.replaceChildren === 'function') actEl.replaceChildren();
    else actEl.textContent = '';
    crmEl.innerHTML =
      contacts
        .map(function (c) {
          return (
            '<div class="crm-row"><h4>' +
            esc(c.business) +
            '</h4><p>' +
            esc(c.name) +
            ' · ' +
            esc(c.phone) +
            '</p><p><span class="pill pill-b">' +
            esc(c.stage) +
            '</span> ' +
            (c.lastOutcome ? '<span class="pill pill-gr">' + esc(c.lastOutcome) + '</span>' : '') +
            (c.assignedAgentName
              ? ' <span class="pill pill-g">Owner: ' + esc(c.assignedAgentName) + '</span>'
              : c.assignedAgentId
              ? ' <span class="pill pill-g">Owner: ' + esc(c.assignedAgentId) + '</span>'
              : ' <span class="pill pill-a">Unassigned</span>') +
            '</p></div>'
          );
        })
        .join('') || '<p style="font-size:12px;color:#6b7280">No contacts yet.</p>';

    var acts = NorthstarCRM.listActivities(120);
    actEl.innerHTML =
      acts
        .map(function (a) {
          return (
            '<div class="act-row"><strong>' +
            esc(a.createdAt) +
            '</strong><br/>' +
            esc(a.agentName) +
            ' · ' +
            esc(a.business) +
            '<br/><span style="color:#6b7280">' +
            esc(a.disposition || '') +
            (a.notes ? ' — ' + esc(a.notes).slice(0, 140) : '') +
            '</span></div>'
          );
        })
        .join('') || '<p style="font-size:12px;color:#6b7280">No activities.</p>';

    var stages = NorthstarCRM.load().pipelines.stages || [];
    stEl.innerHTML = stages
      .map(function (s) {
        return '<li>' + esc(s) + '</li>';
      })
      .join('');
  };

  function assignableReps() {
    if (typeof NorthstarTeamRoster === 'undefined' || !NorthstarTeamRoster.getMembers) return [];
    return NorthstarTeamRoster.getMembers().filter(function (m) {
      return String(m.role || '').toLowerCase().indexOf('agent') !== -1 && !!seatAgentKey(m);
    });
  }

  function readLegacyLocalAssignRepId() {
    try {
      return String(localStorage.getItem(LEAD_ASSIGN_REP_STORAGE_KEY) || '').trim();
    } catch (_e) {
      return '';
    }
  }

  function clearLegacyLocalAssignRepId() {
    try {
      localStorage.removeItem(LEAD_ASSIGN_REP_STORAGE_KEY);
    } catch (_e) {}
  }

  function readPreferredLeadAssignRepId() {
    var id = adminUiPrefsCache && adminUiPrefsCache.leadImportAssignRepId;
    return id ? String(id).trim() : '';
  }

  async function flushAdminUiPrefsToRemote() {
    var client = getClient();
    var user =
      typeof NorthstarAdminAuth !== 'undefined' && NorthstarAdminAuth.getUser
        ? NorthstarAdminAuth.getUser()
        : null;
    if (!client || !user || !user.id) return;
    var prefs = adminUiPrefsCache && typeof adminUiPrefsCache === 'object' ? adminUiPrefsCache : {};
    var res = await client
      .from('northstar_admin_ui_preferences')
      .upsert(
        {
          user_id: user.id,
          prefs: prefs,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );
    if (res.error) throw res.error;
  }

  /**
   * Load prefs from Supabase for the signed-in admin. Falls back to legacy localStorage once, then migrates.
   */
  async function syncAdminUiPrefsFromRemote() {
    adminUiPrefsCache = {};
    var client = getClient();
    var user =
      typeof NorthstarAdminAuth !== 'undefined' && NorthstarAdminAuth.getUser
        ? NorthstarAdminAuth.getUser()
        : null;
    if (!client || !user || !user.id) {
      var legOnly = readLegacyLocalAssignRepId();
      adminUiPrefsCache = legOnly ? { leadImportAssignRepId: legOnly } : {};
      return;
    }
    var res = await client
      .from('northstar_admin_ui_preferences')
      .select('prefs')
      .eq('user_id', user.id)
      .maybeSingle();
    if (res.error) {
      console.warn('[Northstar admin] Could not load UI preferences (apply migration 20260428120000):', res.error.message || res.error);
      var fb = readLegacyLocalAssignRepId();
      adminUiPrefsCache = fb ? { leadImportAssignRepId: fb } : {};
      return;
    }
    var p = res.data && res.data.prefs;
    adminUiPrefsCache =
      p && typeof p === 'object' && !Array.isArray(p) ? JSON.parse(JSON.stringify(p)) : {};
    var legacy = readLegacyLocalAssignRepId();
    if (legacy && !readPreferredLeadAssignRepId()) {
      adminUiPrefsCache.leadImportAssignRepId = legacy;
      clearLegacyLocalAssignRepId();
      try {
        await flushAdminUiPrefsToRemote();
      } catch (e) {
        console.warn('[Northstar admin] UI prefs migration save failed', e);
      }
    }
  }

  function schedulePersistLeadAssignRepId(repId) {
    adminUiPrefsCache = Object.assign({}, adminUiPrefsCache || {}, {
      leadImportAssignRepId: repId ? String(repId).trim() : '',
    });
    try {
      if (repId) localStorage.setItem(LEAD_ASSIGN_REP_STORAGE_KEY, String(repId).trim());
      else localStorage.removeItem(LEAD_ASSIGN_REP_STORAGE_KEY);
    } catch (_e) {}
    flushAdminUiPrefsToRemote().catch(function (e) {
      console.warn('[Northstar admin] UI prefs save failed (selection kept locally until next sync)', e);
    });
  }

  function applyPersistedLeadAssignRep(sel) {
    if (!sel) return;
    var saved = readPreferredLeadAssignRepId();
    if (!saved) return;
    var opts = sel.options;
    for (var i = 0; i < opts.length; i++) {
      if (opts[i].value === saved) {
        sel.selectedIndex = i;
        return;
      }
    }
    adminUiPrefsCache.leadImportAssignRepId = '';
    schedulePersistLeadAssignRepId('');
  }

  function populateLeadAssignReps() {
    var sel = document.getElementById('leadAssignRep');
    if (!sel) return;
    var reps = assignableReps();
    sel.innerHTML =
      '<option value="">Assign to rep…</option>' +
      reps
        .map(function (r) {
          var id = seatAgentKey(r);
          return '<option value="' + esc(id) + '">' + esc(r.name) + ' (' + esc(id) + ')</option>';
        })
        .join('');
    applyPersistedLeadAssignRep(sel);
    if (!leadAssignRepChangeBound) {
      leadAssignRepChangeBound = true;
      sel.addEventListener('change', function () {
        schedulePersistLeadAssignRepId(sel.value);
      });
    }
  }

  function readFileAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        resolve(fr.result);
      };
      fr.onerror = reject;
      fr.readAsArrayBuffer(file);
    });
  }

  function normalizeHeader(h) {
    return String(h || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  }

  function firstValue(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v != null && String(v).trim()) return String(v).trim();
    }
    return '';
  }

  /** Split one cell that lists several numbers (exporters often use "555-1111 / 555-2222"). */
  function splitPhoneCandidates(raw) {
    if (raw == null || raw === '') return [];
    var str = String(raw).trim();
    return str
      .split(/\s*(?:\/|;|,|\||\n|\bthen\b|\bor\b|\band\b)\s*/i)
      .map(function (p) {
        return p.trim();
      })
      .filter(Boolean);
  }

  /** Normalize to E.164-style string when clearly US 10/11 digits; otherwise keep digits if plausible length. */
  function normalizePhoneDigits(raw) {
    var digits = String(raw || '').replace(/\D/g, '');
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.charAt(0) === '1') return '+' + digits;
    if (digits.length >= 10 && digits.length <= 15) return '+' + digits;
    return '';
  }

  function hasDialablePhone(phoneStr) {
    var d = String(phoneStr || '').replace(/\D/g, '');
    return d.length >= 10;
  }

  /** Column header keys (normalized) tried in order — primary lines before alternates / phone2 / phone3. */
  var LEAD_PHONE_CANON_KEYS = [
    'phone',
    'phonenumber',
    'primaryphone',
    'mainphone',
    'telephone',
    'mobile',
    'cell',
    'cellphone',
    'workphone',
    'number',
    'contactnumber',
    'phone1',
    'phone2',
    'phone3',
    'phone4',
    'alternatephone',
    'secondaryphone',
    'altphone',
    'homephone',
    'otherphone',
    'additionalphone',
  ];

  /**
   * Take the first valid phone number from any phone-like column or multi-number cell.
   */
  function pickPrimaryPhoneFromCanon(canon) {
    for (var i = 0; i < LEAD_PHONE_CANON_KEYS.length; i++) {
      var key = LEAD_PHONE_CANON_KEYS[i];
      if (!Object.prototype.hasOwnProperty.call(canon, key)) continue;
      var cell = canon[key];
      if (cell == null || !String(cell).trim()) continue;
      var candidates = splitPhoneCandidates(cell);
      for (var j = 0; j < candidates.length; j++) {
        var norm = normalizePhoneDigits(candidates[j]);
        if (norm && hasDialablePhone(norm)) return norm;
      }
    }
    return '';
  }

  function normalizeEstablishmentToken(s) {
    return String(s || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9\s]/g, '')
      .trim();
  }

  /**
   * One stable key per establishment so duplicate rows / multiple contacts collapse.
   * Rows with no business+name dedupe only by phone (each distinct number kept).
   */
  function establishmentGroupKey(lead) {
    var biz = String(lead.business || '').trim();
    if (biz && biz !== 'Unknown') return 'b:' + normalizeEstablishmentToken(biz);
    var nm = String(lead.name || '').trim();
    if (nm) return 'n:' + normalizeEstablishmentToken(nm);
    var d = String(lead.phone || '').replace(/\D/g, '');
    if (d.length >= 10) return 'p:' + d.slice(-10);
    return 'u:' + lead.id;
  }

  /**
   * Same establishment may appear on multiple sheet rows (multiple POCs). Keep the first row that has a dialable phone;
   * otherwise keep the first row for that establishment.
   */
  function dedupeFirstValidLeadPerEstablishment(leads) {
    var groups = {};
    var order = [];
    for (var i = 0; i < leads.length; i++) {
      var L = leads[i];
      var k = establishmentGroupKey(L);
      if (!groups[k]) {
        groups[k] = [];
        order.push(k);
      }
      groups[k].push(L);
    }
    var out = [];
    for (var oi = 0; oi < order.length; oi++) {
      var arr = groups[order[oi]];
      var picked = null;
      for (var j = 0; j < arr.length; j++) {
        if (hasDialablePhone(arr[j].phone)) {
          picked = arr[j];
          break;
        }
      }
      if (!picked) picked = arr[0];
      out.push(picked);
    }
    return out;
  }

  function parseLeadRows(sheetRows) {
    var mapped = sheetRows
      .map(function (r) {
        var canon = {};
        Object.keys(r || {}).forEach(function (k) {
          canon[normalizeHeader(k)] = r[k];
        });
        var business = firstValue(canon, [
          'business',
          'businessname',
          'company',
          'companyname',
          'account',
          'accountname',
          'organization',
          'org',
          'establishment',
          'location',
          'store',
        ]);
        var firstName = firstValue(canon, ['firstname', 'first', 'fname', 'contactfirstname']);
        var lastName = firstValue(canon, ['lastname', 'last', 'lname', 'contactlastname']);
        var fullName = firstValue(canon, ['name', 'fullname', 'contact', 'contactname']);
        var name = fullName || (firstName || lastName ? (firstName + ' ' + lastName).trim() : '');
        var cleanedPhone = pickPrimaryPhoneFromCanon(canon);
        var city = firstValue(canon, ['city', 'town']);
        var vertical = firstValue(canon, ['vertical', 'industry']) || 'General';
        var stage = firstValue(canon, ['stage']) || 'New';
        if (!business && !cleanedPhone && !name) return null;
        var row = {
          business: business || name || 'Unknown',
          name: name || '',
          phone: cleanedPhone || '',
          city: city || '',
          vertical: vertical,
          stage: stage,
        };
        row.id = stableImportContactId(row);
        return row;
      })
      .filter(Boolean);
    return dedupeFirstValidLeadPerEstablishment(mapped);
  }

  /** Stable text id for northstar_contacts — must exist in DB before call list rows reference contact_id. */
  function stableImportContactId(lead) {
    var digits = String(lead.phone || '').replace(/\D/g, '');
    if (digits.length >= 10) return 'ns_lp_' + digits.slice(-10);
    var slug = String(lead.business || lead.name || 'lead')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 48);
    if (!slug.length) slug = 'lead';
    var tail = digits.length ? digits.slice(-8) : slug.slice(0, 12);
    return 'ns_lb_' + slug + '_' + tail;
  }

  /**
   * Spread leads across reps with minimal load per rep. When counts tie (common on fresh CRM),
   * rotate among tied reps so we do not assign every lead to reps[0].
   */
  function splitEvenAssignments(leads, reps) {
    if (!reps || !reps.length) return leads;
    var counts = {};
    reps.forEach(function (r) {
      var id = seatAgentKey(r);
      counts[id] = 0;
    });
    NorthstarCRM.listContacts().forEach(function (c) {
      var aid = c.assignedAgentId;
      if (aid && Object.prototype.hasOwnProperty.call(counts, aid)) {
        counts[aid] = (counts[aid] || 0) + 1;
      } else if (aid) {
        counts[aid] = (counts[aid] || 0) + 1;
      }
    });
    return leads.map(function (lead, idx) {
      var minCount = Infinity;
      reps.forEach(function (r) {
        var id = seatAgentKey(r);
        var n = counts[id] || 0;
        if (n < minCount) minCount = n;
      });
      var pool = [];
      reps.forEach(function (r) {
        var id = seatAgentKey(r);
        if ((counts[id] || 0) === minCount) pool.push(r);
      });
      if (!pool.length) pool = reps.slice();
      var best = pool[idx % pool.length];
      var aid = seatAgentKey(best);
      counts[aid] = (counts[aid] || 0) + 1;
      return Object.assign({}, lead, {
        assignedAgentId: aid,
        assignedAgentName: best.name || aid,
      });
    });
  }

  function todayIsoDate() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function deriveCallListName(fileName, repId, splitEven) {
    var manual = document.getElementById('callListName');
    var v = manual ? String(manual.value || '').trim() : '';
    if (v) return v;
    var datePart = document.getElementById('callListDate') && document.getElementById('callListDate').value
      ? document.getElementById('callListDate').value
      : todayIsoDate();
    if (splitEven) return 'Daily Queue ' + datePart + ' (split)';
    return 'Daily Queue ' + datePart + (repId ? ' - ' + repId : '');
  }

  async function createDailyCallListFromLeads(assignedLeads, fileName, splitEven, pickedRep) {
    var client = getClient();
    if (!client || !assignedLeads || !assignedLeads.length) return null;
    var dateEl = document.getElementById('callListDate');
    var listDate = dateEl && dateEl.value ? dateEl.value : todayIsoDate();
    var listName = deriveCallListName(fileName, pickedRep, splitEven);
    var header = await client
      .from('northstar_call_lists')
      .insert({
        name: listName,
        list_date: listDate,
        owner_agent_id: splitEven ? null : pickedRep || null,
        status: 'active',
      })
      .select('id,name,list_date')
      .single();
    if (header.error) throw header.error;
    var listId = header.data.id;
    var rows = assignedLeads.map(function (lead, idx) {
      return {
        list_id: listId,
        contact_id: lead.id || null,
        business: lead.business || lead.name || 'Unknown',
        contact_name: lead.name || '',
        phone: lead.phone || '',
        vertical: lead.vertical || 'General',
        assigned_agent_id: lead.assignedAgentId || null,
        assigned_agent_name: lead.assignedAgentName || null,
        priority: 0,
        order_index: idx,
        status: 'new',
      };
    });
    var ins = await client.from('northstar_call_list_items').insert(rows);
    if (ins.error) throw ins.error;
    return { listId: listId, count: rows.length, name: header.data.name };
  }

  async function refreshCallListsView() {
    var el = document.getElementById('crmCallLists');
    if (!el) return;
    var client = getClient();
    if (!client) {
      el.innerHTML = '<p class="hint">Supabase client not available.</p>';
      return;
    }
    var res = await client
      .from('northstar_call_lists')
      .select('id,name,list_date,status,owner_agent_id,created_at')
      .order('created_at', { ascending: false })
      .limit(20);
    if (res.error) {
      el.innerHTML = '<p class="hint">Could not load lists: ' + esc(res.error.message || String(res.error)) + '</p>';
      return;
    }
    var rows = res.data || [];
    if (!rows.length) {
      el.innerHTML = '<p class="hint">No daily call lists yet.</p>';
      return;
    }
    el.innerHTML = rows
      .map(function (r) {
        return (
          '<div class="act-row" style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">' +
          '<div><strong>' +
          esc(r.name) +
          '</strong><br/><span style="color:#6b7280">' +
          esc(r.list_date || '') +
          ' · ' +
          esc(r.status || '') +
          (r.owner_agent_id ? ' · owner ' + esc(r.owner_agent_id) : '') +
          '</span></div>' +
          '<div style="display:flex;gap:6px">' +
          '<button type="button" class="db blu" style="font-size:10px;padding:4px 8px" onclick="archiveDispositionedCalls(\'' +
          esc(r.id) +
          '\',\'' +
          esc(r.name) +
          '\')">Archive closed</button>' +
          '<button type="button" class="db" style="font-size:10px;padding:4px 8px" onclick="deleteCallList(\'' +
          esc(r.id) +
          '\',\'' +
          esc(r.name) +
          '\')">Delete</button>' +
          '</div>' +
          '</div>'
        );
      })
      .join('');
  }

  window.archiveDispositionedCalls = async function archiveDispositionedCalls(listId, listName) {
    if (!listId) return;
    var ok = confirm(
      'Archive dispositioned calls for "' +
        (listName || listId) +
        '"?\n\nThis keeps history, but removes closed items from the active daily queue.'
    );
    if (!ok) return;
    var client = getClient();
    if (!client) {
      alert('Supabase client unavailable.');
      return;
    }
    var upd = await client
      .from('northstar_call_list_items')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('list_id', listId)
      .eq('status', 'closed');
    if (upd.error) {
      alert('Archive failed: ' + (upd.error.message || String(upd.error)));
      return;
    }
    var openCheck = await client
      .from('northstar_call_list_items')
      .select('id')
      .eq('list_id', listId)
      .in('status', ['new', 'working', 'follow_up'])
      .limit(1);
    if (!openCheck.error && (!openCheck.data || !openCheck.data.length)) {
      await client
        .from('northstar_call_lists')
        .update({ status: 'archived', updated_at: new Date().toISOString() })
        .eq('id', listId);
    }
    await refreshCallListsView();
    alert('Dispositioned calls archived.');
  };

  window.deleteCallList = async function deleteCallList(listId, listName) {
    if (!listId) return;
    var ok = confirm(
      'Delete call list "' +
        (listName || listId) +
        '"?\n\nThis removes the list and its queue items from Supabase. CRM contacts that are not on any other active daily list are deleted (archived lists do not count). Contacts still on another active list stay in the CRM.'
    );
    if (!ok) return;
    var client = getClient();
    if (!client) {
      alert('Supabase client unavailable.');
      return;
    }
    var itemsRes = await client.from('northstar_call_list_items').select('contact_id').eq('list_id', listId);
    if (itemsRes.error) {
      alert('Could not read list items: ' + (itemsRes.error.message || String(itemsRes.error)));
      return;
    }
    var contactIds = [];
    (itemsRes.data || []).forEach(function (row) {
      var cid = row && row.contact_id ? String(row.contact_id).trim() : '';
      if (cid && contactIds.indexOf(cid) === -1) contactIds.push(cid);
    });
    var contactIdsToRemoveFromCrm = [];
    var usedElsewhere = {};
    if (contactIds.length) {
      var listsRes = await client
        .from('northstar_call_lists')
        .select('id')
        .eq('status', 'active')
        .neq('id', listId);
      if (listsRes.error) {
        alert('Could not check other active lists: ' + (listsRes.error.message || String(listsRes.error)));
        return;
      }
      var otherActiveIds = (listsRes.data || [])
        .map(function (r) {
          return r && r.id ? String(r.id) : '';
        })
        .filter(Boolean);
      var LIST_CHUNK = 40;
      var CID_CHUNK = 80;
      for (var oi = 0; oi < otherActiveIds.length; oi += LIST_CHUNK) {
        var listChunk = otherActiveIds.slice(oi, oi + LIST_CHUNK);
        for (var ci = 0; ci < contactIds.length; ci += CID_CHUNK) {
          var cchunk = contactIds.slice(ci, ci + CID_CHUNK);
          var refRes = await client
            .from('northstar_call_list_items')
            .select('contact_id')
            .in('contact_id', cchunk)
            .in('list_id', listChunk);
          if (refRes.error) {
            alert('Could not check shared contacts: ' + (refRes.error.message || String(refRes.error)));
            return;
          }
          (refRes.data || []).forEach(function (row) {
            var c = row && row.contact_id ? String(row.contact_id).trim() : '';
            if (c) usedElsewhere[c] = true;
          });
        }
      }
      contactIds.forEach(function (cid) {
        if (!usedElsewhere[cid]) contactIdsToRemoveFromCrm.push(cid);
      });
    }

    if (contactIdsToRemoveFromCrm.length) {
      if (typeof NorthstarCRM !== 'undefined' && typeof NorthstarCRM.removeContactsLocal === 'function') {
        NorthstarCRM.removeContactsLocal(contactIdsToRemoveFromCrm);
        pumpCrmPaint();
      }
      var chunk = 200;
      try {
        for (var i = 0; i < contactIdsToRemoveFromCrm.length; i += chunk) {
          var slice = contactIdsToRemoveFromCrm.slice(i, i + chunk);
          var da = await client.from('northstar_activities').delete().in('contact_id', slice);
          if (da.error) throw da.error;
          var delC = await client.from('northstar_contacts').delete().in('id', slice);
          if (delC.error) throw delC.error;
        }
      } catch (e) {
        var msg = e && e.message ? e.message : String(e);
        alert('Contact delete failed: ' + msg);
        return;
      }
    }
    var del = await client.from('northstar_call_lists').delete().eq('id', listId);
    if (del.error) {
      alert('Delete failed: ' + (del.error.message || String(del.error)));
      return;
    }
    await refreshCallListsView();
    if (typeof NorthstarCRM !== 'undefined' && NorthstarCRM.syncFromRemote) {
      await NorthstarCRM.syncFromRemote().then(refreshCrmView).catch(refreshCrmView);
    } else {
      refreshCrmView();
    }
    var kept = contactIds.length - contactIdsToRemoveFromCrm.length;
    alert(
      'Call list deleted.' +
        (contactIdsToRemoveFromCrm.length
          ? ' Removed ' + contactIdsToRemoveFromCrm.length + ' CRM contact(s) that were only on this list.'
          : '') +
        (kept > 0 ? ' Kept ' + kept + ' contact(s) still on another active daily list.' : '')
    );
  };

  window.refreshCallListsView = function () {
    refreshCallListsView().catch(function (err) {
      try {
        alert('Call lists refresh failed: ' + (err && err.message ? err.message : String(err)));
      } catch (_e) {}
    });
  };

  window.openLeadImport = function openLeadImport() {
    var el = document.getElementById('leadImportFile');
    if (el) el.click();
  };

  async function importLeadFile(file) {
    if (!file) return;
    if (typeof XLSX === 'undefined') {
      alert('XLSX parser failed to load. Refresh and try again.');
      return;
    }
    var reps = assignableReps();
    if (!reps.length) {
      alert('No assignable reps found. Add Agent seats in Users & ext first.');
      return;
    }
    var split = !!(document.getElementById('leadSplitEven') && document.getElementById('leadSplitEven').checked);
    var pickedRep = document.getElementById('leadAssignRep') ? document.getElementById('leadAssignRep').value : '';
    if (!split && !pickedRep && reps.length === 1) {
      pickedRep = seatAgentKey(reps[0]);
    }
    if (!split && !pickedRep) {
      alert('Choose a rep or enable even split before importing.');
      return;
    }

    var data = await readFileAsArrayBuffer(file);
    var wb = XLSX.read(data, { type: 'array' });
    var ws = wb.Sheets[wb.SheetNames[0]];
    var rawRows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    var leads = parseLeadRows(rawRows);
    if (!leads.length) {
      alert(
        'No valid lead rows found.\n\nInclude at least one of these header sets:\n- company/company name/business\n- name OR first name + last name\n- phone/mobile/cell/telephone'
      );
      return;
    }

    var assigned;
    if (split) {
      assigned = splitEvenAssignments(leads, reps);
    } else {
      var rep = reps.filter(function (r) {
        return seatAgentKey(r) === pickedRep;
      })[0];
      if (!rep) {
        alert('Selected rep no longer exists. Refresh and try again.');
        return;
      }
      assigned = leads.map(function (l) {
        return Object.assign({}, l, {
          assignedAgentId: seatAgentKey(rep),
          assignedAgentName: rep.name || seatAgentKey(rep),
        });
      });
    }

    var importedAt = new Date().toISOString();
    var persistedLeads = [];
    var useAwait =
      typeof NorthstarCRM !== 'undefined' &&
      typeof NorthstarCRM.isRemoteEnabled === 'function' &&
      NorthstarCRM.isRemoteEnabled() &&
      typeof NorthstarCRM.upsertContactAwaitRemote === 'function';
    for (var pi = 0; pi < assigned.length; pi++) {
      var leadRow = assigned[pi];
      var payload = Object.assign({}, leadRow, {
        sourceFile: file.name,
        importedAt: importedAt,
      });
      try {
        var up;
        if (useAwait) {
          up = await NorthstarCRM.upsertContactAwaitRemote(payload);
        } else {
          up = NorthstarCRM.upsertContact(payload);
        }
        var saved = up && up.contact ? up.contact : null;
        persistedLeads.push(
          Object.assign({}, leadRow, {
            id: saved && saved.id ? saved.id : leadRow.id,
          })
        );
      } catch (impErr) {
        alert('Import failed: ' + (impErr && impErr.message ? impErr.message : String(impErr)));
        return;
      }
    }
    var createListEl = document.getElementById('leadCreateDailyList');
    var listSummary = null;
    if (!createListEl || createListEl.checked) {
      try {
        listSummary = await createDailyCallListFromLeads(persistedLeads, file.name, split, pickedRep);
      } catch (listErr) {
        alert('Import failed: ' + (listErr && listErr.message ? listErr.message : String(listErr)));
        if (NorthstarCRM.syncFromRemote) await NorthstarCRM.syncFromRemote().catch(function () {});
        refreshCrmView();
        await refreshCallListsView().catch(function () {});
        return;
      }
    }
    if (NorthstarCRM.syncFromRemote) await NorthstarCRM.syncFromRemote();
    refreshCrmView();
    await refreshCallListsView();
    refreshOverviewMetrics();
    var extra = listSummary
      ? ' Created call list "' + listSummary.name + '" with ' + listSummary.count + ' items.'
      : '';
    alert('Imported ' + assigned.length + ' leads from ' + file.name + '.' + extra);
  }

  window.exportCrm = function exportCrm() {
    var blob = new Blob([NorthstarCRM.exportJson()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'northstar-crm-export.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  window.exportcdr = function exportcdr() {
    alert('Production: GET /admin/api/cdr?from=&to=&format=csv returns signed CSV from your CDR warehouse.');
  };

  function boot() {
    if (didBoot) return;
    didBoot = true;
    var crmP = Promise.resolve();
    if (typeof NorthstarCRM.initialize === 'function') {
      crmP = NorthstarCRM.initialize()
        .then(function () {
          refreshCrmView();
          if (typeof NorthstarCRM.isRemoteEnabled === 'function' && NorthstarCRM.isRemoteEnabled() && NorthstarCRM.syncFromRemote) {
            return NorthstarCRM.syncFromRemote().then(refreshCrmView);
          }
        })
        .catch(function (err) {
          console.warn('[Northstar admin] CRM init', err);
          refreshCrmView();
        });
    } else {
      refreshCrmView();
    }

    crmP
      .then(function () {
        if (typeof NorthstarTeamRoster !== 'undefined' && NorthstarTeamRoster.initialize) {
          return NorthstarTeamRoster.initialize();
        }
      })
      .then(function () {
        return syncAdminUiPrefsFromRemote().catch(function (err) {
          console.warn('[Northstar admin] UI prefs', err);
        });
      })
      .then(function () {
        renderOverviewSeats();
        renderTeamAdminTable();
        populateLeadAssignReps();
        var listDate = document.getElementById('callListDate');
        if (listDate && !listDate.value) listDate.value = todayIsoDate();
        refreshCallListsView().catch(function () {});
        return refreshNumbersInventory();
      })
      .then(function () {
        populatePhoneOptions('');
        if (typeof NorthstarTeamRoster !== 'undefined' && NorthstarTeamRoster.subscribe) {
          NorthstarTeamRoster.subscribe(function () {
            renderOverviewSeats();
            renderTeamAdminTable();
            populateLeadAssignReps();
            populatePhoneOptions('');
            refreshCallListsView().catch(function () {});
          });
        }
        var importInput = document.getElementById('leadImportFile');
        if (importInput) {
          importInput.addEventListener('change', function () {
            var f = importInput.files && importInput.files[0];
            importLeadFile(f)
              .catch(function (err) {
                alert('Import failed: ' + (err && err.message ? err.message : String(err)));
              })
              .then(function () {
                importInput.value = '';
              });
          });
        }
        ensureCrmRealtime();
        ensureLiveOpsRealtime();
        ensureMetricsRealtime();
        return refreshAllDashboardMetrics();
      })
      .catch(function (e) {
        console.warn('[Northstar admin] team roster', e);
        renderOverviewSeats();
        renderTeamAdminTable();
        syncAdminUiPrefsFromRemote()
          .catch(function () {})
          .then(function () {
            populateLeadAssignReps();
          });
        refreshNumbersInventory();
        ensureLiveOpsRealtime();
        ensureMetricsRealtime();
        refreshAllDashboardMetrics();
      });
  }

  function init() {
    try {
      syncChromeHintVisibility();
      wireAdminAuthForm();
      if (typeof NorthstarAdminAuth === 'undefined' || !NorthstarAdminAuth.requireAuthEnabled || !NorthstarAdminAuth.requireAuthEnabled()) {
        showAppShell();
        boot();
        return;
      }

      NorthstarAdminAuth.initializeSession()
        .then(function (res) {
          if (!res || !res.context) {
            showAuthGate('');
            return;
          }
          applyAdminIdentity(res.context);
          if (!res.context.isAdmin) {
            showAuthGate('Your account is signed in but not assigned Admin/Supervisor access.');
            return;
          }
          showAppShell();
          boot();
        })
        .catch(function (err) {
          showAuthGate(err && err.message ? err.message : 'Could not restore session');
        });

      NorthstarAdminAuth.attachAuthListener(function (ctx) {
        if (ctx && ctx._hydrateError) {
          showAuthGate(ctx.message || 'Could not load your workspace profile. Sign in again.');
          return;
        }
        applyAdminIdentity(ctx);
        if (ctx && ctx.isAdmin) {
          showAppShell();
          boot();
        } else {
          showAuthGate(ctx ? 'Your account is not assigned Admin or Supervisor access in the team directory.' : '');
        }
      });
    } catch (err) {
      var gate = $('authGate');
      var errEl = $('authErr');
      if (gate) gate.style.display = 'flex';
      if (errEl) errEl.textContent = err && err.message ? err.message : String(err);
      try {
        console.error('[Northstar admin] init failed', err);
      } catch (_e) {}
    }
  }

  init();
})();
