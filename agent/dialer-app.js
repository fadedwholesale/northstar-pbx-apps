/* global NorthstarCRM, NorthstarTelephony */
(function (global) {
  var AGENT = { id: 'agent_jd', name: 'James D.', initials: 'JD' };
  var leads = [
    { biz: "Mike's Pro Detailing", name: 'Mike Pena', phone: '(210) 555-0182', vert: 'Detailing', tag: 'td', active: true },
    { biz: 'SA Luxury Detail', name: 'Alex Torres', phone: '(210) 555-0241', vert: 'Detailing', tag: 'td', active: false },
    { biz: 'El Rancho Grill', name: 'Rosa M.', phone: '(210) 555-0319', vert: 'Restaurant', tag: 'tr', active: false },
    { biz: '78255 Plumbing', name: 'Dan K.', phone: '(210) 555-0488', vert: 'Contractor', tag: 'tc', active: false },
    { biz: 'Southside Roofing', name: 'Phil R.', phone: '(210) 555-0562', vert: 'Contractor', tag: 'tc', active: false },
    { biz: 'Prestige Shine Co.', name: 'Lena V.', phone: '(210) 555-0614', vert: 'Detailing', tag: 'td', active: false },
    { biz: 'Taco Fiesta SA', name: 'Omar G.', phone: '(210) 555-0733', vert: 'Restaurant', tag: 'tr', active: false },
  ];
  var team = [
    { av: 'JD', name: 'James D.', status: 'g', statusTxt: 'On call', dials: 39, appts: 2, pct: 72 },
    { av: 'SR', name: 'Sara R.', status: 'g', statusTxt: 'Available', dials: 52, appts: 5, pct: 91, bg: '#ecfdf5', col: '#065f46' },
    { av: 'MC', name: 'Marcus C.', status: 'a', statusTxt: 'On break', dials: 29, appts: 1, pct: 38, bg: '#fffbeb', col: '#b45309' },
    { av: 'TL', name: 'Tanya L.', status: 'gr', statusTxt: 'Offline', dials: 0, appts: 0, pct: 0, bg: '#f3f4f6', col: '#9ca3af' },
  ];

  var activeLeadIdx = 0;
  var timerInt = null;
  var dtmfOpen = false;
  var notifCount = 2;

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

  function currentLead() { return leads[activeLeadIdx]; }

  function getDialInput() {
    return ($('dialInput') && $('dialInput').value) || '';
  }

  function setDialInput(v) {
    if ($('dialInput')) $('dialInput').value = v;
  }

  function renderLeads(filter) {
    var ll = $('leadList');
    if (!ll) return;
    ll.innerHTML = '';
    leads.forEach(function (l, i) {
      if (filter && filter !== 'all' && l.vert !== filter) return;
      var d = document.createElement('div');
      d.className = 'lc' + (l.active ? ' active' : '');
      d.innerHTML = '<div class="lt"><span class="ln">' + esc(l.biz) + '</span><span class="tag ' + l.tag + '">' + esc(l.vert) + '</span></div><div class="tp">' + esc(l.name) + '</div><div class="tph">' + esc(l.phone) + '</div>';
      d.onclick = function () { selectLead(i); };
      ll.appendChild(d);
    });
  }

  function renderTeam() {
    var tl = $('teamList');
    if (!tl) return;
    tl.innerHTML = '';
    team.forEach(function (a) {
      var bg = a.bg || '#eff6ff';
      var col = a.col || '#2563eb';
      tl.innerHTML += '<div class="ar"><div class="av" style="width:28px;height:28px;font-size:10px;background:' + bg + ';color:' + col + '">' + esc(a.av) + '</div><div class="ai"><div class="an">' + esc(a.name) + ' <span style="font-size:10px;color:' + (a.status === 'g' ? '#22c55e' : a.status === 'a' ? '#f59e0b' : '#9ca3af') + '">● ' + esc(a.statusTxt) + '</span></div><div class="as">' + a.dials + ' dials · ' + a.appts + ' appts</div><div class="pb"><div class="pf" style="width:' + a.pct + '%"></div></div></div></div>';
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
    var idleEl = $('idleCall');
    var actEl = $('activeCallCard');
    if (idleEl) idleEl.classList.toggle('hidden', has);
    if (actEl) actEl.classList.toggle('hidden', !has);
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
      var sub = (lead ? lead.name + ' · ' : '') + formatPhone(c.digits) + (lead ? ' · San Antonio, TX' : '');
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
    if (bp) bp.disabled = false;
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
    return name.split(/\s+/).map(function (n) { return n[0]; }).join('').slice(0, 2).toUpperCase();
  }

  function selectLead(i) {
    leads.forEach(function (l) { l.active = false; });
    leads[i].active = true;
    activeLeadIdx = i;
    var l = leads[i];
    if ($('cAv')) $('cAv').textContent = initials(l.name);
    if ($('cName')) $('cName').textContent = l.biz;
    if ($('cSub')) $('cSub').textContent = l.name + ' · ' + l.phone + ' · San Antonio, TX';
    var digits = l.phone.replace(/\D/g, '');
    setDialInput(digits);
    renderLeads();
  }

  function filterLeads(v) { renderLeads(v); }

  function placeCall() {
    var raw = getDialInput();
    var lead = currentLead();
    var meta = {};
    if (lead && raw.replace(/\D/g, '') === lead.phone.replace(/\D/g, '')) {
      meta.name = lead.biz;
      meta.contactName = lead.name;
    }
    NorthstarTelephony.dial(raw, meta);
    if ($('sDials')) $('sDials').textContent = parseInt($('sDials').textContent, 10) + 1;
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
    var stageMap = {
      'Appointment Booked': 'Appointment set',
      'Callback Scheduled': 'Working',
      'Not Interested': 'Lost',
    };
    var stage = stageMap[type] || 'Working';
    var r = NorthstarCRM.upsertContact({
      business: lead.biz,
      name: lead.name,
      phone: lead.phone,
      city: 'San Antonio, TX',
      vertical: lead.vert,
      stage: stage,
      lastOutcome: type,
    });
    NorthstarCRM.logActivity({
      type: 'call',
      agentId: AGENT.id,
      agentName: AGENT.name,
      contactId: r.contact.id,
      business: lead.biz,
      vertical: lead.vert,
      disposition: type,
      notes: notes,
      durationSec: dur,
      recording: !!(st.activeCall && st.activeCall.recording),
    });
    if (type === 'Appointment Booked' && $('sAppts')) {
      $('sAppts').textContent = parseInt($('sAppts').textContent, 10) + 1;
    }
    NorthstarTelephony.hangup();
    if (notesEl) notesEl.value = '';
    syncCallUi();
  }

  function toggleMute() { NorthstarTelephony.toggleMute(); syncCallUi(); }
  function toggleHold() { NorthstarTelephony.toggleHold(); syncCallUi(); }

  function toggleRec() {
    NorthstarTelephony.toggleRecord();
    syncCallUi();
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
        placeCall();
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
    if (name === 'inbox') renderInbox();
    if (name === 'messages') renderMessages();
    if (name === 'contacts') renderContacts();
    if (name === 'history') renderHistory();
    if (name === 'apps') renderApps();
    if (name === 'settings') renderSettings();
    if (name === 'crm') renderCrmSync();
  }

  function renderCrmSync() {
    var db = NorthstarCRM.load();
    $('panel-crm').innerHTML =
      '<div class="panel"><div class="sec-hd">Northstar CRM</div><p class="hint">Production: OAuth to your CRM API; webhooks on disposition.</p>' +
      '<p style="font-size:11px;color:#6b7280;margin-top:8px">Last sync: ' + esc((db.meta && db.meta.updatedAt) || '—') + '</p>' +
      '<button type="button" class="qbtn" style="margin-top:10px;width:auto" onclick="NSDialer.syncCrmNow()">Refresh</button>' +
      '<div id="crmAct2" style="margin-top:12px;max-height:280px;overflow:auto"></div></div>';
    var acts = NorthstarCRM.listActivities(20);
    $('crmAct2').innerHTML = acts.map(function (a) {
      return '<div class="act-row">' + fmtTime(a.createdAt) + ' · ' + esc(a.disposition || '') + ' — ' + esc(a.business) + '</div>';
    }).join('') || '<p class="hint">No activity.</p>';
  }

  function renderInbox() {
    var vm = NorthstarTelephony.getVoicemails();
    var missed = [
      { when: '11:42a', num: '(210) 555-0900', name: 'Inbound queue', missed: true },
      { when: 'Yesterday', num: '(210) 555-0443', name: 'SA Luxury Detail', missed: true },
    ];
    $('panel-inbox').innerHTML =
      '<div class="panel"><div class="sec-hd">Voicemail</div><p class="hint">Wire to Twilio Voicemail API / Recording URLs or carrier VM. Playback uses signed media URLs.</p><div id="vmList"></div></div>' +
      '<div class="panel"><div class="sec-hd">Missed calls</div><div id="missList"></div></div>';
    $('vmList').innerHTML = vm.map(function (v) {
      return '<div class="inbox-row">' +
        '<div class="dot ' + (v.unread ? 'r' : 'gr') + '" style="margin-top:4px"></div>' +
        '<div style="flex:1">' +
        '<div style="font-size:13px;font-weight:500">' + esc(v.name || v.from) + '</div>' +
        '<div class="vm-meta">' + esc(v.from) + ' · ' + fmtTime(v.receivedAt) + ' · ' + v.durationSec + 's</div>' +
        (v.transcript ? '<div class="hint">' + esc(v.transcript) + '</div>' : '') +
        '<div class="vm-actions">' +
        '<button type="button">▶ Play</button>' +
        '<button type="button" onclick="NorthstarTelephony.setVoicemailRead(\'' + v.id + '\',false); NSDialer.refreshInbox()">Mark read</button>' +
        '<button type="button" onclick="NorthstarTelephony.deleteVoicemail(\'' + v.id + '\'); NSDialer.refreshInbox()">Delete</button>' +
        '</div></div></div>';
    }).join('') || '<p class="hint">No voicemail.</p>';

    $('missList').innerHTML = missed.map(function (m) {
      return '<div class="inbox-row"><div style="flex:1"><strong>' + esc(m.name) + '</strong><div class="vm-meta">' + esc(m.num) + ' · ' + esc(m.when) + '</div></div><button type="button" class="db blu" style="font-size:10px;padding:4px 8px;width:auto">Call back</button></div>';
    }).join('');
  }

  function refreshInbox() { renderInbox(); }

  function renderMessages() {
    $('panel-messages').innerHTML =
      '<div class="panel"><div class="sec-hd">SMS threads</div><p class="hint">Connect Bandwidth / Twilio messaging / RingCentral SMS API. Compose requires TCPA-compliant opt-in records.</p>' +
      '<div class="thread"><div class="thread-hd">Mike Pena · (210) 555-0182</div><div class="thread-msg">You: Following up on the booking window we discussed.</div></div>' +
      '<div class="thread"><div class="thread-hd">Dispatch — SA Luxury</div><div class="thread-msg">Them: Can you call after 3pm?</div></div>' +
      '<textarea style="margin-top:12px;min-height:48px" placeholder="Type a message…"></textarea>' +
      '<div style="margin-top:8px"><button type="button" class="btn-call" style="padding:8px 14px" onclick="alert(\'Send SMS via provider API\')">Send</button></div></div>';
  }

  function renderContacts() {
    var contacts = NorthstarCRM.listContacts();
    $('panel-contacts').innerHTML =
      '<div class="panel"><div class="sec-hd">CRM contacts</div><div id="crmContactsGrid"></div></div>' +
      '<div class="panel"><div class="sec-hd">Company directory</div><p class="hint">Sync from HR / Entra ID / SCIM. Quick dial uses telephony layer.</p>' +
      '<table class="data-table"><thead><tr><th>Name</th><th>Extension</th><th>Actions</th></tr></thead><tbody>' +
      '<tr><td>Sara R.</td><td class="mono">103</td><td><button type="button" class="db blu" style="font-size:10px;padding:4px 8px" onclick="NSDialer.directoryDial(\'103\')">Dial ext</button></td></tr>' +
      '<tr><td>Marcus C.</td><td class="mono">104</td><td><button type="button" class="db blu" style="font-size:10px;padding:4px 8px" onclick="NSDialer.directoryDial(\'104\')">Dial ext</button></td></tr>' +
      '</tbody></table></div>';

    $('crmContactsGrid').innerHTML = contacts.map(function (c) {
      return '<div class="crm-row" onclick="NSDialer.applyContactDial(\'' + esc(c.phone.replace(/\D/g, '')) + '\',\'' + esc(c.business) + '\')"><h4>' + esc(c.business) + '</h4><p>' + esc(c.name) + ' · ' + esc(c.phone) + '</p></div>';
    }).join('') || '<p class="hint">No CRM contacts.</p>';
  }

  function applyContactDial(digits, biz) {
    setDialInput(digits);
    showPanel('phone', document.querySelector('.ni[data-panel=\"phone\"]'));
    if ($('cName')) $('cName').textContent = biz;
  }

  function directoryDial(ext) {
    setDialInput(ext);
    showPanel('phone', document.querySelector('.ni[data-panel=\"phone\"]'));
  }

  function renderHistory() {
    var tel = NorthstarTelephony.getCallHistory(40);
    var crm = NorthstarCRM.listActivities(30);
    $('panel-history').innerHTML =
      '<div class="panel"><div class="sec-hd">Telephony call log</div><p class="hint">Written by <code>telephony-layer.js</code>; production should mirror CDR from carrier.</p><div id="histTel"></div></div>' +
      '<div class="panel"><div class="sec-hd">CRM outcomes</div><div id="histCrm"></div></div>';

    $('histTel').innerHTML = tel.map(function (h) {
      return '<div class="act-row"><strong>' + esc(h.direction) + '</strong> · ' + esc(h.number) + (h.name ? ' · ' + esc(h.name) : '') +
        '<br/><span style="color:#6b7280">' + fmtTime(h.startedAt) + (h.durationSec != null ? ' · ' + h.durationSec + 's' : '') + '</span></div>';
    }).join('') || '<p class="hint">No entries.</p>';

    $('histCrm').innerHTML = crm.map(function (a) {
      return '<div class="act-row">' + fmtTime(a.createdAt) + ' — ' + esc(a.disposition || '') + ' · ' + esc(a.business) + '</div>';
    }).join('') || '<p class="hint">No CRM activities.</p>';
  }

  function renderApps() {
    $('panel-apps').innerHTML =
      '<div class="panel"><div class="sec-hd">Scripts</div><p style="font-size:12px;line-height:1.5">Detailing opener: Hi, this is ' + esc(AGENT.name) + ' — are you taking new detail work this month?</p></div>' +
      '<div class="panel"><div class="sec-hd">Callbacks</div><div id="cbList2"></div></div>' +
      '<div class="panel"><div class="sec-hd">My earnings</div><div class="sg"><div class="sc"><div class="sv">$120</div><div class="sl">Appt bonuses</div></div><div class="sc"><div class="sv">$0</div><div class="sl">Close commission</div></div></div></div>' +
      '<div class="panel"><div class="sec-hd">Lists & power dial</div><button type="button" class="qbtn" onclick="document.getElementById(\'leadCsv\').click()">+ Upload lead CSV</button>' +
      '<button type="button" class="qbtn" onclick="alert(\'Power dial: sequential outbound with answering-machine detection — provider feature.\')">⚡ Power dial mode</button></div>';
    var cb = NorthstarCRM.listActivities(100).filter(function (a) { return a.disposition === 'Callback Scheduled'; });
    $('cbList2').innerHTML = cb.map(function (a) {
      return '<div class="crm-row"><h4>' + esc(a.business) + '</h4><p>' + esc(a.vertical) + '</p></div>';
    }).join('') || '<p class="hint">No callbacks.</p>';
  }

  function renderSettings() {
    var s = NorthstarTelephony.getSettings();
    $('panel-settings').innerHTML =
      '<div class="panel"><div class="sec-hd">Audio devices</div><div class="settings-grid">' +
      '<div class="set-row"><label>Microphone</label><select id="setMic"><option>System default</option><option>USB Headset</option></select></div>' +
      '<div class="set-row"><label>Speaker / ringer</label><select id="setSpk"><option>System default</option><option>USB Headset</option></select></div></div>' +
      '<p class="hint">Wire to <code>navigator.mediaDevices.enumerateDevices()</code> with user gesture.</p></div>' +
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

    $('setMic').value = s.micId ? 'USB Headset' : 'System default';
    $('setSpk').value = s.speakerId ? 'USB Headset' : 'System default';
  }

  function saveSettingsFromDom() {
    NorthstarTelephony.saveSettings({
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
    alert('Saved locally. Persist to user profile API in production.');
  }

  function syncCrmNow() {
    NorthstarCRM.seedDemo();
    alert('CRM sync: replace with REST call to your API.');
  }

  function openTransfer(kind) {
    var dest = prompt(kind === 'blind' ? 'Blind transfer to (number or ext)' : 'Warm transfer — consult destination');
    if (!dest) return;
    if (kind === 'blind') NorthstarTelephony.transferBlind(dest);
    else {
      NorthstarTelephony.transferWarmStart();
      alert('Consult leg would dial ' + dest + '. Complete warm transfer when ready.');
      NorthstarTelephony.transferWarmComplete();
    }
    syncCallUi();
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

  function init() {
    NorthstarCRM.seedDemo();
    NorthstarTelephony.init({ extension: '102', userName: AGENT.name });
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
        return '<option value="' + i + '">' + esc(n) + '</option>';
      }).join('');
      cid.onchange = function () { NorthstarTelephony.setCallerIdIndex(parseInt(cid.value, 10)); };
    }

    NorthstarTelephony.subscribe(function (ev) {
      if (ev.type === 'call' || ev.type === 'presence') syncCallUi();
    });

    var gs = $('globalSearch');
    if (gs) {
      gs.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          var q = gs.value.trim();
          if (q) { setDialInput(q.replace(/\D/g, '')); showPanel('phone', document.querySelector('.ni[data-panel=\"phone\"]')); }
        }
      });
    }

    var bn = $('btnNotif');
    if (bn) bn.onclick = function () { alert('Notifications center — voicemail, mentions, SLA breaches.'); };

    renderLeads();
    renderTeam();

    var lead = currentLead();
    setDialInput(lead.phone.replace(/\D/g, ''));

    syncCallUi();
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
    flip: function () { NorthstarTelephony.flip(); alert('Flip sends call to desk phone / mobile app pair.'); },
    parkCall: function () { NorthstarTelephony.park(); syncCallUi(); },
    toggleDtmfPanel: toggleDtmfPanel,
    refreshInbox: refreshInbox,
    applyContactDial: applyContactDial,
    directoryDial: directoryDial,
    saveSettingsFromDom: saveSettingsFromDom,
  };

  /** Runs init whether DOMContentLoaded already fired or not (avoids missed registration). */
  function onDomReady(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  var appBooted = false;
  function boot() {
    wireDirectUi();
    if (appBooted) return;
    appBooted = true;
    try {
      init();
    } catch (err) {
      console.error('[Northstar dialer]', err);
    }
  }
  onDomReady(boot);
})(typeof window !== 'undefined' ? window : this);
