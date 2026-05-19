/**
 * Northstar Telephony Layer — PBX-style API for production swap-in.
 *
 * Primary target: Twilio Programmable Voice + Twilio Voice JavaScript SDK
 * (token from your backend; Device.connect / Call objects).
 *
 * Alternatives: Telnyx WebRTC, Vonage, etc.
 *
 * Events: subscribe(handler) → { type, payload }
 */
(function (global) {
  var STORAGE_SETTINGS = 'northstar_telephony_settings_v1';
  var STORAGE_HISTORY = 'northstar_telephony_history_v1';
  var STORAGE_VM = 'northstar_telephony_vm_v1';

  function loadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return fallback;
  }

  function saveJson(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {}
  }

  /** Readable string for alerts/logging when err.message is missing. */
  function formatErr(err) {
    if (err == null) return 'Unknown error';
    if (typeof err === 'string') return err;
    var msg =
      err.message ||
      err.msg ||
      err.error_description ||
      (typeof err.reason === 'string' ? err.reason : '');
    if (!msg && typeof err.code !== 'undefined' && err.code !== null) {
      msg = 'Phone service error ' + String(err.code);
    }
    var code = err.code;
    var name = err.name;
    var parts = [];
    if (msg) parts.push(String(msg));
    else if (err.error && typeof err.error === 'string') parts.push(err.error);
    if (code != null && code !== '' && String(code) !== String(msg)) parts.push('code ' + code);
    if (name && name !== 'Error' && !parts.join(' ').includes(name)) parts.push(name);
    if (parts.length) return parts.join(' — ');
    try {
      var s = JSON.stringify(err);
      if (s && s !== '{}') return s;
    } catch (e) {}
    if (typeof err.toString === 'function') {
      var ts = err.toString();
      if (ts !== '[object Object]') return ts;
    }
    return 'Unknown error';
  }

  var state = {
    presence: 'available', // available | busy | dnd | invisible | offline
    lineId: 'line1',
    lines: [
      { id: 'line1', label: 'Main', number: '+1 (210) 791-6275', outbound: true },
      { id: 'line2', label: 'Detailing campaigns', number: '+1 (210) 555-0199', outbound: true },
    ],
    callerIdIndex: 0,
    session: null,
    /** @type {{ id:string, digits:string, name?:string, started:number, mute:boolean, hold:boolean, recording:boolean, conference:boolean, parkedSlot?:string } | null} */
    activeCall: null,
    pendingConference: false,
    /** @type {string | null} */
    twilioRecordingSid: null,
    provider: {
      mode: 'mock',
      twilioToken: null,
      twilioTokenFetchedAt: null,
      twilioLastError: null,
      twilioDeviceRegistered: false,
      twilioIdentity: null,
    },
    voiceEdgePreference: null,
    twilioDevice: null,
    twilioCall: null,
    twilioIncomingCall: null,
    inboundRinging: null,
    subscribers: [],
  };
  var reauthInFlight = null;
  /** Full re-register deferred until the active call ends (destroy/register would drop audio). */
  var pendingVoiceRefreshReason = null;
  var lastVoiceRefreshAt = 0;
  var lastUnregisterHandlerAt = 0;
  var lastRegisterAttemptAt = 0;
  var lastCallEndedAt = 0;
  var VOICE_REFRESH_COOLDOWN_MS = 120000;
  var REGISTER_ATTEMPT_COOLDOWN_MS = 120000;
  var POST_CALL_QUIET_MS = 20000;

  /** Warnings that fire when idle/silent — not actionable call-quality failures. */
  var IDLE_QUALITY_WARNING_NAMES = {
    'constant-audio-input-level': true,
    constantAudioInputLevel: true,
  };

  /**
   * Twilio edge presets. Default "auto" = roaming (closest edge to the rep).
   * Reps outside the US should use auto or apac (Singapore in logs is normal). US-only for US-based reps.
   */
  var VOICE_EDGE_PRESETS = {
    auto: 'roaming',
    roaming: 'roaming',
    us: ['ashburn', 'umatilla'],
    /** Optional: US media first when auto/apac still drops US outbound (may add latency outside US). */
    'us-first': ['ashburn', 'umatilla', 'singapore', 'sydney'],
    apac: ['singapore', 'sydney'],
    eu: ['dublin', 'frankfurt'],
    ashburn: 'ashburn',
    umatilla: 'umatilla',
    singapore: 'singapore',
    sydney: 'sydney',
    dublin: 'dublin',
    frankfurt: 'frankfurt',
    tokyo: 'tokyo',
  };

  function resolveVoiceEdges() {
    var raw = '';
    try {
      var prof = global.NorthstarAuth && NorthstarAuth.getProfile ? NorthstarAuth.getProfile() : null;
      if (prof && prof.voice_edge) raw = String(prof.voice_edge).trim().toLowerCase();
    } catch (_e) {}
    if (!raw && state.voiceEdgePreference) raw = String(state.voiceEdgePreference).trim().toLowerCase();
    if (!raw) raw = String(Telephony.getSettings().voiceEdge || 'auto').trim().toLowerCase();
    if (!raw || raw === 'auto') return 'roaming';
    if (VOICE_EDGE_PRESETS[raw]) return VOICE_EDGE_PRESETS[raw];
    if (raw.indexOf(',') !== -1) {
      return raw
        .split(',')
        .map(function (x) {
          return x.trim();
        })
        .filter(Boolean);
    }
    return raw;
  }

  function getVoiceDeviceOptions() {
    return {
      logLevel: 1,
      codecPreferences: ['opus', 'pcmu'],
      maxCallSignalingReconnectMs: 30000,
      edge: resolveVoiceEdges(),
    };
  }

  function hasActiveVoiceSession() {
    return !!(state.activeCall || state.twilioCall || state.twilioIncomingCall);
  }

  function getDeviceStateName() {
    if (!state.twilioDevice) return '';
    try {
      return String(state.twilioDevice.state || '').toLowerCase();
    } catch (_e) {
      return '';
    }
  }

  function isDeviceRegisteredWithTwilio() {
    var s = getDeviceStateName();
    return s === 'registered';
  }

  function syncProviderFromDeviceState() {
    if (isDeviceRegisteredWithTwilio()) {
      state.provider.twilioDeviceRegistered = true;
      state.provider.mode = 'twilio-registered';
      return true;
    }
    return false;
  }

  function flushPendingVoiceRefresh() {
    if (!pendingVoiceRefreshReason || hasActiveVoiceSession()) return;
    var reason = pendingVoiceRefreshReason;
    pendingVoiceRefreshReason = null;
    refreshVoiceRegistration(reason);
  }

  function onCallSessionEnded() {
    lastCallEndedAt = Date.now();
    flushPendingVoiceRefresh();
  }

  function mayAttemptDeviceRegister() {
    var now = Date.now();
    if (now - lastCallEndedAt < POST_CALL_QUIET_MS) return false;
    if (now - lastRegisterAttemptAt < REGISTER_ATTEMPT_COOLDOWN_MS) return false;
    if (hasActiveVoiceSession()) return false;
    return getDeviceStateName() === 'unregistered';
  }

  function attemptDeviceRegisterOnce(reason) {
    if (!state.twilioDevice || typeof state.twilioDevice.register !== 'function') return;
    if (!mayAttemptDeviceRegister()) return;
    lastRegisterAttemptAt = Date.now();
    state.twilioDevice.register().catch(function (e) {
      console.warn('[NorthstarTelephony] register failed (' + (reason || 'retry') + ')', e);
    });
  }

  /** Twilio best practice: resolve mic permission before Device.register. */
  async function prepareAudioInput() {
    if (!global.navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return;
    }
    var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(function (t) {
      t.stop();
    });
  }

  async function applySavedAudioDevices(device) {
    if (!device || !device.audio) return;
    var settings = Telephony.getSettings();
    if (settings.micId && typeof device.audio.setInputDevice === 'function') {
      try {
        await device.audio.setInputDevice(settings.micId);
      } catch (e) {
        console.warn('[NorthstarTelephony] setInputDevice', e);
      }
    }
    if (settings.speakerId && device.audio.speakerDevices && typeof device.audio.speakerDevices.set === 'function') {
      try {
        await device.audio.speakerDevices.set(settings.speakerId);
      } catch (e2) {
        console.warn('[NorthstarTelephony] speakerDevices.set', e2);
      }
    }
  }

  /**
   * In-call safe path: fetch a new token and call device.updateToken() only (no destroy/register).
   */
  function refreshAccessTokenOnly(reason, forceIdentity) {
    if (reauthInFlight) return reauthInFlight;
    reauthInFlight = Telephony.fetchTwilioAccessToken(
      forceIdentity || state.provider.twilioIdentity || state.extension || 'agent'
    )
      .then(function () {
        emit('provider', { mode: state.provider.mode, refreshed: true });
      })
      .catch(function (error) {
        state.provider.twilioLastError = formatErr(error);
        emit('provider', {
          mode: state.provider.mode,
          error: state.provider.twilioLastError,
          recovery: reason || 'token-refresh',
        });
        emit('error', { message: state.provider.twilioLastError });
        if (hasActiveVoiceSession()) {
          pendingVoiceRefreshReason = reason || 'token-refresh-failed';
        }
      })
      .finally(function () {
        reauthInFlight = null;
      });
    return reauthInFlight;
  }

  function refreshVoiceRegistration(reason, forceIdentity) {
    if (hasActiveVoiceSession()) {
      if (reason === 'token-expiring') {
        return refreshAccessTokenOnly(reason, forceIdentity);
      }
      pendingVoiceRefreshReason = reason || pendingVoiceRefreshReason || 'deferred';
      console.warn(
        '[NorthstarTelephony] queued full refresh after call (' + (reason || 'deferred') + ')'
      );
      return refreshAccessTokenOnly(reason || 'in-call-soft', forceIdentity);
    }
    var now = Date.now();
    if (now - lastVoiceRefreshAt < VOICE_REFRESH_COOLDOWN_MS) {
      return Promise.resolve();
    }
    lastVoiceRefreshAt = now;
    if (reauthInFlight) return reauthInFlight;
    reauthInFlight = Telephony.fetchTwilioAccessToken(
      forceIdentity || state.provider.twilioIdentity || state.extension || 'agent'
    )
      .catch(function (error) {
        state.provider.twilioLastError = formatErr(error);
        emit('provider', {
          mode: state.provider.mode,
          error: state.provider.twilioLastError,
          recovery: reason || 'refresh',
        });
        emit('error', { message: state.provider.twilioLastError });
      })
      .finally(function () {
        reauthInFlight = null;
      });
    return reauthInFlight;
  }

  function getTwilioGlobal() {
    return global.Twilio && global.Twilio.Device ? global.Twilio : null;
  }

  /** Waits if the SDK script is still loading over the network (sync order is unchanged). */
  function waitForTwilioSDK(timeoutMs) {
    var ms = typeof timeoutMs === 'number' ? timeoutMs : 8000;
    return new Promise(function (resolve, reject) {
      if (getTwilioGlobal()) {
        resolve();
        return;
      }
      var start = Date.now();
      var id = setInterval(function () {
        if (getTwilioGlobal()) {
          clearInterval(id);
          resolve();
          return;
        }
        if (Date.now() - start > ms) {
          clearInterval(id);
          reject(new Error('Phone app did not load. Check your network and refresh the page.'));
        }
      }, 40);
    });
  }

  function twilioEnabled() {
    return !!(getTwilioGlobal() && state.provider.twilioToken);
  }

  function makeActiveCallModel(call, fallbackDigits, fallbackName, directionHint) {
    var params = (call && call.parameters) || {};
    var dir = directionHint === 'inbound' ? 'inbound' : 'outbound';
    var digits;
    var name;
    if (dir === 'inbound') {
      digits = params.From || params.from || fallbackDigits || '';
      name = params.CallerName || params.From || fallbackName || 'Inbound';
    } else {
      digits = params.To || params.to || fallbackDigits || '';
      name = params.CallerName || params.From || fallbackName || '';
    }
    var sid = (call && call.parameters && (call.parameters.CallSid || call.parameters.call_sid)) || null;
    return {
      id: sid || 'call_' + Date.now(),
      digits: digits,
      name: name,
      direction: dir,
      twilioSid: sid,
      started: Date.now(),
      mute: false,
      hold: false,
      recording: false,
      conference: false,
      twilioRecordingSid: null,
    };
  }

  function normalizeInboundCaller(raw) {
    var s = String(raw || '').trim();
    if (s.toLowerCase().indexOf('client:') === 0) return s.slice(7).trim();
    return s;
  }

  /** Persist missed inbound to Supabase inbox (same row shape as Twilio Dial webhook). */
  function recordInboundMissToCloud(call, reason) {
    try {
      var inbox = global.NorthstarInbox;
      if (!inbox || typeof inbox.recordMissedCall !== 'function') return;
      var params = (call && call.parameters) || {};
      var fromRaw = params.From || params.from || '';
      var caller = normalizeInboundCaller(fromRaw);
      if (!caller) return;
      var name = (params.CallerName && String(params.CallerName).trim()) || caller || 'Inbound caller';
      var sid = params.CallSid || params.call_sid || '';
      inbox.recordMissedCall({
        callerNumber: caller,
        displayName: name,
        reason: reason,
        callSid: sid,
      });
    } catch (e) {
      console.warn('[NorthstarTelephony] recordInboundMissToCloud', e);
    }
  }

  function attachTwilioCallEvents(call, directionHint) {
    if (!call || typeof call.on !== 'function') return;
    var dir = directionHint === 'inbound' ? 'inbound' : 'outbound';
    var inboundAccepted = false;
    var missedRecorded = false;

    function tryRecordMissed(reason) {
      if (dir !== 'inbound') return;
      if (inboundAccepted || missedRecorded) return;
      missedRecorded = true;
      recordInboundMissToCloud(call, reason);
    }

    call.on('accept', function () {
      inboundAccepted = true;
      state.twilioCall = call;
      if (state.twilioIncomingCall === call) state.twilioIncomingCall = null;
      state.inboundRinging = null;
      state.activeCall = makeActiveCallModel(
        call,
        state.activeCall && state.activeCall.digits,
        state.activeCall && state.activeCall.name,
        dir
      );
      emit('call', { phase: 'connected', call: state.activeCall });
    });

    call.on('mute', function (isMuted) {
      if (state.activeCall && !state.activeCall.hold) {
        state.activeCall.mute = !!isMuted;
        emit('call', { phase: 'mute', mute: state.activeCall.mute });
      }
    });

    call.on('disconnect', function () {
      if (state.activeCall && state.activeCall.hold) {
        state.activeCall.hold = false;
        applyHoldMedia(false);
      }
      var endedCall = state.activeCall;
      if (endedCall && dir === 'outbound') {
        var dur = Math.round((Date.now() - endedCall.started) / 1000);
        formatHistoryRow({
          id: 'h_' + Date.now(),
          direction: 'outbound',
          number: endedCall.digits,
          name: endedCall.name,
          startedAt: new Date(endedCall.started).toISOString(),
          durationSec: dur,
          result: 'completed',
        });
      }
      if (dir === 'inbound') {
        setTimeout(function () {
          tryRecordMissed('no_answer');
        }, 0);
      }
      state.twilioCall = null;
      if (state.twilioIncomingCall === call) state.twilioIncomingCall = null;
      state.inboundRinging = null;
      state.activeCall = null;
      state.pendingConference = false;
      state.twilioRecordingSid = null;
      emit('call', { phase: 'idle' });
      onCallSessionEnded();
    });

    call.on('cancel', function () {
      tryRecordMissed('caller_cancelled');
      if (state.twilioIncomingCall === call) state.twilioIncomingCall = null;
      state.inboundRinging = null;
      state.twilioCall = null;
      state.activeCall = null;
      state.twilioRecordingSid = null;
      emit('call', { phase: 'idle' });
      onCallSessionEnded();
    });

    call.on('reject', function () {
      tryRecordMissed('declined');
      if (state.twilioIncomingCall === call) state.twilioIncomingCall = null;
      state.inboundRinging = null;
      state.twilioCall = null;
      state.activeCall = null;
      state.twilioRecordingSid = null;
      emit('call', { phase: 'idle' });
      onCallSessionEnded();
    });

    call.on('error', function (error) {
      state.provider.twilioLastError = formatErr(error);
      emit('error', { message: state.provider.twilioLastError });
    });

    call.on('warning', function (warningName, warningData) {
      var wn = String(warningName || '');
      if (IDLE_QUALITY_WARNING_NAMES[wn]) return;
      emit('call', {
        phase: 'quality-warning',
        name: warningName,
        data: warningData,
      });
    });

    call.on('warning-cleared', function (warningName) {
      emit('call', {
        phase: 'quality-warning-cleared',
        name: warningName,
      });
    });
  }

  function setupTwilioDeviceEventBridge(device) {
    if (!device || typeof device.on !== 'function') return;

    device.on('registered', function () {
      state.provider.mode = 'twilio-registered';
      state.provider.twilioDeviceRegistered = true;
      var edgeLabel = '';
      try {
        edgeLabel = device.edge ? String(device.edge) : '';
      } catch (_e) {}
      emit('provider', { mode: state.provider.mode, edge: edgeLabel });
    });

    device.on('unregistered', function () {
      if (isDeviceRegisteredWithTwilio()) {
        return;
      }
      state.provider.mode = 'twilio-ready';
      state.provider.twilioDeviceRegistered = false;
      emit('provider', { mode: state.provider.mode });
      if (hasActiveVoiceSession()) {
        pendingVoiceRefreshReason = 'device-unregistered';
        refreshAccessTokenOnly('device-unregistered-in-call');
        return;
      }
      /** Post-hangup unregister flicker + token refresh was causing WSTransport register loops. */
      if (Date.now() - lastCallEndedAt < POST_CALL_QUIET_MS) {
        return;
      }
      var now = Date.now();
      if (now - lastUnregisterHandlerAt < VOICE_REFRESH_COOLDOWN_MS) {
        return;
      }
      lastUnregisterHandlerAt = now;
      attemptDeviceRegisterOnce('device-unregistered');
    });

    device.on('error', function (error) {
      state.provider.twilioLastError = formatErr(error);
      emit('provider', { mode: state.provider.mode, error: state.provider.twilioLastError });
      emit('error', { message: state.provider.twilioLastError });
    });

    device.on('incoming', function (call) {
      attachTwilioCallEvents(call, 'inbound');
      var params = (call && call.parameters) || {};
      state.twilioIncomingCall = call;
      state.inboundRinging = {
        from: params.From || params.from || 'Unknown',
        name: params.CallerName || params.From || 'Inbound caller',
      };
      emit('call', {
        phase: 'ringing',
        from: state.inboundRinging.from,
        name: state.inboundRinging.name,
      });
    });

    device.on('tokenWillExpire', function () {
      emit('provider', { mode: state.provider.mode, tokenWillExpire: true });
      if (hasActiveVoiceSession()) {
        refreshAccessTokenOnly('token-expiring');
      } else {
        refreshVoiceRegistration('token-expiring');
      }
    });
  }

  function emit(type, payload) {
    state.subscribers.forEach(function (fn) {
      try {
        fn({ type: type, payload: payload });
      } catch (e) {}
    });
  }

  /** Apply mic + remote audio for agent-side hold (full PSTN hold music requires conference/TwiML). */
  function applyHoldMedia(holdOn) {
    if (!state.twilioCall) return;
    try {
      if (typeof state.twilioCall.mute === 'function') {
        state.twilioCall.mute(holdOn ? true : !!(state.activeCall && state.activeCall.mute));
      }
      var rs =
        typeof state.twilioCall.getRemoteStream === 'function'
          ? state.twilioCall.getRemoteStream()
          : null;
      if (rs && rs.getAudioTracks) {
        rs.getAudioTracks().forEach(function (t) {
          t.enabled = !holdOn;
        });
      }
    } catch (_e) {}
  }

  async function invokeTwilioCallAction(body) {
    var supa = global.NorthstarSupabase;
    if (!supa || typeof supa.getClient !== 'function' || !supa.isConfigured()) {
      throw new Error('Sign in to use this action');
    }
    var client = supa.getClient();
    var res = await client.functions.invoke('twilio-call-action', { body: body });
    var data = res && res.data ? res.data : null;
    if (data && typeof data.error === 'string' && data.error) {
      throw new Error(data.error);
    }
    if (res.error) throw new Error(formatErr(res.error));
    return data;
  }

  function normalizeDigits(input) {
    return String(input || '').replace(/[^\d+*#]/g, '');
  }

  /** US-focused E.164 for Twilio outbound (trial + PSTN). Short extensions stay bare. */
  function toE164US(digits) {
    var d = normalizeDigits(digits);
    if (!d) return '';
    if (/^\d{2,6}$/.test(d)) return d;
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d.charAt(0) === '1') return '+' + d;
    if (d.charAt(0) === '+') return d;
    return '+' + d;
  }

  function lineNumberToE164(lineObj) {
    if (!lineObj || !lineObj.number) return '';
    var raw = String(lineObj.number);
    var only = raw.replace(/\D/g, '');
    if (only.length === 11 && only.charAt(0) === '1') return '+' + only;
    if (only.length === 10) return '+1' + only;
    return toE164US(only);
  }

  function formatHistoryRow(entry) {
    var list = loadJson(STORAGE_HISTORY, []);
    list.unshift(entry);
    if (list.length > 400) list.length = 400;
    saveJson(STORAGE_HISTORY, list);
  }

  function defaultSettings() {
    return {
      voiceEdge: 'auto',
      micId: '',
      speakerId: '',
      ringtone: 'default',
      incomingRing: true,
      desktopNotifications: true,
      forwardAlways: false,
      forwardNumber: '',
      simultaneousRing: true,
      mobileNumber: '',
      dndSchedule: false,
      dndFrom: '18:00',
      dndTo: '08:00',
    };
  }

  function defaultVoicemail() {
    return [
      { id: 'vm1', from: '(210) 555-0144', name: 'Dispatch — SA Luxury', durationSec: 42, unread: true, receivedAt: new Date(Date.now() - 3600000).toISOString(), transcript: 'Callback requested for tomorrow 10am.' },
      { id: 'vm2', from: '(210) 555-0711', name: 'Unknown', durationSec: 18, unread: true, receivedAt: new Date(Date.now() - 86400000).toISOString(), transcript: '' },
      { id: 'vm3', from: '(210) 555-0330', name: 'El Rancho Grill', durationSec: 65, unread: false, receivedAt: new Date(Date.now() - 172800000).toISOString(), transcript: 'Thanks for the follow-up…' },
    ];
  }

  var Telephony = {
    /** @param {{ extension:string, userName?:string }} cfg */
    init: function (cfg) {
      state.extension = cfg.extension || '101';
      state.userName = cfg.userName || 'Agent';
      if (!loadJson(STORAGE_VM, null)) saveJson(STORAGE_VM, defaultVoicemail());
      if (!localStorage.getItem(STORAGE_SETTINGS)) saveJson(STORAGE_SETTINGS, defaultSettings());
      emit('ready', { extension: state.extension });
    },

    subscribe: function (fn) {
      state.subscribers.push(fn);
      return function () {
        state.subscribers = state.subscribers.filter(function (f) { return f !== fn; });
      };
    },

    getState: function () {
      return JSON.parse(JSON.stringify(state));
    },

    isCallActive: function () {
      return hasActiveVoiceSession();
    },

    isVoiceRegistered: function () {
      if (syncProviderFromDeviceState()) return true;
      return !!state.provider.twilioDeviceRegistered;
    },

    /** Admin/profile edge preset (auto, us, apac, singapore, …). Applied on next Device setup. */
    setVoiceEdgePreference: function (edge) {
      state.voiceEdgePreference = String(edge || 'auto').trim().toLowerCase();
    },

    getVoiceEdgePreference: function () {
      var raw = '';
      try {
        var prof = global.NorthstarAuth && NorthstarAuth.getProfile ? NorthstarAuth.getProfile() : null;
        if (prof && prof.voice_edge) raw = String(prof.voice_edge).trim().toLowerCase();
      } catch (_e) {}
      return raw || state.voiceEdgePreference || Telephony.getSettings().voiceEdge || 'auto';
    },

    answerIncoming: async function () {
      if (!state.twilioIncomingCall) return;
      try {
        if (
          state.twilioDevice &&
          state.twilioDevice.audio &&
          typeof state.twilioDevice.audio.setInputDevice === 'function'
        ) {
          var micId = Telephony.getSettings().micId;
          if (micId) await state.twilioDevice.audio.setInputDevice(micId);
        }
        state.twilioIncomingCall.accept();
      } catch (e) {
        state.provider.twilioLastError = formatErr(e);
        emit('error', { message: state.provider.twilioLastError });
      }
      state.inboundRinging = null;
    },

    declineIncoming: function () {
      if (!state.twilioIncomingCall) return;
      try {
        if (typeof state.twilioIncomingCall.reject === 'function') state.twilioIncomingCall.reject();
        else if (typeof state.twilioIncomingCall.disconnect === 'function') state.twilioIncomingCall.disconnect();
      } catch (e) {
        state.provider.twilioLastError = formatErr(e);
      }
      state.twilioIncomingCall = null;
      state.inboundRinging = null;
      emit('call', { phase: 'idle' });
    },

    getLines: function () {
      return state.lines.slice();
    },

    setLines: function (lines, preferredNumberE164) {
      var next = Array.isArray(lines) ? lines.slice() : [];
      next = next
        .filter(function (l) {
          return l && l.id && l.number;
        })
        .map(function (l, idx) {
          return {
            id: String(l.id || 'line' + (idx + 1)),
            label: String(l.label || 'Line ' + (idx + 1)),
            number: String(l.number || ''),
            outbound: l.outbound !== false,
          };
        });
      if (!next.length) return;
      state.lines = next;
      var pref = String(preferredNumberE164 || '').trim();
      var prefIdx = -1;
      if (pref) {
        for (var i = 0; i < state.lines.length; i++) {
          if (lineNumberToE164(state.lines[i]) === pref) {
            prefIdx = i;
            break;
          }
        }
      }
      if (prefIdx >= 0) state.callerIdIndex = prefIdx;
      if (state.callerIdIndex < 0 || state.callerIdIndex >= state.lines.length) state.callerIdIndex = 0;
      var lineId = state.lineId;
      var lineExists = state.lines.some(function (l) {
        return l.id === lineId;
      });
      if (!lineExists) state.lineId = state.lines[0].id;
      emit('lines', {
        lineId: state.lineId,
        lines: state.lines.slice(),
        callerIdIndex: state.callerIdIndex,
      });
      emit('callerId', { index: state.callerIdIndex });
    },

    setLine: function (lineId) {
      state.lineId = lineId;
      emit('lines', { lineId: lineId });
    },

    getCallerIds: function () {
      return state.lines.map(function (l) { return l.number; });
    },

    setCallerIdIndex: function (idx) {
      state.callerIdIndex = idx;
      emit('callerId', { index: idx });
    },

    getPresenceList: function () {
      return [
        { id: 'available', label: 'Available' },
        { id: 'busy', label: 'Busy' },
        { id: 'dnd', label: 'Do not disturb' },
        { id: 'invisible', label: 'Invisible' },
        { id: 'offline', label: 'Offline' },
      ];
    },

    getPresence: function () {
      return state.presence;
    },

    setPresence: function (id) {
      state.presence = id;
      emit('presence', { presence: id });
    },

    getSettings: function () {
      return Object.assign(defaultSettings(), loadJson(STORAGE_SETTINGS, {}));
    },

    saveSettings: function (partial) {
      var cur = Object.assign(defaultSettings(), loadJson(STORAGE_SETTINGS, {}));
      Object.assign(cur, partial);
      saveJson(STORAGE_SETTINGS, cur);
      emit('settings', cur);
      if (state.twilioDevice && state.twilioDevice.audio) {
        applySavedAudioDevices(state.twilioDevice).catch(function (e) {
          console.warn('[NorthstarTelephony] applySavedAudioDevices', e);
        });
      }
      return cur;
    },

    listAudioDevices: async function () {
      if (!global.navigator || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return { inputs: [], outputs: [] };
      }
      try {
        await prepareAudioInput();
      } catch (_e) {}
      var list = await navigator.mediaDevices.enumerateDevices();
      var inputs = [];
      var outputs = [];
      list.forEach(function (d) {
        if (d.kind === 'audioinput') {
          inputs.push({ id: d.deviceId, label: d.label || 'Microphone' });
        } else if (d.kind === 'audiooutput') {
          outputs.push({ id: d.deviceId, label: d.label || 'Speaker' });
        }
      });
      return { inputs: inputs, outputs: outputs };
    },

    getCallHistory: function (limit) {
      var list = loadJson(STORAGE_HISTORY, []);
      return typeof limit === 'number' ? list.slice(0, limit) : list.slice();
    },

    getProviderStatus: function () {
      return Object.assign({}, state.provider);
    },

    registerTwilioDevice: async function () {
      var TwilioGlobal = getTwilioGlobal();
      if (!TwilioGlobal) {
        throw new Error('Phone app did not load. Refresh the page.');
      }
      if (!state.provider.twilioToken) {
        throw new Error('Phone service is not signed in. Refresh or sign in again.');
      }

      if (state.twilioDevice) {
        if (syncProviderFromDeviceState()) {
          return state.twilioDevice;
        }
        if (state.provider.twilioDeviceRegistered) {
          return state.twilioDevice;
        }
        var regState = getDeviceStateName();
        if (regState === 'registering') {
          return state.twilioDevice;
        }
        /** Re-register existing Device — do not destroy/recreate (causes WSTransport register loops). */
        try {
          await prepareAudioInput();
          await new Promise(function (resolve, reject) {
            var settled = false;
            var timer = setTimeout(function () {
              if (settled) return;
              settled = true;
              reject(new Error('Phone registration timed out — allow the microphone and try again.'));
            }, 25000);
            function done(err) {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              if (err) reject(err);
              else resolve();
            }
            state.twilioDevice.once('registered', function () {
              done();
            });
            state.twilioDevice.once('error', function (err) {
              done(err || new Error('Phone device error'));
            });
            state.twilioDevice.register().catch(function (e) {
              done(e);
            });
          });
          syncProviderFromDeviceState();
          await applySavedAudioDevices(state.twilioDevice);
          return state.twilioDevice;
        } catch (reRegErr) {
          console.warn('[NorthstarTelephony] soft re-register failed, recreating device', reRegErr);
          try {
            if (typeof state.twilioDevice.destroy === 'function') state.twilioDevice.destroy();
          } catch (_d) {}
          state.twilioDevice = null;
          state.provider.twilioDeviceRegistered = false;
        }
      }

      await prepareAudioInput();

      var device = new TwilioGlobal.Device(state.provider.twilioToken, getVoiceDeviceOptions());
      setupTwilioDeviceEventBridge(device);
      state.twilioDevice = device;
      /**
       * Invalid tokens often fail with AccessTokenInvalid (20101) on the Device `error` event after
       * WebSocket validation — not necessarily as a rejection from `register()`. Wait for
       * `registered` or first `error` instead of awaiting `register()` alone.
       */
      try {
        await new Promise(function (resolve, reject) {
          var settled = false;
          var timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('Phone registration timed out — allow the microphone and try again.'));
          }, 25000);

          function cleanup() {
            clearTimeout(timer);
            device.removeListener('registered', onRegistered);
            device.removeListener('error', onDeviceError);
          }

          function onRegistered() {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
          }

          function onDeviceError(err) {
            if (settled) return;
            settled = true;
            cleanup();
            reject(err != null ? err : new Error('Phone device error'));
          }

          device.on('registered', onRegistered);
          device.on('error', onDeviceError);

          device.register().catch(function (regPromiseErr) {
            if (settled) return;
            settled = true;
            cleanup();
            reject(regPromiseErr != null ? regPromiseErr : new Error('device.register() failed'));
          });
        });
      } catch (regErr) {
        state.provider.twilioDeviceRegistered = false;
        try {
          if (device && typeof device.destroy === 'function') device.destroy();
        } catch (destroyErr) {}
        state.twilioDevice = null;
        throw new Error(formatErr(regErr));
      }
      await applySavedAudioDevices(device);
      state.provider.twilioDeviceRegistered = true;
      state.provider.mode = 'twilio-registered';
      emit('provider', { mode: state.provider.mode });
      return device;
    },

    /**
     * When Supabase + Twilio are configured, fetch token and register Device before dialing.
     * Resolves when ready; if Supabase is not configured, resolves (mock/local mode).
     */
    ensureVoiceReady: async function (identity) {
      var supa = global.NorthstarSupabase;
      if (!supa || typeof supa.isConfigured !== 'function' || !supa.isConfigured()) {
        return;
      }
      await waitForTwilioSDK(8000);
      var TwilioGlobal = getTwilioGlobal();
      if (!TwilioGlobal) {
        throw new Error('Phone app did not load. Check your network and refresh the page.');
      }
      if (state.twilioDevice && state.provider.twilioToken && syncProviderFromDeviceState()) {
        return;
      }
      if (state.twilioDevice && state.provider.twilioDeviceRegistered && state.provider.twilioToken) {
        return;
      }
      await Telephony.fetchTwilioAccessToken(identity || state.extension || 'agent');
    },

    /**
     * Fetches a Twilio access token through Supabase Edge Function.
     * Keeps mock mode active until a valid token is returned.
     */
    fetchTwilioAccessToken: async function (identity) {
      var supa = global.NorthstarSupabase;
      if (!supa || typeof supa.getClient !== 'function' || !supa.isConfigured()) {
        throw new Error('Company account not connected. Sign in and refresh.');
      }
      var client = supa.getClient();
      if (!client) throw new Error('Could not connect. Refresh the page.');

      var functionName = (supa.config && supa.config.twilioTokenFunction) || 'twilio-access-token';
      var payload = {
        identity: identity || state.userName || state.extension || 'agent',
        extension: state.extension || '101',
        lineId: state.lineId,
      };

      var response = await client.functions.invoke(functionName, { body: payload });
      var data = response.data;

      /** Edge returns { error } in JSON body; read that before generic invoke error text. */
      if (data && typeof data.error === 'string' && data.error && !data.token) {
        state.provider.twilioLastError = data.error;
        emit('provider', { mode: state.provider.mode, error: state.provider.twilioLastError });
        throw new Error(state.provider.twilioLastError);
      }

      if (response.error) {
        state.provider.twilioLastError =
          data && typeof data.error === 'string' && data.error ? data.error : formatErr(response.error);
        emit('provider', { mode: state.provider.mode, error: state.provider.twilioLastError });
        throw new Error(state.provider.twilioLastError);
      }

      var token = data && data.token ? data.token : null;
      if (!token) {
        state.provider.twilioLastError = 'Token response missing token property';
        emit('provider', { mode: state.provider.mode, error: state.provider.twilioLastError });
        throw new Error(state.provider.twilioLastError);
      }

      var alreadyRegistered = isDeviceRegisteredWithTwilio();
      if (!alreadyRegistered) {
        state.provider.mode = 'twilio-ready';
      }
      state.provider.twilioToken = token;
      state.provider.twilioTokenFetchedAt = Date.now();
      state.provider.twilioIdentity = payload.identity;
      state.provider.twilioLastError = null;
      emit('provider', { mode: state.provider.mode, fetchedAt: state.provider.twilioTokenFetchedAt });
      if (state.twilioDevice && typeof state.twilioDevice.updateToken === 'function') {
        try {
          await state.twilioDevice.updateToken(token);
          syncProviderFromDeviceState();
          if (!syncProviderFromDeviceState() && !hasActiveVoiceSession()) {
            attemptDeviceRegisterOnce('token-updated');
          }
          emit('provider', { mode: state.provider.mode, refreshed: true });
          return token;
        } catch (refreshErr) {
          state.provider.twilioLastError = formatErr(refreshErr);
          emit('provider', { mode: state.provider.mode, warning: state.provider.twilioLastError });
          if (hasActiveVoiceSession()) {
            return token;
          }
        }
      }
      if (hasActiveVoiceSession()) {
        return token;
      }
      if (isDeviceRegisteredWithTwilio()) {
        syncProviderFromDeviceState();
        return token;
      }
      await this.registerTwilioDevice();
      return token;
    },

    logOutboundAttempt: function (digits, meta) {
      formatHistoryRow({
        id: 'h_' + Date.now(),
        direction: 'outbound',
        number: digits,
        name: meta && meta.name,
        startedAt: new Date().toISOString(),
        durationSec: null,
        result: 'placed',
      });
    },

    getVoicemails: function () {
      return loadJson(STORAGE_VM, defaultVoicemail()).slice();
    },

    setVoicemailRead: function (id, unread) {
      var list = loadJson(STORAGE_VM, defaultVoicemail());
      list.forEach(function (v) {
        if (v.id === id) v.unread = unread;
      });
      saveJson(STORAGE_VM, list);
      emit('voicemail', {});
    },

    deleteVoicemail: function (id) {
      var list = loadJson(STORAGE_VM, defaultVoicemail()).filter(function (v) { return v.id !== id; });
      saveJson(STORAGE_VM, list);
      emit('voicemail', {});
    },

    /**
     * Place outbound call: Twilio Client when configured + ready; otherwise local mock for UX demos.
     */
    dial: function (raw, contactMeta) {
      var digits = normalizeDigits(raw);
      if (!digits) {
        emit('error', { message: 'Enter a number' });
        return;
      }
      var supa = global.NorthstarSupabase;
      var wantsTwilio = !!(supa && typeof supa.isConfigured === 'function' && supa.isConfigured());

      var e164To = toE164US(digits);
      var line = state.lines[state.callerIdIndex] || state.lines[0];
      var e164Caller = lineNumberToE164(line);

      Telephony.logOutboundAttempt(e164To || digits, contactMeta);

      state.activeCall = {
        id: 'call_' + Date.now(),
        digits: e164To || digits,
        name: contactMeta && contactMeta.name,
        direction: 'outbound',
        started: Date.now(),
        mute: false,
        hold: false,
        recording: false,
        conference: false,
        twilioRecordingSid: null,
      };

      function startTwilioDial() {
        var connectPromise = Promise.resolve();
        if (
          state.twilioDevice &&
          state.twilioDevice.audio &&
          typeof state.twilioDevice.audio.setInputDevice === 'function'
        ) {
          var micId = Telephony.getSettings().micId;
          if (micId) {
            connectPromise = state.twilioDevice.audio.setInputDevice(micId).catch(function (e) {
              console.warn('[NorthstarTelephony] setInputDevice before dial', e);
            });
          }
        }
        connectPromise.then(function () {
          return state.twilioDevice.connect({
            params: {
              To: e164To || digits,
              lineId: state.lineId,
              callerId: e164Caller,
            },
          });
        }).then(function (call) {
          state.twilioCall = call;
          attachTwilioCallEvents(call, 'outbound');
        }).catch(function (error) {
          state.provider.twilioLastError = formatErr(error);
          emit('error', { message: state.provider.twilioLastError });
          emit('provider', { mode: state.provider.mode, error: state.provider.twilioLastError });
          state.activeCall = null;
          emit('call', { phase: 'idle' });
        });
      }

      if (wantsTwilio && twilioEnabled() && state.twilioDevice && state.provider.twilioDeviceRegistered) {
        startTwilioDial();
      } else if (!wantsTwilio) {
        emit('call', { phase: 'connected', call: state.activeCall });
      } else {
        Telephony.ensureVoiceReady(state.provider.twilioIdentity || state.extension || 'agent')
          .then(function () {
            if (!twilioEnabled() || !state.twilioDevice || !state.provider.twilioDeviceRegistered) {
              throw new Error('Phone not ready yet');
            }
            startTwilioDial();
          })
          .catch(function (err) {
            state.provider.twilioLastError = formatErr(err || new Error('Phone not ready — wait a moment and try again'));
            emit('error', { message: state.provider.twilioLastError });
            state.activeCall = null;
            emit('call', { phase: 'idle' });
          });
      }
    },

    hangup: function () {
      var wantsTwilio = !!(state.provider && (state.provider.twilioDeviceRegistered || state.provider.twilioToken));
      if (wantsTwilio) {
        var attemptedTwilio = false;
        if (state.twilioCall && typeof state.twilioCall.disconnect === 'function') {
          attemptedTwilio = true;
          try {
            state.twilioCall.disconnect();
          } catch (e) {}
        }
        if (state.twilioDevice && typeof state.twilioDevice.disconnectAll === 'function') {
          attemptedTwilio = true;
          try {
            state.twilioDevice.disconnectAll();
          } catch (e2) {}
        }
        if (attemptedTwilio) return;
        emit('error', { message: 'Could not end the call. Refresh the page and try again.' });
        return;
      }
      if (!state.activeCall) return;
      var dur = Math.round((Date.now() - state.activeCall.started) / 1000);
      formatHistoryRow({
        id: 'h_' + Date.now(),
        direction: 'outbound',
        number: state.activeCall.digits,
        name: state.activeCall.name,
        startedAt: new Date(state.activeCall.started).toISOString(),
        durationSec: dur,
        result: 'completed',
      });
      state.activeCall = null;
      state.pendingConference = false;
      emit('call', { phase: 'idle' });
    },

    toggleMute: function () {
      if (!state.activeCall) return;
      state.activeCall.mute = !state.activeCall.mute;
      if (state.twilioCall && typeof state.twilioCall.mute === 'function') {
        try {
          state.twilioCall.mute(state.activeCall.hold ? true : state.activeCall.mute);
        } catch (e) {}
      }
      emit('call', { phase: 'mute', mute: state.activeCall.mute });
    },

    toggleHold: function () {
      if (!state.activeCall) return;
      state.activeCall.hold = !state.activeCall.hold;
      applyHoldMedia(state.activeCall.hold);
      emit('call', { phase: 'hold', hold: state.activeCall.hold });
    },

    /** Force hold state (e.g. warm transfer prelude). */
    setHold: function (on) {
      if (!state.activeCall) return;
      var want = !!on;
      if (!!state.activeCall.hold === want) return;
      state.activeCall.hold = want;
      applyHoldMedia(want);
      emit('call', { phase: 'hold', hold: want });
    },

    toggleRecord: async function () {
      if (!state.activeCall) return false;
      var params = (state.twilioCall && state.twilioCall.parameters) || {};
      var callSid = params.CallSid || params.call_sid || '';
      var nextOn = !state.activeCall.recording;

      if (!state.twilioCall || !callSid || !global.NorthstarSupabase || !NorthstarSupabase.isConfigured()) {
        state.activeCall.recording = nextOn;
        emit('call', { phase: 'record', recording: state.activeCall.recording });
        return state.activeCall.recording;
      }

      try {
        if (nextOn) {
          var started = await invokeTwilioCallAction({
            action: 'start_recording',
            callSid: callSid,
          });
          state.activeCall.recording = true;
          state.activeCall.twilioRecordingSid =
            started && started.recordingSid ? started.recordingSid : null;
          state.twilioRecordingSid = state.activeCall.twilioRecordingSid;
        } else {
          await invokeTwilioCallAction({
            action: 'stop_recording',
            callSid: callSid,
            recordingSid: state.activeCall.twilioRecordingSid || state.twilioRecordingSid || '',
          });
          state.activeCall.recording = false;
          state.activeCall.twilioRecordingSid = null;
          state.twilioRecordingSid = null;
        }
        emit('call', { phase: 'record', recording: state.activeCall.recording });
      } catch (err) {
        emit('error', { message: formatErr(err) });
        return state.activeCall.recording;
      }
      return state.activeCall.recording;
    },

    /**
     * Blind transfer — redirects the PSTN/partner leg via Twilio REST, then drops the agent browser leg.
     * Falls back to hangup-only when not signed in or offline (demo).
     */
    transferBlind: async function (destination) {
      var dest = String(destination || '').trim();
      if (!dest) {
        emit('error', { message: 'Enter a transfer destination' });
        return;
      }
      var params = (state.twilioCall && state.twilioCall.parameters) || {};
      var callSid = params.CallSid || params.call_sid || '';

      if (!callSid) {
        emit('error', { message: 'Call not connected yet — wait until audio is up, then transfer.' });
        return;
      }

      if (!global.NorthstarSupabase || !NorthstarSupabase.isConfigured()) {
        emit('transfer', { mode: 'blind', destination: dest, simulated: true });
        Telephony.hangup();
        return;
      }

      try {
        await invokeTwilioCallAction({
          action: 'blind_transfer',
          callSid: callSid,
          to: dest,
        });
      } catch (err) {
        state.provider.twilioLastError = formatErr(err);
        emit('error', { message: state.provider.twilioLastError });
        return;
      }

      emit('transfer', { mode: 'blind', destination: dest });
      try {
        if (state.twilioCall && typeof state.twilioCall.disconnect === 'function') {
          state.twilioCall.disconnect();
        }
      } catch (_e) {}
    },

    /** Warm transfer — consult then complete (UI modal in app) */
    transferWarmStart: function () {
      emit('transfer', { mode: 'warm', phase: 'consult' });
    },

    transferWarmComplete: function () {
      Telephony.hangup();
    },

    conferenceAddCall: function () {
      state.pendingConference = true;
      emit('conference', { phase: 'add' });
    },

    mergeCalls: function () {
      if (!state.twilioCall) {
        if (!state.activeCall) return;
        state.activeCall.conference = true;
        state.pendingConference = false;
        emit('conference', { phase: 'merged' });
        return;
      }
      emit('error', {
        message:
          'Merge needs a multi-party line set up by your administrator. Use transfer to connect someone else, or add the second call from your desk phone.',
      });
      state.pendingConference = false;
    },

    flip: function () {
      var mob = Telephony.getSettings().mobileNumber;
      var m = mob != null ? String(mob).trim() : '';
      if (!m) {
        emit('error', {
          message: 'Add your mobile number under Settings → Mobile / simultaneous ring for flip-to-mobile.',
        });
        return Promise.resolve();
      }
      return Telephony.transferBlind(m);
    },

    /** Local park slot + hold — does not hang up (PBX park orbit needs queue/conference on the trunk). */
    park: function () {
      if (!state.activeCall) return;
      var slot = String(Math.floor(Math.random() * 80) + 20);
      state.activeCall.parkedSlot = slot;
      state.activeCall.hold = true;
      applyHoldMedia(true);
      emit('park', { slot: slot });
    },

    pickupPark: function (slot) {
      emit('parkPickup', { slot: slot });
    },

    sendDtmf: function (tone) {
      if (!state.activeCall) return;
      if (state.twilioCall && typeof state.twilioCall.sendDigits === 'function') {
        try {
          state.twilioCall.sendDigits(String(tone || ''));
        } catch (e) {}
      }
      emit('dtmf', { tone: tone });
    },

    simulateInboundRing: function () {
      state.inboundRinging = { from: '(210) 555-0900', name: 'Inbound queue' };
      emit('call', { phase: 'ringing', from: state.inboundRinging.from, name: state.inboundRinging.name });
    },

    formatError: formatErr,
  };

  global.NorthstarTelephony = Telephony;
})(typeof window !== 'undefined' ? window : this);
