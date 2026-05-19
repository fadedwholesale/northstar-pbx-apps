/* global NorthstarCRM, NorthstarTelephony, NorthstarLiveOps, NorthstarTeamRoster, NorthstarInbox, NorthstarSms, NorthstarApps, NorthstarAuth */
(function (global) {
  var AGENT = {
    id: 'agent_jd',
    name: 'James D.',
    initials: 'JD',
    extension: '',
    smsNumberE164: '',
    pendingSeat: false,
    /** Legacy Twilio Client label from profile (CRM rows may still reference this). */
    twilioIdentity: '',
    voiceEdge: 'auto',
  };

  /** One-time install: when the agent returns to this tab, re-pull CRM so Admin deletes/lists show up without manual "CRM sync". */
  var crmVisibilityRefreshInstalled = false;
  var crmForegroundDebounceTimer = null;
  var voiceQualityWarningCount = 0;

  function applySeat(seat) {
    if (!seat) return;
    AGENT.id = seat.id;
    AGENT.name = seat.name;
    AGENT.initials = seat.initials;
    AGENT.extension = seat.extension || '';
    AGENT.smsNumberE164 = seat.smsNumberE164 || '';
    AGENT.pendingSeat = !!seat.pendingSeat;
    AGENT.twilioIdentity = seat.twilioIdentity ? String(seat.twilioIdentity).trim() : '';
    AGENT.voiceEdge = seat.voiceEdge ? String(seat.voiceEdge).trim().toLowerCase() : 'auto';
    if (typeof NorthstarTelephony.setVoiceEdgePreference === 'function') {
      NorthstarTelephony.setVoiceEdgePreference(AGENT.voiceEdge);
    }
  }

  function syncAgentFromAuth() {
    if (typeof NorthstarAuth === 'undefined' || !NorthstarAuth.resolveSeat) return;
    var s = NorthstarAuth.resolveSeat();
    if (s) applySeat(s);
  }

  function lineLabelFor(e164, idx) {
    var num = formatPhone(e164);
    if (AGENT.smsNumberE164 && String(AGENT.smsNumberE164).trim() === String(e164 || '').trim()) {
      return 'Assigned — ' + num;
    }
    return 'Line ' + (idx + 1) + ' — ' + num;
  }

  function applyOutboundLines(rows) {
    var lines = (rows || []).map(function (r, idx) {
      var e164 = String(r.e164 || '').trim();
      return {
        id: String(r.id || ('line_' + idx)),
        label: lineLabelFor(e164, idx),
        number: e164,
        outbound: true,
      };
    });
    if (!lines.length && AGENT.smsNumberE164) {
      lines = [
        {
          id: 'assigned',
          label: lineLabelFor(AGENT.smsNumberE164, 0),
          number: AGENT.smsNumberE164,
          outbound: true,
        },
      ];
    }
    if (!lines.length) return;
    if (typeof NorthstarTelephony.setLines === 'function') {
      NorthstarTelephony.setLines(lines, AGENT.smsNumberE164 || '');
    }
    var lineSel = $('lineSel');
    if (lineSel) {
      var all = NorthstarTelephony.getLines();
      lineSel.innerHTML = all
        .map(function (l) {
          return '<option value="' + esc(l.id) + '">' + esc(l.label) + '</option>';
        })
        .join('');
      lineSel.value = (NorthstarTelephony.getState() && NorthstarTelephony.getState().lineId) || all[0].id;
    }
    var cid = $('callerIdSel');
    if (cid) {
      cid.innerHTML = NorthstarTelephony.getCallerIds().map(function (n, i) {
        return '<option value="' + i + '">' + esc(formatPhone(n)) + '</option>';
      }).join('');
      var idx = (NorthstarTelephony.getState() && NorthstarTelephony.getState().callerIdIndex) || 0;
      cid.value = String(idx);
    }
  }

  function refreshAssignedOutboundLines() {
    var client = getClient();
    if (!client || !AGENT.id) return Promise.resolve();
    return client
      .from('northstar_phone_numbers')
      .select('id,e164,assigned_agent_id')
      .eq('assigned_agent_id', AGENT.id)
      .order('e164', { ascending: true })
      .then(function (res) {
        if (res.error) throw res.error;
        applyOutboundLines(res.data || []);
      })
      .catch(function () {
        applyOutboundLines([]);
      });
  }

  function getClient() {
    return typeof NorthstarSupabase !== 'undefined' && NorthstarSupabase.getClient ? NorthstarSupabase.getClient() : null;
  }

  function bindOutboundLinesRealtime() {
    if (outboundLinesRealtimeBound) return;
    var client = getClient();
    if (!client || !AGENT.id || typeof client.channel !== 'function') return;
    outboundLinesRealtimeBound = true;
    var ch = client.channel('northstar-outbound-lines-' + AGENT.id);
    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'northstar_phone_numbers' },
      function () {
        refreshAssignedOutboundLines();
      }
    );
    ch.subscribe();
  }

  /** Team roster (Admin) used for transfers and directory — not shown in sidebar (cold-calling UI). */

  /** Lead queue = daily list rows for you, else CRM contacts assigned to this agent only. */
  var activeLeadId = null;
  var lastLeadFilter = 'all';
  var timerInt = null;
  var dtmfOpen = false;
  var notifCount = 2;
  var inboxRealtimeBound = false;
  var smsRealtimeBound = false;
  var outboundLinesRealtimeBound = false;
  var callQueueRows = [];
  var callQueueLoaded = false;
  var callQueueRealtimeBound = false;
  var crmDataRealtimeBound = false;
  var archivedFallbackLeadIds = {};
  var inboundOffer = null;
  var inboundRingTimer = null;
  var inboundDesktopNotice = null;
  var inboundAudioCtx = null;
  var voiceKeepAliveTimer = null;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return iso; }
  }

  function inferLeadCategory(raw, business, contactName) {
    if (global.NorthstarLeadCategories && typeof NorthstarLeadCategories.infer === 'function') {
      return NorthstarLeadCategories.infer(raw, business, contactName);
    }
    return normalizeLeadCategory(raw);
  }

  function normalizeLeadCategory(raw) {
    if (global.NorthstarLeadCategories && typeof NorthstarLeadCategories.normalize === 'function') {
      return NorthstarLeadCategories.normalize(raw);
    }
    var s = String(raw || '').trim();
    return s || 'General';
  }

  function categoryTagClass(vert) {
    if (global.NorthstarLeadCategories && typeof NorthstarLeadCategories.tagClass === 'function') {
      return NorthstarLeadCategories.tagClass(vert);
    }
    return 'tag-cat-general';
  }

  /** Rebuild category filter + chips from assigned leads (Restaurant, Coffee Shop, Construction, …). */
  function syncLeadCategoryFilters(rows) {
    rows = rows || [];
    var counts = {};
    rows.forEach(function (r) {
      var c = normalizeLeadCategory(r && r.vert);
      counts[c] = (counts[c] || 0) + 1;
    });
    var sorted = Object.keys(counts).sort(function (a, b) {
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    var prev = String(lastLeadFilter || 'all');

    var sel = $('leadVertFilter');
    if (sel) {
      var html = '<option value="all">All categories (' + rows.length + ')</option>';
      sorted.forEach(function (v) {
        html += '<option value="' + esc(v) + '">' + esc(v) + ' (' + counts[v] + ')</option>';
      });
      sel.innerHTML = html;
      if (prev === 'all' || counts[prev]) sel.value = prev;
      else {
        sel.value = 'all';
        lastLeadFilter = 'all';
      }
    }

    var chips = $('leadCategoryChips');
    if (chips) {
      var chipHtml =
        '<button type="button" class="cat-chip' +
        (prev === 'all' ? ' on' : '') +
        '" data-cat="all">All <span class="cat-n">' +
        rows.length +
        '</span></button>';
      sorted.forEach(function (v) {
        chipHtml +=
          '<button type="button" class="cat-chip' +
          (prev === v ? ' on' : '') +
          '" data-cat="' +
          esc(v) +
          '">' +
          esc(v) +
          ' <span class="cat-n">' +
          counts[v] +
          '</span></button>';
      });
      chips.innerHTML = chipHtml;
      chips.querySelectorAll('.cat-chip').forEach(function (btn) {
        btn.onclick = function () {
          filterLeads(btn.getAttribute('data-cat') || 'all');
        };
      });
    }
  }

  function contactToLeadRow(c) {
    return {
      id: c.id,
      contactId: c.id,
      biz: c.business || 'Unknown',
      name: c.name || '',
      phone: c.phone || '',
      vert: inferLeadCategory(c.vertical, c.business, c.name),
      city: c.city || '',
      tag: categoryTagClass(inferLeadCategory(c.vertical, c.business, c.name)),
    };
  }

  function queueItemToLeadRow(q) {
    return {
      id: 'qli:' + q.id,
      listItemId: q.id,
      contactId: q.contact_id || null,
      biz: q.business || 'Unknown',
      name: q.contact_name || '',
      phone: q.phone || '',
      vert: inferLeadCategory(q.vertical, q.business, q.contact_name),
      city: q.city || '',
      tag: categoryTagClass(inferLeadCategory(q.vertical, q.business, q.contact_name)),
      status: q.status || 'new',
      attempts: Number(q.attempts) || 0,
      nextActionAt: q.next_action_at || null,
    };
  }

  function getLeadRows() {
    if (callQueueLoaded && callQueueRows.length) return callQueueRows.slice();
    if (typeof NorthstarCRM === 'undefined' || typeof NorthstarCRM.listContacts !== 'function') return [];
    return NorthstarCRM
      .listContacts()
      .filter(function (c) {
        var cid = String(c.id || '');
        if (cid && archivedFallbackLeadIds[cid]) return false;
        return true;
      })
      .map(contactToLeadRow);
  }

  function refreshDailyCallQueue() {
    var client = getClient();
    if (!client || !AGENT.id) {
      callQueueLoaded = true;
      callQueueRows = [];
      return Promise.resolve();
    }
    var uid = String(AGENT.id || '').trim();
    var twLeg = String(AGENT.twilioIdentity || '').trim();
    var q = client
      .from('northstar_call_list_items')
      .select('id,contact_id,business,contact_name,phone,vertical,status,attempts,next_action_at,assigned_agent_id,priority,order_index')
      .in('status', ['new', 'working']);
    if (twLeg && twLeg !== uid) {
      q = q.or('assigned_agent_id.eq.' + uid + ',assigned_agent_id.eq.' + twLeg);
    } else {
      q = q.eq('assigned_agent_id', uid);
    }
    return q
      .order('priority', { ascending: false })
      .order('order_index', { ascending: true })
      .order('next_action_at', { ascending: true, nullsFirst: true })
      .then(function (res) {
        if (res.error) throw res.error;
        callQueueRows = (res.data || []).map(queueItemToLeadRow);
        callQueueLoaded = true;
      })
      .catch(function () {
        callQueueRows = [];
        callQueueLoaded = true;
      });
  }

  function bindDailyCallQueueRealtime() {
    if (callQueueRealtimeBound) return;
    var client = getClient();
    if (!client || !AGENT.id || typeof client.channel !== 'function') return;
    callQueueRealtimeBound = true;
    var ch = client.channel('northstar-call-queue-' + AGENT.id);
    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'northstar_call_list_items' },
      function () {
        refreshDailyCallQueue().then(renderLeads).catch(function () {});
      }
    );
    ch.subscribe();
  }

  /** One realtime channel for CRM: contacts + activities both live in Supabase — keep Phone / Directory / stats on the same snapshot. */
  function bindCrmDataRealtime() {
    if (crmDataRealtimeBound) return;
    if (
      typeof NorthstarCRM === 'undefined' ||
      !NorthstarCRM.isRemoteEnabled ||
      !NorthstarCRM.isRemoteEnabled() ||
      typeof NorthstarCRM.syncFromRemote !== 'function'
    ) {
      return;
    }
    var client = getClient();
    if (!client || typeof client.channel !== 'function') return;
    crmDataRealtimeBound = true;
    var ch = client.channel('northstar-crm-remote');
    function pullCrmFromRemote() {
      NorthstarCRM.syncFromRemote()
        .catch(function () {})
        .then(function () {
          try {
            refreshTodayStatsFromCrm();
          } catch (x) {}
          try {
            renderContacts();
          } catch (x) {}
          try {
            renderLeads();
          } catch (x) {}
          try {
            renderCrmSync();
          } catch (x) {}
          try {
            renderHistory();
          } catch (x) {}
        });
    }
    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'northstar_activities' },
      pullCrmFromRemote
    );
    ch.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'northstar_contacts' },
      pullCrmFromRemote
    );
    ch.subscribe();
  }

  function writeDispositionForQueueItem(lead, contactId, activityId, disposition, notes, durationSec, recording, callSid) {
    if (!lead || !lead.listItemId) return Promise.resolve();
    var client = getClient();
    if (!client) return Promise.resolve();
    var resolvedContactId = contactId || lead.contactId || null;
    var backfill = Promise.resolve();
    if (resolvedContactId && !lead.contactId) {
      backfill = client
        .from('northstar_call_list_items')
        .update({ contact_id: resolvedContactId, updated_at: new Date().toISOString() })
        .eq('id', lead.listItemId)
        .then(function (upd) {
          if (upd && upd.error) throw upd.error;
          lead.contactId = resolvedContactId;
        });
    }
    return backfill.then(function () {
      return client
        .from('northstar_call_dispositions')
        .insert({
          list_item_id: lead.listItemId,
          contact_id: resolvedContactId,
          // Activity writes are queued async; avoid FK race on northstar_call_dispositions.activity_id.
          activity_id: null,
          agent_id: AGENT.id,
          agent_name: AGENT.name,
          disposition: disposition,
          outcome_category: disposition,
          notes: notes || null,
          duration_sec: durationSec != null ? durationSec : null,
          recording: !!recording,
          call_sid: callSid || null,
        })
        .then(function (res) {
          if (res && res.error) throw res.error;
        });
    });
  }

  function advanceLeadQueueAfterDisposition(leadId) {
    if (!leadId) return;
    callQueueRows = callQueueRows.filter(function (r) {
      return r.id !== leadId;
    });
    if (activeLeadId === leadId) {
      activeLeadId = callQueueRows.length ? callQueueRows[0].id : null;
    }
  }

  function currentLead() {
    var rows = getLeadRows();
    if (!rows.length) return null;
    if (activeLeadId) {
      var found = rows.filter(function (r) {
        return r.id === activeLeadId;
      })[0];
      if (found) return found;
    }
    return rows[0];
  }

  function getDialInput() {
    return ($('dialInput') && $('dialInput').value) || '';
  }

  function setDialInput(v) {
    if ($('dialInput')) $('dialInput').value = v;
  }

  function renderLeads(optFilter) {
    if (typeof optFilter === 'string') lastLeadFilter = optFilter;
    var filter = lastLeadFilter;
    var ll = $('leadList');
    var hintEl = $('leadQueueHint');
    if (!ll) return;
    var rows = getLeadRows();
    syncLeadCategoryFilters(rows);
    var usingDailyList = !!(callQueueLoaded && callQueueRows.length);
    if (!rows.length) {
      ll.innerHTML =
        '<p class="hint" style="margin:0;font-size:11px">No leads available. Ask your manager to import leads or assign you a call list in Admin.</p>';
      if (hintEl) {
        hintEl.textContent =
          '0 showing · Daily list rows for you, otherwise CRM contacts assigned to you only. Admin imports should include a Category column (Restaurant, Coffee Shop, Construction, etc.).';
      }
      return;
    }
    ll.innerHTML = '';
    var visibleCount = 0;
    rows.forEach(function (l) {
      if (filter && filter !== 'all') {
        if (normalizeLeadCategory(l.vert) !== normalizeLeadCategory(filter)) return;
      }
      var on = l.id === activeLeadId;
      var d = document.createElement('div');
      d.className = 'lc' + (on ? ' active' : '');
      d.innerHTML =
        '<div class="lt"><span class="ln">' +
        esc(l.biz) +
        '</span><span class="tag ' +
        esc(l.tag) +
        '">' +
        esc(l.vert) +
        '</span></div><div class="tp">' +
        esc(l.name) +
        '</div><div class="tph">' +
        esc(l.phone) +
        '</div>';
      var lid = l.id;
      d.onclick = function () {
        selectLead(lid);
      };
      ll.appendChild(d);
      visibleCount++;
    });
    if (!visibleCount && rows.length && filter && filter !== 'all') {
      ll.innerHTML =
        '<p class="hint" style="margin:0;font-size:11px">No leads in this category. Tap <strong>All</strong> or pick another category chip.</p>';
    }
    if (hintEl) {
      var src = usingDailyList
        ? "today's call list (new/working rows for you — not full CRM)"
        : 'CRM assigned to you only';
      hintEl.textContent =
        visibleCount +
        ' showing · ' +
        src +
        (filter && filter !== 'all' ? ' · category: ' + filter : '');
    }
  }

  function rosterAgentKey(m) {
    return m.profileId || m.twilioIdentity || m.id;
  }

  function isCurrentAgentRosterEntry(m) {
    var uid = String(AGENT.id || '').trim();
    var tw = String(AGENT.twilioIdentity || '').trim();
    var pk = rosterAgentKey(m);
    if (pk && pk === uid) return true;
    if (tw && pk === tw) return true;
    if (m.profileId && String(m.profileId) === uid) return true;
    return false;
  }

  /** Whole dollars for Apps earnings cards (values from northstar_agent_apps). */
  function formatUsd0(n) {
    var x = Number(n);
    if (!isFinite(x)) x = 0;
    return '$' + Math.round(x).toLocaleString('en-US');
  }

  /** Script + earnings from Supabase when connected; otherwise empty defaults (no seeded copy). */
  function appsUiSettings() {
    var remote =
      typeof NorthstarApps !== 'undefined' &&
      NorthstarApps.isRemoteEnabled &&
      NorthstarApps.isRemoteEnabled();
    if (remote && typeof NorthstarApps.getSettings === 'function') {
      var s = NorthstarApps.getSettings();
      return {
        openerScript: s.openerScript || '',
        apptBonusUsd: s.apptBonusUsd || 0,
        closeCommissionUsd: s.closeCommissionUsd || 0,
        loaded: !!s.loaded,
        remote: true,
      };
    }
    return {
      openerScript: '',
      apptBonusUsd: 0,
      closeCommissionUsd: 0,
      loaded: false,
      remote: false,
    };
  }

  /** Today strip = CRM call activities for this seat (agent_id = softphone identity; same source as Admin seat cards). */
  function refreshTodayStatsFromCrm() {
    var dialsEl = $('sDials');
    var contactsEl = $('sContacts');
    var apptsEl = $('sAppts');
    var closesEl = $('sCloses');
    if (!dialsEl || typeof NorthstarCRM.listActivities !== 'function') return;
    var acts = NorthstarCRM.listActivities(5000);
    var start = new Date();
    start.setHours(0, 0, 0, 0);
    var aid = String(AGENT.id || '').trim();
    var twLegacy = String(AGENT.twilioIdentity || '').trim();
    var mine = acts.filter(function (a) {
      var t = new Date(a.createdAt || 0);
      var ag = String(a.agentId || '').trim();
      var match = ag === aid || (!!twLegacy && ag === twLegacy);
      return match && t >= start;
    });
    var dials = mine.length;
    var seen = {};
    mine.forEach(function (a) {
      if (a.contactId) seen[a.contactId] = 1;
    });
    var uniqContacts = Object.keys(seen).length;
    var contacts = uniqContacts;
    var appts = mine.filter(function (a) {
      return /appointment|booked/i.test(String(a.disposition || ''));
    }).length;
    var closes = mine.filter(function (a) {
      return /won|sold|closed|sale closed|deposit/i.test(String(a.disposition || ''));
    }).length;
    dialsEl.textContent = String(dials);
    if (contactsEl) contactsEl.textContent = String(contacts);
    if (apptsEl) apptsEl.textContent = String(appts);
    if (closesEl) closesEl.textContent = String(closes);
  }

  function getRosterForHud() {
    var base =
      typeof NorthstarTeamRoster !== 'undefined' && NorthstarTeamRoster.getMembers
        ? NorthstarTeamRoster.getMembers()
        : [];
    if (
      typeof NorthstarTeamRoster !== 'undefined' &&
      typeof NorthstarTeamRoster.overlayCrmTodayStats === 'function'
    ) {
      return NorthstarTeamRoster.overlayCrmTodayStats(base, AGENT.id);
    }
    return base;
  }

  function renderTeam() {
    /** Team presence HUD removed — cold-calling workflow; roster still used for transfers / directory. */
  }

  function setCallControlsEnabled(enabled) {
    ['primaryCallCtrls', 'advancedCallCtrls'].forEach(function (id) {
      var wrap = $(id);
      if (!wrap) return;
      wrap.querySelectorAll('button').forEach(function (btn) {
        btn.disabled = !enabled;
      });
    });
  }

  function clearTimer() {
    if (timerInt) clearInterval(timerInt);
    timerInt = null;
  }

  function startTimerFrom(startedMs) {
    clearTimer();
    function tick() {
      var st = NorthstarTelephony.getState();
      if (!st.activeCall) return;
      var secs = Math.floor((Date.now() - st.activeCall.started) / 1000);
      var m = Math.floor(secs / 60), s = secs % 60;
      var el = $('timer');
      if (el) el.textContent = '00:' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }
    tick();
    timerInt = setInterval(tick, 1000);
  }

  function syncCallUi() {
    var st = NorthstarTelephony.getState();
    var has = !!st.activeCall;
    var isRinging = !!(inboundOffer && !has);
    var idleEl = $('idleCall');
    var actEl = $('activeCallCard');
    var inEl = $('incomingCallCard');
    if (idleEl) idleEl.classList.toggle('hidden', has);
    if (actEl) actEl.classList.toggle('hidden', !has);
    if (inEl) inEl.classList.toggle('hidden', !isRinging);
    if (idleEl && isRinging) idleEl.classList.add('hidden');
    if (isRinging) {
      var nm = $('incomingName');
      var fr = $('incomingFrom');
      if (nm) nm.textContent = (inboundOffer && inboundOffer.name) || 'Inbound caller';
      if (fr) fr.textContent = formatPhone((inboundOffer && inboundOffer.from) || '');
    }
    var rec = $('recCard');
    if (rec) {
      var on = has && st.activeCall && st.activeCall.recording;
      rec.style.display = on ? 'block' : 'none';
    }
    if ($('recBtn')) $('recBtn').classList.toggle('on', has && st.activeCall && st.activeCall.recording);
    if ($('muteBtn')) $('muteBtn').classList.toggle('on', has && st.activeCall && st.activeCall.mute);
    if ($('holdBtn')) $('holdBtn').classList.toggle('on', has && st.activeCall && st.activeCall.hold);
    if (has) {
      var c = st.activeCall;
      var lead = currentLead();
      var name = c.name || (lead && lead.biz) || 'Outbound call';
      var sub =
        (lead ? lead.name + ' · ' : '') +
        formatPhone(c.digits) +
        (lead ? ' · ' + (lead.city || 'San Antonio, TX') : '');
      if ($('cName')) $('cName').textContent = name;
      if ($('cSub')) $('cSub').textContent = sub;
      if ($('cAv')) $('cAv').textContent = (lead ? initials(lead.name) : '●');
      startTimerFrom(c.started);
    } else {
      clearTimer();
      if ($('timer')) $('timer').textContent = '00:00:00';
    }
    var conf = $('confBanner');
    if (conf) conf.classList.toggle('hidden', !NorthstarTelephony.getState().pendingConference);
    var bp = $('btnPlaceCall');
    if (bp) {
      bp.disabled = false;
      if (has) {
        bp.textContent = 'End';
        bp.classList.add('red');
      } else {
        bp.textContent = 'Call';
        bp.classList.remove('red');
      }
    }

    setCallControlsEnabled(has);
    renderTeam();
  }

  function callPrefs() {
    try {
      return NorthstarTelephony.getSettings ? NorthstarTelephony.getSettings() : {};
    } catch (_e) {
      return {};
    }
  }

  function stopInboundAlerts() {
    if (inboundRingTimer) {
      clearInterval(inboundRingTimer);
      inboundRingTimer = null;
    }
    if (inboundDesktopNotice && typeof inboundDesktopNotice.close === 'function') {
      try {
        inboundDesktopNotice.close();
      } catch (_e2) {}
    }
    inboundDesktopNotice = null;
  }

  function playRingerBurst() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
      if (!inboundAudioCtx) inboundAudioCtx = new Ctx();
      var ctx = inboundAudioCtx;
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') ctx.resume();
      var now = ctx.currentTime;
      var o1 = ctx.createOscillator();
      var o2 = ctx.createOscillator();
      var g = ctx.createGain();
      o1.type = 'sine';
      o2.type = 'sine';
      o1.frequency.setValueAtTime(880, now);
      o2.frequency.setValueAtTime(660, now);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.03, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
      o1.connect(g);
      o2.connect(g);
      g.connect(ctx.destination);
      o1.start(now);
      o2.start(now + 0.03);
      o1.stop(now + 0.5);
      o2.stop(now + 0.5);
    } catch (_e) {}
  }

  function maybeStartInboundRinger() {
    var prefs = callPrefs();
    if (!prefs.incomingRing) return;
    if (inboundRingTimer) return;
    playRingerBurst();
    inboundRingTimer = setInterval(playRingerBurst, 1700);
  }

  function maybeNotifyInbound(offer) {
    var prefs = callPrefs();
    if (!prefs.desktopNotifications) return;
    if (typeof Notification === 'undefined') return;
    var title = (offer && offer.name) ? offer.name : 'Incoming call';
    var body = (offer && offer.from) ? String(offer.from) : 'Tap to answer in Northstar';
    if (Notification.permission === 'granted') {
      try {
        inboundDesktopNotice = new Notification(title, { body: body, tag: 'northstar-inbound-call' });
      } catch (_e) {}
      return;
    }
    if (Notification.permission === 'default') {
      Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') return;
        try {
          inboundDesktopNotice = new Notification(title, { body: body, tag: 'northstar-inbound-call' });
        } catch (_e) {}
      }).catch(function () {});
    }
  }

  function setVoiceChipState(kind, label, title) {
    var el = $('voiceHealthChip');
    if (!el) return;
    el.classList.remove('voice-chip--ok', 'voice-chip--recover', 'voice-chip--err', 'voice-chip--idle');
    el.classList.add(
      kind === 'ok'
        ? 'voice-chip--ok'
        : kind === 'recover'
        ? 'voice-chip--recover'
        : kind === 'err'
        ? 'voice-chip--err'
        : 'voice-chip--idle'
    );
    el.textContent = label || 'Voice: checking…';
    if (title) el.setAttribute('title', title);
  }

  function updateVoiceHealthChip(providerPayload) {
    var p = providerPayload || {};
    var mode = String(p.mode || '');
    var err = p.error || p.warning || '';
    if (err) {
      setVoiceChipState('err', 'Voice: issue', String(err));
      return;
    }
    if (p.tokenWillExpire || p.recovery || mode === 'twilio-ready') {
      setVoiceChipState('recover', 'Voice: reconnecting', 'Refreshing phone connection');
      return;
    }
    if (mode === 'twilio-registered') {
      var edgeHint = p.edge ? ' · Edge: ' + p.edge : '';
      setVoiceChipState('ok', 'Voice: ready', 'Ready to place and receive calls' + edgeHint);
      return;
    }
    if (mode.indexOf('twilio') === 0) {
      setVoiceChipState('recover', 'Voice: connecting', 'Connecting voice services');
      return;
    }
    setVoiceChipState('idle', 'Voice: checking…', 'Voice status pending');
  }

  function answerIncoming() {
    stopInboundAlerts();
    inboundOffer = null;
    if (NorthstarTelephony && typeof NorthstarTelephony.answerIncoming === 'function') {
      NorthstarTelephony.answerIncoming();
    }
    syncCallUi();
  }

  function declineIncoming() {
    stopInboundAlerts();
    inboundOffer = null;
    if (NorthstarTelephony && typeof NorthstarTelephony.declineIncoming === 'function') {
      NorthstarTelephony.declineIncoming();
    }
    syncCallUi();
  }

  function formatPhone(d) {
    var d2 = String(d || '').replace(/\D/g, '');
    if (d2.length === 11 && d2[0] === '1') {
      return '(' + d2.slice(1, 4) + ') ' + d2.slice(4, 7) + '-' + d2.slice(7);
    }
    if (d2.length === 10) return '(' + d2.slice(0, 3) + ') ' + d2.slice(3, 6) + '-' + d2.slice(6);
    return d || '';
  }

  function initials(name) {
    var s = String(name || '').trim();
    if (!s) return '●';
    return s.split(/\s+/).map(function (n) { return n[0]; }).join('').slice(0, 2).toUpperCase();
  }

  function selectLead(contactId) {
    activeLeadId = contactId;
    var rows = getLeadRows();
    var l = rows.filter(function (r) {
      return r.id === contactId;
    })[0];
    if (l) {
      if ($('cAv')) $('cAv').textContent = initials(l.name);
      if ($('cName')) $('cName').textContent = l.biz;
      if ($('cSub'))
        $('cSub').textContent = l.name + ' · ' + l.phone + ' · ' + (l.city || 'San Antonio, TX');
      setDialInput(String(l.phone || '').replace(/\D/g, ''));
    }
    renderLeads();
  }

  function filterLeads(v) {
    renderLeads(v);
    var chips = $('leadCategoryChips');
    if (chips) {
      var f = String(v || 'all');
      chips.querySelectorAll('.cat-chip').forEach(function (btn) {
        var on = (btn.getAttribute('data-cat') || '') === f;
        btn.classList.toggle('on', on);
      });
    }
    var sel = $('leadVertFilter');
    if (sel && String(sel.value) !== String(v || 'all')) sel.value = v || 'all';
  }

  function placeCall() {
    var raw = getDialInput();
    var lead = currentLead();
    var meta = {};
    if (lead && raw.replace(/\D/g, '') === String(lead.phone || '').replace(/\D/g, '')) {
      meta.name = lead.biz;
      meta.contactName = lead.name;
    }

    if (typeof NorthstarTelephony.ensureVoiceReady === 'function') {
      NorthstarTelephony.ensureVoiceReady(AGENT.id)
        .then(function () {
          NorthstarTelephony.dial(raw, meta);
        })
        .catch(function (err) {
          console.error('[Northstar dialer] Voice not ready:', err);
          var detail =
            typeof NorthstarTelephony.formatError === 'function'
              ? NorthstarTelephony.formatError(err)
              : err && err.message
                ? err.message
                : String(err);
          alert(
            'Voice could not start: ' +
              detail +
              '\n\nAllow microphone access if prompted, then try again.'
          );
        });
      return;
    }

    NorthstarTelephony.dial(raw, meta);
  }

  function placeOrEndCall() {
    var st = NorthstarTelephony.getState();
    if (st && st.activeCall) {
      hangup();
      return;
    }
    placeCall();
  }

  function hangup() {
    NorthstarTelephony.hangup();
  }

  function logDispo(type) {
    var notesEl = $('notes');
    var notes = notesEl ? notesEl.value.trim() : '';
    var st = NorthstarTelephony.getState();
    var dur = st.activeCall ? Math.round((Date.now() - st.activeCall.started) / 1000) : 0;
    var lead = currentLead();
    if (!lead) {
      alert('No lead selected. Pick a contact in the lead queue (CRM list) or add contacts in Admin → CRM.');
      return;
    }
    var stageMap = {
      'Appointment Booked': 'Appointment set',
      'Sale closed': 'Won',
      'Callback Scheduled': 'Working',
      'Not Interested': 'Lost',
      'No Answer': 'Working',
      'Voicemail Left': 'Working',
      'Wrong Number': 'Lost',
    };
    var stage = stageMap[type] || 'Working';
    var upsertPayload = {
      business: lead.biz,
      name: lead.name,
      phone: lead.phone,
      city: lead.city || 'San Antonio, TX',
      vertical: lead.vert,
      stage: stage,
      lastOutcome: type,
    };
    if (lead.contactId) upsertPayload.id = lead.contactId;
    if (typeof NorthstarCRM !== 'undefined' && typeof NorthstarCRM.listContacts === 'function' && lead.contactId) {
      var owned = NorthstarCRM.listContacts().filter(function (c) {
        return String(c.id) === String(lead.contactId);
      })[0];
      if (owned) {
        if (owned.assignedAgentId) upsertPayload.assignedAgentId = owned.assignedAgentId;
        if (owned.assignedAgentName) upsertPayload.assignedAgentName = owned.assignedAgentName;
      }
    }
    if (!upsertPayload.assignedAgentId && AGENT && AGENT.id) {
      upsertPayload.assignedAgentId = AGENT.id;
      upsertPayload.assignedAgentName = AGENT.name || AGENT.id;
    }
    var r = NorthstarCRM.upsertContact(upsertPayload);
    var resolvedContactId = (r && r.contact && r.contact.id) || lead.contactId || null;
    var activityRes = NorthstarCRM.logActivity({
      type: 'call',
      agentId: AGENT.id,
      agentName: AGENT.name,
      contactId: resolvedContactId,
      business: lead.biz,
      vertical: lead.vert,
      disposition: type,
      notes: notes,
      durationSec: dur,
      recording: !!(st.activeCall && st.activeCall.recording),
    });
    // Always move operator focus to the next lead right away.
    advanceLeadQueueAfterDisposition(lead.id);
    if (!lead.listItemId) {
      // CRM fallback rows (no list_item_id) behave like archived in this session after disposition.
      var fallbackId = String(resolvedContactId || lead.contactId || lead.id || '');
      if (fallbackId) archivedFallbackLeadIds[fallbackId] = true;
    }
    refreshTodayStatsFromCrm();
    NorthstarTelephony.hangup();
    if (notesEl) notesEl.value = '';
    syncCallUi();
    renderLeads();

    writeDispositionForQueueItem(
      lead,
      resolvedContactId,
      activityRes && activityRes.activity ? activityRes.activity.id : null,
      type,
      notes,
      dur,
      !!(st.activeCall && st.activeCall.recording),
      st && st.activeCall ? st.activeCall.twilioSid || null : null
    )
      .then(function () {
        return refreshDailyCallQueue();
      })
      .then(function () {
        refreshTodayStatsFromCrm();
        renderLeads();
        syncCallUi();
      })
      .catch(function (err) {
        console.error('[Northstar dialer] disposition save failed', err);
        var msg = err && err.message ? err.message : String(err);
        try {
          alert('Could not save disposition: ' + msg);
        } catch (_e) {}
        return refreshDailyCallQueue().then(renderLeads);
      });
  }

  function toggleMute() { NorthstarTelephony.toggleMute(); syncCallUi(); }
  function toggleHold() { NorthstarTelephony.toggleHold(); syncCallUi(); }

  function toggleRec() {
    Promise.resolve(NorthstarTelephony.toggleRecord()).then(function () {
      syncCallUi();
    });
  }

  function dialPadPress(k) {
    var cur = getDialInput();
    setDialInput(cur + k);
    var st = NorthstarTelephony.getState();
    if (st.activeCall) NorthstarTelephony.sendDtmf(k);
  }

  function dialPadDel() {
    var cur = getDialInput();
    setDialInput(cur.slice(0, -1));
  }

  function setPresenceSel(sel) {
    NorthstarTelephony.setPresence(sel.value);
    var v = sel.value;
    var dot = $('sd');
    if (!dot) return;
    dot.className = 'dot ' + (v === 'available' || v === 'busy' ? 'g' : v === 'dnd' ? 'r' : 'gr');
  }

  /** Tab visibility: class .hidden alone is unreliable with flex/grid; force display. */
  function showPanel(name, el) {
    document.querySelectorAll('.sidebar .ni').forEach(function (n) {
      n.classList.remove('on');
      n.removeAttribute('aria-current');
    });
    if (el) {
      el.classList.add('on');
      el.setAttribute('aria-current', 'page');
    }

    var phone = document.getElementById('panel-phone');
    var wrap = document.getElementById('panel-wrap');
    var ms = document.querySelector('.main-stack');
    if (ms) ms.classList.toggle('main-stack--subview', name !== 'phone');

    var tabIds = ['inbox', 'messages', 'contacts', 'history', 'apps', 'settings', 'crm'];

    if (name === 'phone') {
      if (phone) {
        phone.classList.remove('hidden');
        phone.style.display = 'grid';
      }
      if (wrap) {
        wrap.classList.add('hidden');
        wrap.style.display = 'none';
      }
      tabIds.forEach(function (p) {
        var node = document.getElementById('panel-' + p);
        if (node) {
          node.style.display = 'none';
          node.classList.add('hidden');
        }
      });
      return;
    }

    if (phone) {
      phone.classList.add('hidden');
      phone.style.display = 'none';
    }
    if (wrap) {
      wrap.classList.remove('hidden');
      wrap.style.display = 'block';
    }

    tabIds.forEach(function (p) {
      var node = document.getElementById('panel-' + p);
      if (!node) return;
      var on = (p === name);
      node.classList.toggle('hidden', !on);
      node.style.display = on ? 'block' : 'none';
    });

    fillAuxPanel(name);
  }

  /**
   * Attach listeners directly on each control (not document delegation).
   * Safari/WebKit often sets click.target to a Text node inside the button — handlers
   * bound on the `<button>` still receive the event with currentTarget === button.
   */
  var directUiWired = false;
  function wireDirectUi() {
    if (directUiWired) return;
    directUiWired = true;

    document.querySelectorAll('.sidebar button[data-panel]').forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        var id = btn.getAttribute('data-panel');
        if (id) showPanel(id, btn);
      });
    });

    document.querySelectorAll('button.dial-key[data-digit]').forEach(function (key) {
      key.addEventListener('click', function (ev) {
        ev.preventDefault();
        var d = key.getAttribute('data-digit');
        if (d != null && d !== '') dialPadPress(d);
      });
    });

    var pc = $('btnPlaceCall');
    if (pc) {
      pc.addEventListener('click', function (ev) {
        ev.preventDefault();
        placeOrEndCall();
      });
    }
    var del = $('btnDialDel');
    if (del) {
      del.addEventListener('click', function (ev) {
        ev.preventDefault();
        dialPadDel();
      });
    }
  }

  function bindSidebarTabs() {
    wireDirectUi();
  }

  function fillAuxPanel(name) {
    if (name === 'inbox') {
      if (typeof NorthstarInbox !== 'undefined' && NorthstarInbox.refresh) {
        NorthstarInbox.refresh().then(renderInbox).catch(renderInbox);
      } else {
        renderInbox();
      }
    }
    if (name === 'messages') {
      if (typeof NorthstarSms !== 'undefined' && NorthstarSms.refresh) {
        NorthstarSms.refresh().then(renderMessages).catch(renderMessages);
      } else {
        renderMessages();
      }
    }
    if (name === 'contacts') {
      var cChain = Promise.resolve();
      if (
        typeof NorthstarCRM !== 'undefined' &&
        NorthstarCRM.isRemoteEnabled &&
        NorthstarCRM.isRemoteEnabled() &&
        typeof NorthstarCRM.syncFromRemote === 'function'
      ) {
        cChain = NorthstarCRM.syncFromRemote().catch(function (err) {
          console.warn('[Northstar dialer] CRM refresh for Directory & CRM tab', err);
        });
      }
      cChain.then(renderContacts).catch(renderContacts);
    }
    if (name === 'history') renderHistory();
    if (name === 'apps') {
      var chain = Promise.resolve();
      if (
        typeof NorthstarCRM !== 'undefined' &&
        NorthstarCRM.isRemoteEnabled &&
        NorthstarCRM.isRemoteEnabled() &&
        typeof NorthstarCRM.syncFromRemote === 'function'
      ) {
        chain = NorthstarCRM.syncFromRemote().catch(function (err) {
          console.warn('[Northstar dialer] CRM refresh for Apps tab', err);
        });
      }
      chain = chain.then(function () {
        if (typeof NorthstarApps !== 'undefined' && NorthstarApps.refresh) {
          return NorthstarApps.refresh();
        }
      });
      chain.then(renderApps).catch(renderApps);
    }
    if (name === 'settings') {
      if (
        typeof NorthstarAuth !== 'undefined' &&
        typeof NorthstarAuth.refreshProfile === 'function'
      ) {
        NorthstarAuth.refreshProfile()
          .then(function () {
            syncAgentFromAuth();
            renderSettings();
          })
          .catch(renderSettings);
      } else {
        renderSettings();
      }
    }
    if (name === 'crm') renderCrmSync();
  }

  function isVoiceAlreadyRegistered() {
    if (typeof NorthstarTelephony.isVoiceRegistered === 'function') {
      return NorthstarTelephony.isVoiceRegistered();
    }
    var p =
      typeof NorthstarTelephony.getProviderStatus === 'function'
        ? NorthstarTelephony.getProviderStatus()
        : null;
    return !!(p && p.twilioDeviceRegistered && p.mode === 'twilio-registered');
  }

  function kickVoiceReady(reason) {
    if (
      typeof NorthstarTelephony === 'undefined' ||
      typeof NorthstarTelephony.ensureVoiceReady !== 'function'
    ) {
      return;
    }
    if (typeof NorthstarTelephony.isCallActive === 'function' && NorthstarTelephony.isCallActive()) {
      return;
    }
    if (isVoiceAlreadyRegistered()) {
      return;
    }
    NorthstarTelephony.ensureVoiceReady(AGENT.id).catch(function (err) {
      console.warn(
        '[Northstar dialer] voice recovery (' + reason + ')',
        err && err.message ? err.message : err
      );
    });
  }

  function startVoiceKeepAlive() {
    if (voiceKeepAliveTimer) clearInterval(voiceKeepAliveTimer);
    voiceKeepAliveTimer = null;
    /** Token refresh is handled by Twilio tokenWillExpire — no 4-min polling (it caused re-register loops). */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) kickVoiceReady('tab-visible');
    });
    window.addEventListener('focus', function () {
      kickVoiceReady('window-focus');
    });
  }

  function renderCrmSync() {
    var db = NorthstarCRM.load();
    var remote = typeof NorthstarCRM.getRemoteStatus === 'function'
      ? NorthstarCRM.getRemoteStatus()
      : { enabled: false };
    var remoteSummary = remote.enabled
      ? ('Cloud CRM connected' + (remote.lastSyncAt ? ' · Last sync ' + fmtTime(remote.lastSyncAt) : ''))
      : 'Offline / demo mode';
    $('panel-crm').innerHTML =
      '<div class="panel panel-page-layout"><div class="sec-hd">Northstar CRM</div><p class="hint">Contacts and outcomes sync when you’re online. Dispositions save to your shared CRM.</p>' +
      '<p style="font-size:11px;color:#6b7280;margin-top:8px">Status: ' + esc(remoteSummary) + '</p>' +
      '<p style="font-size:11px;color:#6b7280;margin-top:4px">Local cache updated: ' + esc((db.meta && db.meta.updatedAt) || '—') + '</p>' +
      '<button type="button" class="qbtn" style="margin-top:10px;width:auto" onclick="NSDialer.syncCrmNow()">Refresh</button>' +
      '<div id="crmAct2" class="list-scroll" style="margin-top:12px"></div></div>';
    var acts = NorthstarCRM.listActivities(20);
    $('crmAct2').innerHTML = acts.map(function (a) {
      return '<div class="act-row">' + fmtTime(a.createdAt) + ' · ' + esc(a.disposition || '') + ' — ' + esc(a.business) + '</div>';
    }).join('') || '<p class="hint">No activity.</p>';
  }

  function inboxVmRows() {
    var useCloudInbox =
      typeof NorthstarInbox !== 'undefined' &&
      NorthstarInbox.isRemoteEnabled &&
      NorthstarInbox.isRemoteEnabled() &&
      typeof NorthstarInbox.getVoicemails === 'function';
    /** When Supabase is configured, show only cloud rows — never fall back to browser demo VM in telephony-layer (localStorage). */
    if (useCloudInbox) {
      return NorthstarInbox.getVoicemails();
    }
    return typeof NorthstarTelephony.getVoicemails === 'function' ? NorthstarTelephony.getVoicemails() : [];
  }

  function inboxMissedRows() {
    if (
      typeof NorthstarInbox !== 'undefined' &&
      NorthstarInbox.isRemoteEnabled &&
      NorthstarInbox.isRemoteEnabled() &&
      typeof NorthstarInbox.getMissedCalls === 'function'
    ) {
      return NorthstarInbox.getMissedCalls();
    }
    return [];
  }

  function renderInbox() {
    var vm = inboxVmRows();
    var missed = inboxMissedRows();
    var hintVm =
      typeof NorthstarInbox !== 'undefined' && NorthstarInbox.isRemoteEnabled && NorthstarInbox.isRemoteEnabled()
        ? 'Voicemail appears here once your phone system saves messages for you. Nothing shows until messages exist for your line.'
        : 'Demo voicemail below is stored only in this browser until cloud inbox is enabled for your account.';
    $('panel-inbox').innerHTML =
      '<div class="panel"><div class="sec-hd">Voicemail</div><p class="hint">' +
      hintVm +
      '</p><div id="vmList" class="list-scroll"></div></div>' +
      '<div class="panel"><div class="sec-hd">Missed calls</div><p class="hint" style="font-size:11px;margin-bottom:8px">Inbound calls you didn’t answer, declined, or when the caller hung up—including return calls from contacts. Use Call back to dial from the phone panel.</p><div id="missList" class="list-scroll"></div></div>';
    $('vmList').innerHTML = vm.map(function (v) {
      var vid = esc(v.id);
      return '<div class="inbox-row">' +
        '<div class="dot ' +
        (v.unread ? 'r' : 'gr') +
        '" style="margin-top:4px"></div>' +
        '<div style="flex:1">' +
        '<div style="font-size:13px;font-weight:500">' +
        esc(v.name || v.from) +
        '</div>' +
        '<div class="vm-meta">' +
        esc(v.from) +
        ' · ' +
        fmtTime(v.receivedAt) +
        ' · ' +
        v.durationSec +
        's</div>' +
        (v.transcript ? '<div class="hint">' + esc(v.transcript) + '</div>' : '') +
        '<div class="vm-actions">' +
        '<button type="button">▶ Play</button>' +
        '<button type="button" onclick="NSDialer.inboxMarkRead(\'' +
        vid +
        '\')">Mark read</button>' +
        '<button type="button" onclick="NSDialer.inboxDeleteVm(\'' +
        vid +
        '\')">Delete</button>' +
        '</div></div></div>';
    }).join('') || '<p class="hint">No voicemail.</p>';

    $('missList').innerHTML = missed.map(function (m) {
      var digits = String(m.num || '').replace(/\D/g, '');
      return (
        '<div class="inbox-row"><div style="flex:1"><strong>' +
        esc(m.name) +
        '</strong><div class="vm-meta">' +
        esc(m.num) +
        ' · ' +
        fmtTime(m.missedAt) +
        (m.queueLabel ? ' · ' + esc(m.queueLabel) : '') +
        '</div></div><button type="button" class="db blu" style="font-size:10px;padding:4px 8px;width:auto" onclick="NSDialer.missedCallbackDial(' +
        JSON.stringify(digits) +
        ',' +
        JSON.stringify(m.name || '') +
        ')">Call back</button></div>'
      );
    }).join('') || '<p class="hint">No missed calls.</p>';
  }

  function refreshInbox() {
    if (typeof NorthstarInbox !== 'undefined' && NorthstarInbox.refresh) {
      NorthstarInbox.refresh()
        .then(renderInbox)
        .catch(renderInbox);
    } else {
      renderInbox();
    }
  }

  function inboxMarkRead(id) {
    if (
      typeof NorthstarInbox !== 'undefined' &&
      NorthstarInbox.isRemoteEnabled &&
      NorthstarInbox.isRemoteEnabled() &&
      NorthstarInbox.setVoicemailRead
    ) {
      NorthstarInbox.setVoicemailRead(id, false).then(renderInbox);
    } else {
      NorthstarTelephony.setVoicemailRead(id, false);
      renderInbox();
    }
  }

  function inboxDeleteVm(id) {
    if (
      typeof NorthstarInbox !== 'undefined' &&
      NorthstarInbox.isRemoteEnabled &&
      NorthstarInbox.isRemoteEnabled() &&
      NorthstarInbox.deleteVoicemail
    ) {
      NorthstarInbox.deleteVoicemail(id).then(renderInbox);
    } else {
      NorthstarTelephony.deleteVoicemail(id);
      renderInbox();
    }
  }

  function missedCallbackDial(digits, label) {
    applyContactDial(digits, label || 'Missed call');
  }

  /** SMS list is DB-backed only (no seeded demo threads in production). */
  function smsThreadsForUi() {
    if (
      typeof NorthstarSms !== 'undefined' &&
      NorthstarSms.isRemoteEnabled &&
      NorthstarSms.isRemoteEnabled() &&
      typeof NorthstarSms.getThreads === 'function'
    ) {
      return NorthstarSms.getThreads();
    }
    return [];
  }

  function renderMessages() {
    var cloud =
      typeof NorthstarSms !== 'undefined' &&
      NorthstarSms.isRemoteEnabled &&
      NorthstarSms.isRemoteEnabled();
    var threads = smsThreadsForUi();
    var topHint = cloud
      ? 'Text threads update live when messaging is enabled for your account.'
      : 'SMS is not configured for this workspace yet. Ask your administrator if texting should appear here.';
    var emptyBlock =
      '<div style="margin:14px 0;padding:14px;border:1px dashed rgba(0,0,0,0.12);border-radius:8px;background:rgba(0,0,0,0.02)">' +
      (cloud
        ? '<p class="hint" style="margin:0 0 8px"><strong>No SMS threads yet.</strong></p>' +
          '<p class="hint" style="margin:0 0 8px">That is normal for a new inbox: nothing is shown until there is stored data for this agent.</p>' +
          '<p class="hint" style="margin:0">Your administrator connects business texting to this inbox. Outbound texts may require customer consent rules your company follows.</p>'
        : '<p class="hint" style="margin:0 0 8px"><strong>No SMS data available.</strong></p>' +
          '<p class="hint" style="margin:0">Reload after your administrator enables messaging for this app.</p>') +
      '</div>';
    var threadsHtml = threads
      .map(function (t) {
        var hd =
          esc(t.peerName || 'Unknown') +
          (t.phone ? ' · ' + esc(t.phone) : '');
        var prefix = t.fromYou ? 'You: ' : 'Them: ';
        return (
          '<div class="thread"><div class="thread-hd">' +
          hd +
          '</div><div class="thread-msg">' +
          prefix +
          esc(t.preview || '') +
          '</div></div>'
        );
      })
      .join('');
    if (!threadsHtml) {
      threadsHtml = emptyBlock;
    }
    $('panel-messages').innerHTML =
      '<div class="panel"><div class="sec-hd">SMS threads</div><p class="hint">' +
      topHint +
      '</p>' +
      '<div class="list-scroll">' +
      threadsHtml +
      '</div>' +
      '<textarea style="margin-top:12px;min-height:48px" placeholder="Type a message…"></textarea>' +
      '<p class="hint" style="margin-top:8px;font-size:11px">Sending texts from here may require your administrator to finish setup and comply with texting laws.</p>' +
      '<div style="margin-top:8px"><button type="button" class="btn-call" style="padding:8px 14px" onclick="alert(\'Send SMS will be available once your administrator completes messaging setup.\')">Send</button></div></div>';
  }

  function renderContacts() {
    var contacts = typeof NorthstarCRM.listContacts !== 'function' ? [] : NorthstarCRM.listContacts();
    $('panel-contacts').innerHTML =
      '<div class="panel panel-page-layout"><div class="sec-hd">CRM contacts</div><p class="hint" style="margin-top:0">Only contacts you own in the company database (by user id or owner name). If this looks wrong, use <strong>CRM sync</strong> in the sidebar, and in Admin ensure each lead’s owner/assignment is correct or remove the row.</p><div id="crmContactsGrid" class="list-scroll"></div></div>';

    $('crmContactsGrid').innerHTML = contacts.map(function (c) {
      var d = String(c.phone || '').replace(/\D/g, '');
      var vert = normalizeLeadCategory(c.vertical);
      var tagCls = categoryTagClass(c.vertical);
      return (
        '<div class="crm-row" onclick="NSDialer.applyContactDial(\'' +
        esc(d) +
        "','" +
        esc(c.business) +
        "','" +
        esc(c.id) +
        '\')"><h4>' +
        esc(c.business) +
        ' <span class="tag ' +
        esc(tagCls) +
        '" style="font-size:10px;font-weight:600">' +
        esc(vert) +
        '</span></h4><p>' +
        esc(c.name) +
        ' · ' +
        esc(c.phone) +
        '</p></div>'
      );
    }).join('') || '<p class="hint">No contacts assigned to you yet. Your manager assigns leads when importing or editing CRM.</p>';
  }

  /** Prefer selecting the daily-queue row so dispositions hit list_item_id + contact_id. */
  function applyContactDial(digits, biz, contactId) {
    var norm = String(digits || '').replace(/\D/g, '');
    setDialInput(norm);
    showPanel('phone', document.querySelector('.ni[data-panel=\"phone\"]'));
    var rows = getLeadRows();
    var match = null;
    if (contactId) {
      match =
        rows.filter(function (r) {
          return r.contactId && String(r.contactId) === String(contactId);
        })[0] || null;
    }
    if (!match && norm) {
      match =
        rows.filter(function (r) {
          return String(r.phone || '').replace(/\D/g, '') === norm;
        })[0] || null;
    }
    if (match) {
      selectLead(match.id);
      return;
    }
    if ($('cAv')) $('cAv').textContent = initials('');
    if ($('cName')) $('cName').textContent = biz || '';
    if ($('cSub')) $('cSub').textContent = norm ? formatPhone(norm) : '';
  }

  function directoryDial(ext) {
    setDialInput(ext);
    showPanel('phone', document.querySelector('.ni[data-panel=\"phone\"]'));
  }

  function renderHistory() {
    var tel = NorthstarTelephony.getCallHistory(40);
    var crm = NorthstarCRM.listActivities(30);
    $('panel-history').innerHTML =
      '<div class="panel"><div class="sec-hd">Call log</div><p class="hint">Recent calls placed from this browser.</p><div id="histTel" class="list-scroll"></div></div>' +
      '<div class="panel"><div class="sec-hd">CRM outcomes</div><div id="histCrm" class="list-scroll"></div></div>';

    $('histTel').innerHTML = tel.map(function (h) {
      return '<div class="act-row"><strong>' + esc(h.direction) + '</strong> · ' + esc(h.number) + (h.name ? ' · ' + esc(h.name) : '') +
        '<br/><span style="color:#6b7280">' + fmtTime(h.startedAt) + (h.durationSec != null ? ' · ' + h.durationSec + 's' : '') + '</span></div>';
    }).join('') || '<p class="hint">No entries.</p>';

    var crmMine = crm.filter(function (a) {
      return !a.agentId || a.agentId === AGENT.id;
    });
    $('histCrm').innerHTML = crmMine.map(function (a) {
      return '<div class="act-row">' + fmtTime(a.createdAt) + ' — ' + esc(a.disposition || '') + ' · ' + esc(a.business) + '</div>';
    }).join('') || '<p class="hint">No CRM activities for your seat.</p>';
  }

  function renderApps() {
    var apps = appsUiSettings();
    var scriptBody;
    if (apps.remote) {
      if (String(apps.openerScript || '').trim()) {
        scriptBody =
          '<p style="font-size:12px;line-height:1.5;white-space:pre-wrap">' +
          esc(String(apps.openerScript).trim()) +
          '</p>';
      } else {
        scriptBody =
          '<p class="hint">No opener script has been assigned to you yet. Ask your manager to add one in Admin.</p>';
      }
    } else {
      scriptBody =
        '<p class="hint">Connect this app to your company account in Admin to load your assigned script.</p>';
    }

    var earnHint =
      apps.remote
        ? '<p class="hint" style="font-size:11px;margin-top:10px">Bonus amounts come from settings your administrator maintains.</p>'
        : '<p class="hint" style="font-size:11px;margin-top:10px">Earnings totals appear when your workspace is connected to the server.</p>';

    $('panel-apps').innerHTML =
      '<div class="panel"><div class="sec-hd">Scripts</div>' +
      scriptBody +
      '</div>' +
      '<div class="panel"><div class="sec-hd">Callbacks</div><p class="hint" style="font-size:11px;margin-bottom:8px">Follow-ups with disposition “Callback scheduled”.</p><div id="cbList2" class="list-scroll"></div></div>' +
      '<div class="panel"><div class="sec-hd">My earnings</div><div class="sg"><div class="sc"><div class="sv">' +
      formatUsd0(apps.apptBonusUsd) +
      '</div><div class="sl">Appt bonuses</div></div><div class="sc"><div class="sv">' +
      formatUsd0(apps.closeCommissionUsd) +
      '</div><div class="sl">Close commission</div></div></div>' +
      earnHint +
      '</div>' +
      '<div class="panel"><div class="sec-hd">Lists & power dial</div><button type="button" class="qbtn" onclick="document.getElementById(\'leadCsv\').click()">+ Upload lead CSV</button>' +
      '<button type="button" class="qbtn" onclick="alert(\'Power dial is turned on by your administrator in the phone system settings.\')">⚡ Power dial mode</button>' +
      '<p class="hint" style="font-size:11px;margin-top:10px">Uploaded CSV files stay in this browser until your company enables shared lead uploads.</p></div>';

    var cb = NorthstarCRM.listActivities(500).filter(function (a) {
      return a.agentId === AGENT.id && String(a.disposition || '') === 'Callback Scheduled';
    });
    $('cbList2').innerHTML = cb
      .map(function (a) {
        return (
          '<div class="crm-row"><h4>' +
          esc(a.business) +
          '</h4><p>' +
          esc(a.vertical) +
          '</p></div>'
        );
      })
      .join('') || '<p class="hint">No callbacks scheduled in CRM for this agent.</p>';
  }

  function renderSettings() {
    var prof = typeof NorthstarAuth !== 'undefined' && NorthstarAuth.getProfile ? NorthstarAuth.getProfile() : null;
    var usr = typeof NorthstarAuth !== 'undefined' && NorthstarAuth.getUser ? NorthstarAuth.getUser() : null;
    var accountPanel =
      usr || prof
        ? '<div class="panel"><div class="sec-hd">Account & seat</div>' +
          '<p class="hint" style="margin-bottom:10px">Your extension and numbers are assigned in Admin and linked to this login.</p>' +
          '<div class="settings-grid">' +
          '<div class="set-row"><label>Signed in as</label><span style="font-size:13px">' +
          esc((usr && usr.email) || '') +
          '</span></div>' +
          '<div class="set-row"><label>Softphone ID</label><span style="font-size:13px;font-family:ui-monospace,monospace">' +
          esc((prof && prof.twilio_client_identity) || '— not assigned —') +
          '</span></div>' +
          '<div class="set-row"><label>SMS number</label><span style="font-size:13px;font-family:ui-monospace,monospace">' +
          esc((prof && prof.sms_number_e164) || '—') +
          '</span></div>' +
          '<div class="set-row"><label>Extension</label><span style="font-size:13px">' +
          esc((prof && prof.extension) || AGENT.extension || '—') +
          '</span></div>' +
          '<div class="set-row"><label>Voice region</label><span style="font-size:13px">' +
          esc((prof && prof.voice_edge) || AGENT.voiceEdge || 'auto') +
          '</span></div>' +
          '</div>' +
          (AGENT.pendingSeat && (!prof || !prof.twilio_client_identity)
            ? '<p class="hint" style="margin-top:10px;color:#b45309"><strong>Seat not fully linked.</strong> Ask your administrator to finish your phone setup in Admin so calling and stats work correctly.</p>'
            : '') +
          '<button type="button" class="qbtn" style="margin-top:12px;width:auto" onclick="NorthstarAuth.signOut()">Sign out</button></div>'
        : '';

    var s = NorthstarTelephony.getSettings();
    var voiceEdgeVal =
      typeof NorthstarTelephony.getVoiceEdgePreference === 'function'
        ? NorthstarTelephony.getVoiceEdgePreference()
        : s.voiceEdge || 'auto';
    $('panel-settings').innerHTML =
      accountPanel +
      '<motion class="panel"><div class="sec-hd">Voice network</div><div class="settings-grid">' +
      '<div class="set-row"><label>Region</label><select id="setVoiceEdge">' +
      '<option value="auto">Auto — closest to you (recommended overseas)</option>' +
      '<option value="us-first">US first — overseas rep calling US customers</option>' +
      '<option value="apac">Asia-Pacific (Singapore + Sydney)</option>' +
      '<option value="us">United States (East + West)</option>' +
      '<option value="eu">Europe (Dublin + Frankfurt)</option>' +
      '<option value="singapore">Singapore only</option>' +
      '</select></div></div>' +
      '<p class="hint">If you are overseas but dial US leads all day, try <strong>US first</strong>. Use wired internet, turn off VPN, and stay on this tab during calls. Hard refresh after changing region.</p></div>' +
      '<div class="panel"><div class="sec-hd">Audio devices</div><div class="settings-grid">' +
      '<div class="set-row"><label>Microphone</label><select id="setMic"><option value="">System default</option></select></div>' +
      '<div class="set-row"><label>Speaker / ringer</label><select id="setSpk"><option value="">System default</option></select></div></div>' +
      '<p class="hint">Pick your headset mic and speaker here. Wrong device is a common cause of “they can’t hear me” on calls.</p></div>' +
      '<div class="panel"><div class="sec-hd">Incoming calls</div>' +
      '<div class="switch-row"><span>Desktop notifications</span><input type="checkbox" id="setDesk" ' + (s.desktopNotifications ? 'checked' : '') + '/></div>' +
      '<div class="switch-row"><span>Ring this browser</span><input type="checkbox" id="setRing" ' + (s.incomingRing ? 'checked' : '') + '/></div>' +
      '<div class="switch-row"><span>Simultaneous ring — mobile</span><input type="checkbox" id="setSim" ' + (s.simultaneousRing ? 'checked' : '') + '/></div>' +
      '<div class="set-row" style="margin-top:10px"><label>Mobile / PSTN simultaneous ring</label><input id="setMob" type="tel" placeholder="+1…" value="' + esc(s.mobileNumber || '') + '" /></div>' +
      '</div>' +
      '<div class="panel"><div class="sec-hd">Call forwarding</div>' +
      '<div class="switch-row"><span>Forward all calls</span><input type="checkbox" id="setFwd" ' + (s.forwardAlways ? 'checked' : '') + '/></div>' +
      '<div class="set-row"><label>Forward to</label><input id="setFwdNum" type="tel" value="' + esc(s.forwardNumber || '') + '" /></div>' +
      '</div>' +
      '<div class="panel"><div class="sec-hd">Do not disturb</div>' +
      '<div class="switch-row"><span>Business-hours DND</span><input type="checkbox" id="setDndS" ' + (s.dndSchedule ? 'checked' : '') + '/></div>' +
      '<div class="settings-grid"><div class="set-row"><label>From</label><input id="setDndF" type="time" value="' + esc(s.dndFrom || '') + '" /></div>' +
      '<div class="set-row"><label>To</label><input id="setDndT" type="time" value="' + esc(s.dndTo || '') + '" /></div></div>' +
      '<button type="button" class="qbtn" style="margin-top:12px;width:auto" onclick="NSDialer.saveSettingsFromDom()">Save preferences</button></div>';

    populateAudioDeviceSelects(s.micId, s.speakerId);
    var ve = $('setVoiceEdge');
    if (ve) ve.value = voiceEdgeVal;
  }

  function populateAudioDeviceSelects(selectedMicId, selectedSpkId) {
    var micEl = $('setMic');
    var spkEl = $('setSpk');
    if (!micEl || !spkEl) return;
    micEl.innerHTML = '<option value="">System default</option>';
    spkEl.innerHTML = '<option value="">System default</option>';
    if (typeof NorthstarTelephony.listAudioDevices !== 'function') {
      if (selectedMicId) micEl.value = selectedMicId;
      if (selectedSpkId) spkEl.value = selectedSpkId;
      return;
    }
    NorthstarTelephony.listAudioDevices()
      .then(function (devs) {
        (devs.inputs || []).forEach(function (d) {
          var o = document.createElement('option');
          o.value = d.id;
          o.textContent = d.label;
          micEl.appendChild(o);
        });
        (devs.outputs || []).forEach(function (d) {
          var o = document.createElement('option');
          o.value = d.id;
          o.textContent = d.label;
          spkEl.appendChild(o);
        });
        if (selectedMicId) micEl.value = selectedMicId;
        if (selectedSpkId) spkEl.value = selectedSpkId;
      })
      .catch(function () {});
  }

  function saveSettingsFromDom() {
    var voiceEdge = ($('setVoiceEdge') && $('setVoiceEdge').value) || 'auto';
    NorthstarTelephony.saveSettings({
      voiceEdge: voiceEdge,
      micId: ($('setMic') && $('setMic').value) || '',
      speakerId: ($('setSpk') && $('setSpk').value) || '',
      desktopNotifications: $('setDesk').checked,
      incomingRing: $('setRing').checked,
      simultaneousRing: $('setSim').checked,
      mobileNumber: $('setMob').value.trim(),
      forwardAlways: $('setFwd').checked,
      forwardNumber: $('setFwdNum').value.trim(),
      dndSchedule: $('setDndS').checked,
      dndFrom: $('setDndF').value,
      dndTo: $('setDndT').value,
    });
    if (typeof NorthstarTelephony.setVoiceEdgePreference === 'function') {
      NorthstarTelephony.setVoiceEdgePreference(voiceEdge);
    }
    if ($('setDesk').checked && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(function () {});
    }
    alert('Preferences saved. Hard refresh (Cmd+Shift+R) to apply a voice region change.');
  }

  function syncCrmNow() {
    if (typeof NorthstarCRM.syncFromRemote === 'function' && typeof NorthstarCRM.isRemoteEnabled === 'function' && NorthstarCRM.isRemoteEnabled()) {
      NorthstarCRM.syncFromRemote()
        .then(function () {
          renderCrmSync();
          refreshTodayStatsFromCrm();
          renderTeam();
          renderLeads();
          if (typeof NorthstarApps !== 'undefined' && NorthstarApps.refresh) {
            return NorthstarApps.refresh();
          }
        })
        .then(function () {
          renderApps();
          alert('CRM synced.');
        })
        .catch(function (error) {
          alert('Could not sync CRM: ' + (error && error.message ? error.message : String(error)));
        });
      return;
    }
    NorthstarCRM.seedDemo();
    renderLeads();
    alert('CRM is running in local demo mode.');
  }

  function openTransfer(kind) {
    var others = getRosterForHud().filter(function (m) {
      return !isCurrentAgentRosterEntry(m) && String(m.ext || '').length > 0;
    });
    var rosterHelp =
      others.length > 0
        ? '\n\nTeammates:\n' +
          others
            .map(function (m, i) {
              return (i + 1) + '. ' + m.name + ' — ext ' + m.ext;
            })
            .join('\n')
        : '\n\n(No teammates listed — ask Admin to add users.)';
    var dest = prompt(
      (kind === 'blind' ? 'Blind transfer' : 'Warm transfer') +
        ' — enter phone number or extension.' +
        rosterHelp,
    );
    if (!dest || !String(dest).trim()) return;
    dest = String(dest).trim();
    if (kind === 'warm' && typeof NorthstarTelephony.setHold === 'function') {
      NorthstarTelephony.setHold(true);
    }
    Promise.resolve(NorthstarTelephony.transferBlind(dest))
      .then(function () {
        syncCallUi();
      })
      .catch(function () {
        if (kind === 'warm' && typeof NorthstarTelephony.setHold === 'function') {
          NorthstarTelephony.setHold(false);
        }
        syncCallUi();
      });
  }

  function toggleDtmfPanel() {
    dtmfOpen = !dtmfOpen;
    var el = $('dtmfPanel');
    if (!el) return;
    if (dtmfOpen) {
      el.classList.remove('hidden');
      el.style.removeProperty('display');
    } else {
      el.classList.add('hidden');
      el.style.setProperty('display', 'none', 'important');
    }
  }

  function finishDialerInit() {
    var ext = '102';
    var displayName = AGENT.name;
    var avTxt = AGENT.initials;
    if (typeof NorthstarTeamRoster !== 'undefined' && NorthstarTeamRoster.getMembers) {
      var selfRow = NorthstarTeamRoster.getMembers().filter(function (m) {
        return isCurrentAgentRosterEntry(m);
      })[0];
      if (selfRow) {
        if (selfRow.ext) ext = String(selfRow.ext);
        if (selfRow.name) displayName = selfRow.name;
        if (selfRow.av) avTxt = selfRow.av;
      }
    }

    NorthstarTelephony.init({ extension: ext, userName: displayName });

    var un = $('userName');
    if (un) un.textContent = displayName;
    var ua = $('userAv');
    if (ua) ua.textContent = avTxt;

    if (typeof NorthstarTelephony.fetchTwilioAccessToken === 'function') {
      NorthstarTelephony.fetchTwilioAccessToken(AGENT.id).catch(function (error) {
        console.warn('[Northstar dialer] Voice token not ready:', error && error.message ? error.message : error);
      });
    }
    startVoiceKeepAlive();
    if (typeof NorthstarTelephony.getProviderStatus === 'function') {
      updateVoiceHealthChip(NorthstarTelephony.getProviderStatus());
    }

    var extEl = $('extDisplay');
    if (extEl) extEl.textContent = NorthstarTelephony.getState().extension || '102';

    var pres = $('agentPresence');
    if (pres) {
      NorthstarTelephony.getPresenceList().forEach(function () {});
      pres.innerHTML = NorthstarTelephony.getPresenceList().map(function (p) {
        return '<option value="' + esc(p.id) + '"' + (p.id === 'available' ? ' selected' : '') + '>' + esc(p.label) + '</option>';
      }).join('');
      pres.addEventListener('change', function () {
        setPresenceSel(pres);
      });
    }

    var lineSel = $('lineSel');
    if (lineSel) {
      lineSel.addEventListener('change', function () {
        NorthstarTelephony.setLine(lineSel.value);
      });
    }

    var cid = $('callerIdSel');
    if (cid) {
      cid.innerHTML = NorthstarTelephony.getCallerIds().map(function (n, i) {
        return '<option value="' + i + '">' + esc(formatPhone(n)) + '</option>';
      }).join('');
      cid.onchange = function () {
        NorthstarTelephony.setCallerIdIndex(parseInt(cid.value, 10));
      };
    }
    refreshAssignedOutboundLines();
    refreshDailyCallQueue().then(renderLeads).catch(function () {});
    bindDailyCallQueueRealtime();
    bindCrmDataRealtime();

    NorthstarTelephony.subscribe(function (ev) {
      if (ev.type === 'call') {
        if (ev.payload && ev.payload.phase === 'ringing') {
          inboundOffer = {
            name: ev.payload.name || 'Inbound caller',
            from: ev.payload.from || '',
          };
          maybeStartInboundRinger();
          maybeNotifyInbound(inboundOffer);
        } else if (ev.payload && (ev.payload.phase === 'connected' || ev.payload.phase === 'idle')) {
          inboundOffer = null;
          stopInboundAlerts();
          if (
            typeof NorthstarTelephony.getProviderStatus === 'function'
          ) {
            updateVoiceHealthChip(NorthstarTelephony.getProviderStatus());
          }
        } else if (ev.payload && ev.payload.phase === 'quality-warning') {
          if (
            typeof NorthstarTelephony.isCallActive === 'function' &&
            !NorthstarTelephony.isCallActive()
          ) {
            return;
          }
          var wn = String(ev.payload.name || 'network');
          if (wn === 'constant-audio-input-level' || wn === 'constantAudioInputLevel') {
            return;
          }
          voiceQualityWarningCount++;
          var hint =
            wn === 'low-mos'
              ? 'Choppy audio — use wired internet, close VPN, and stay on this tab during the call.'
              : wn === 'high-packets-lost-fraction' || wn === 'high-rtt'
              ? 'Network dropping voice packets — use ethernet (not Wi‑Fi), turn off VPN, and stay on this tab. Overseas reps calling US: try Settings → Voice region → US first.'
              : 'Check your internet or headset mic.';
          setVoiceChipState('recover', 'Voice: quality issue', wn + ': ' + hint);
        } else if (ev.payload && ev.payload.phase === 'quality-warning-cleared') {
          voiceQualityWarningCount = Math.max(0, voiceQualityWarningCount - 1);
          if (voiceQualityWarningCount === 0 && typeof NorthstarTelephony.getProviderStatus === 'function') {
            updateVoiceHealthChip(NorthstarTelephony.getProviderStatus());
          }
        }
        if (typeof NorthstarLiveOps !== 'undefined') {
          var telSt = NorthstarTelephony.getState();
          if (ev.payload.phase === 'connected' && ev.payload.call) {
            NorthstarLiveOps.sessionStart(ev.payload.call, {
              agentId: AGENT.id,
              agentName: AGENT.name,
              extension: telSt.extension || '',
            });
          } else if (ev.payload.phase === 'idle') {
            NorthstarLiveOps.sessionEnd();
          }
        }
        syncCallUi();
      }
      if (ev.type === 'park' || ev.type === 'transfer' || ev.type === 'conference') syncCallUi();
      if (ev.type === 'presence') syncCallUi();
      if (ev.type === 'provider') updateVoiceHealthChip(ev.payload || {});
      if (ev.type === 'error') {
        setVoiceChipState('err', 'Voice: issue', (ev.payload && ev.payload.message) || 'Voice error');
      }
    });

    var gs = $('globalSearch');
    if (gs) {
      gs.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var q = gs.value.trim();
          if (q) {
            setDialInput(q.replace(/\D/g, ''));
            showPanel('phone', document.querySelector('.ni[data-panel=\"phone\"]'));
          }
        }
      });
    }

    var bn = $('btnNotif');
    if (bn) {
      bn.onclick = function () {
        alert('Notifications center — voicemail, mentions, SLA breaches.');
      };
    }

    var so = $('btnSignOut');
    if (
      so &&
      typeof NorthstarAuth !== 'undefined' &&
      NorthstarAuth.requireAuthEnabled &&
      NorthstarAuth.requireAuthEnabled() &&
      typeof NorthstarAuth.signOut === 'function'
    ) {
      so.style.display = '';
      so.onclick = function () {
        NorthstarAuth.signOut();
      };
    }

    if (typeof NorthstarTeamRoster !== 'undefined' && NorthstarTeamRoster.subscribe) {
      NorthstarTeamRoster.subscribe(function () {
        renderTeam();
        refreshTodayStatsFromCrm();
        refreshAssignedOutboundLines();
        bindOutboundLinesRealtime();
        refreshDailyCallQueue().then(renderLeads).catch(function () {});
        bindDailyCallQueueRealtime();
        try {
          renderContacts();
        } catch (x) {}
      });
    }

    var firstLeads = getLeadRows();
    if (!activeLeadId && firstLeads.length) activeLeadId = firstLeads[0].id;
    renderLeads();
    renderTeam();
    refreshTodayStatsFromCrm();

    var lead = currentLead();
    if (lead && lead.phone) setDialInput(String(lead.phone).replace(/\D/g, ''));

    syncCallUi();

    if (!crmVisibilityRefreshInstalled) {
      crmVisibilityRefreshInstalled = true;
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'visible') return;
        if (
          typeof NorthstarCRM === 'undefined' ||
          typeof NorthstarCRM.syncFromRemote !== 'function' ||
          typeof NorthstarCRM.isRemoteEnabled !== 'function' ||
          !NorthstarCRM.isRemoteEnabled()
        ) {
          return;
        }
        if (crmForegroundDebounceTimer) clearTimeout(crmForegroundDebounceTimer);
        crmForegroundDebounceTimer = setTimeout(function () {
          NorthstarCRM.syncFromRemote()
            .then(function () {
              try {
                refreshTodayStatsFromCrm();
                renderTeam();
                renderLeads();
                renderContacts();
                renderCrmSync();
                renderHistory();
              } catch (x) {}
            })
            .catch(function () {});
        }, 600);
      });
    }
  }

  function init() {
    var crmChain = Promise.resolve();
    if (typeof NorthstarCRM.initialize === 'function') {
      crmChain = NorthstarCRM.initialize()
        .then(function (status) {
          if (!status.enabled) NorthstarCRM.seedDemo();
        })
        .catch(function () {
          NorthstarCRM.seedDemo();
        });
    } else {
      NorthstarCRM.seedDemo();
    }

    crmChain
      .then(function () {
        if (typeof NorthstarTeamRoster !== 'undefined' && NorthstarTeamRoster.initialize) {
          return NorthstarTeamRoster.initialize();
        }
      })
      .then(function () {
        syncAgentFromAuth();
      })
      .then(function () {
        /** CRM.initialize runs before the signed-in seat is applied; second sync aligns cache with Supabase so an empty DB clears stale localStorage (otherwise Lead queue keeps dozens of ghost leads). */
        if (
          typeof NorthstarCRM.syncFromRemote === 'function' &&
          typeof NorthstarCRM.isRemoteEnabled === 'function' &&
          NorthstarCRM.isRemoteEnabled()
        ) {
          return NorthstarCRM.syncFromRemote().catch(function (e) {
            console.warn('[Northstar dialer] CRM re-sync after seat', e);
          });
        }
      })
      .then(function () {
        return refreshDailyCallQueue();
      })
      .then(function () {
        bindOutboundLinesRealtime();
        bindDailyCallQueueRealtime();
      })
      .then(function () {
        if (typeof NorthstarInbox !== 'undefined' && NorthstarInbox.configure) {
          NorthstarInbox.configure(AGENT.id);
        }
        if (
          !inboxRealtimeBound &&
          typeof NorthstarInbox !== 'undefined' &&
          NorthstarInbox.subscribe
        ) {
          inboxRealtimeBound = true;
          NorthstarInbox.subscribe(function () {
            try {
              renderInbox();
            } catch (x) {}
          });
        }
        if (typeof NorthstarInbox !== 'undefined' && NorthstarInbox.initialize) {
          return NorthstarInbox.initialize(AGENT.id).catch(function (err) {
            console.warn('[Northstar dialer] inbox', err);
          });
        }
      })
      .then(function () {
        if (typeof NorthstarSms !== 'undefined' && NorthstarSms.configure) {
          NorthstarSms.configure(AGENT.id);
        }
        if (
          !smsRealtimeBound &&
          typeof NorthstarSms !== 'undefined' &&
          NorthstarSms.subscribe
        ) {
          smsRealtimeBound = true;
          NorthstarSms.subscribe(function () {
            try {
              renderMessages();
            } catch (x) {}
          });
        }
        if (typeof NorthstarSms !== 'undefined' && NorthstarSms.initialize) {
          return NorthstarSms.initialize(AGENT.id).catch(function (err) {
            console.warn('[Northstar dialer] sms', err);
          });
        }
      })
      .then(function () {
        if (typeof NorthstarApps !== 'undefined' && NorthstarApps.configure) {
          NorthstarApps.configure(AGENT.id);
        }
        if (typeof NorthstarApps !== 'undefined' && NorthstarApps.initialize) {
          return NorthstarApps.initialize(AGENT.id).catch(function (err) {
            console.warn('[Northstar dialer] apps', err);
          });
        }
      })
      .then(function () {
        finishDialerInit();
      })
      .catch(function (e) {
        console.warn('[Northstar dialer] init', e);
        finishDialerInit();
      });
  }

  global.NSDialer = {
    init: init,
    filterLeads: filterLeads,
    showPanel: showPanel,
    bindSidebarTabs: bindSidebarTabs,
    wireDirectUi: wireDirectUi,
    dialPadPress: dialPadPress,
    dialPadDel: dialPadDel,
    placeCall: placeCall,
    hangup: hangup,
    toggleMute: toggleMute,
    toggleHold: toggleHold,
    toggleRec: toggleRec,
    logDispo: logDispo,
    setPresenceSel: setPresenceSel,
    syncCrmNow: syncCrmNow,
    openTransfer: openTransfer,
    conferenceAdd: function () { NorthstarTelephony.conferenceAddCall(); syncCallUi(); },
    mergeCalls: function () { NorthstarTelephony.mergeCalls(); syncCallUi(); },
    flip: function () {
      Promise.resolve(NorthstarTelephony.flip()).then(function () {
        syncCallUi();
      });
    },
    parkCall: function () { NorthstarTelephony.park(); syncCallUi(); },
    toggleDtmfPanel: toggleDtmfPanel,
    refreshInbox: refreshInbox,
    inboxMarkRead: inboxMarkRead,
    inboxDeleteVm: inboxDeleteVm,
    missedCallbackDial: missedCallbackDial,
    applyContactDial: applyContactDial,
    selectLead: selectLead,
    directoryDial: directoryDial,
    saveSettingsFromDom: saveSettingsFromDom,
    refreshTodayStatsFromCrm: refreshTodayStatsFromCrm,
    answerIncoming: answerIncoming,
    declineIncoming: declineIncoming,
  };

  /** Runs init whether DOMContentLoaded already fired or not (avoids missed registration). */
  function onDomReady(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  var appBooted = false;

  function showLoginGate() {
    var g = $('authGate');
    if (g) g.style.display = 'flex';
  }

  function hideLoginGate() {
    var g = $('authGate');
    if (g) g.style.display = 'none';
  }

  function wireLoginForm() {
    var btn = $('authSubmit');
    var err = $('authErr');
    var form = $('authForm');
    if (!btn) return;
    function runLogin() {
      var em = $('authEmail');
      var pw = $('authPass');
      if (err) err.textContent = '';
      btn.disabled = true;
      btn.textContent = 'Signing in…';
      if (typeof NorthstarAuth === 'undefined' || !NorthstarAuth.signInWithPassword) {
        if (err) err.textContent = 'Auth module not loaded. Refresh and try again.';
        btn.disabled = false;
        btn.textContent = 'Sign in';
        return;
      }
      var watchdog = setTimeout(function () {
        if (err && !err.textContent) {
          err.textContent = 'Sign-in took too long. Retry once.';
        }
        btn.disabled = false;
        btn.textContent = 'Sign in';
      }, 20000);
      NorthstarAuth.signInWithPassword((em && em.value) || '', (pw && pw.value) || '')
        .then(function () {
          syncAgentFromAuth();
          hideLoginGate();
          if (!appBooted) {
            appBooted = true;
            try {
              init();
            } catch (e) {
              console.error('[Northstar dialer]', e);
            }
          }
        })
        .catch(function (e) {
          var msg = e && e.message ? e.message : String(e);
          if (err) err.textContent = msg;
          // If auth succeeded but UI flow errored, recover by checking current user.
          try {
            var u = typeof NorthstarAuth !== 'undefined' && NorthstarAuth.getUser ? NorthstarAuth.getUser() : null;
            if (u && u.id) {
              syncAgentFromAuth();
              hideLoginGate();
              if (!appBooted) {
                appBooted = true;
                init();
              }
            }
          } catch (_e) {}
        })
        .finally(function () {
          clearTimeout(watchdog);
          btn.disabled = false;
          btn.textContent = 'Sign in';
        });
    }
    btn.onclick = function () {
      runLogin();
    };
    if (form) {
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        runLogin();
      });
    }
  }

  function boot() {
    wireDirectUi();
    wireLoginForm();

    var needAuth =
      typeof NorthstarAuth !== 'undefined' &&
      NorthstarAuth.requireAuthEnabled &&
      NorthstarAuth.requireAuthEnabled();

    if (!needAuth) {
      if (appBooted) return;
      appBooted = true;
      try {
        init();
      } catch (err) {
        console.error('[Northstar dialer]', err);
      }
      return;
    }

    if (typeof NorthstarAuth.initializeSession !== 'function') {
      showLoginGate();
      return;
    }

    showLoginGate();

    function bindDialerAuthListener() {
      if (bindDialerAuthListener.done) return;
      if (typeof NorthstarAuth.attachAuthListener !== 'function') return;
      bindDialerAuthListener.done = true;
      NorthstarAuth.attachAuthListener(function (seat) {
        if (seat) {
          applySeat(seat);
          hideLoginGate();
          if (!appBooted) {
            appBooted = true;
            try {
              init();
            } catch (e) {
              console.error('[Northstar dialer]', e);
            }
          }
        }
        try {
          refreshAssignedOutboundLines();
          bindOutboundLinesRealtime();
          refreshDailyCallQueue().then(renderLeads).catch(function () {});
          bindDailyCallQueueRealtime();
          syncCallUi();
          refreshTodayStatsFromCrm();
          renderTeam();
          renderLeads();
          renderContacts();
        } catch (x) {}
      });
    }

    NorthstarAuth.initializeSession()
      .then(function (ctx) {
        if (ctx && ctx.seat) applySeat(ctx.seat);
        if (!ctx || !ctx.session) {
          showLoginGate();
          return;
        }
        hideLoginGate();
        if (appBooted) return;
        appBooted = true;
        try {
          init();
        } catch (err) {
          console.error('[Northstar dialer]', err);
        }
      })
      .catch(function (e) {
        console.warn('[NorthstarAuth]', e);
        showLoginGate();
      })
      .finally(function () {
        bindDialerAuthListener();
      });
  }
  onDomReady(boot);
})(typeof window !== 'undefined' ? window : this);
