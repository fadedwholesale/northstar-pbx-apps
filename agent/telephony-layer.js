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

  var state = {
    presence: 'available', // available | busy | dnd | invisible | offline
    lineId: 'line1',
    lines: [
      { id: 'line1', label: 'Main', number: '+1 (210) 555-0140', outbound: true },
      { id: 'line2', label: 'Detailing campaigns', number: '+1 (210) 555-0199', outbound: true },
    ],
    callerIdIndex: 0,
    session: null,
    /** @type {{ id:string, digits:string, name?:string, started:number, mute:boolean, hold:boolean, recording:boolean, conference:boolean, parkedSlot?:string } | null} */
    activeCall: null,
    pendingConference: false,
    provider: {
      mode: 'mock',
      twilioToken: null,
      twilioTokenFetchedAt: null,
      twilioLastError: null,
      twilioDeviceRegistered: false,
      twilioIdentity: null,
    },
    twilioDevice: null,
    twilioCall: null,
    subscribers: [],
  };

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
          reject(new Error('Twilio Voice SDK not loaded. Check network / script tag.'));
        }
      }, 40);
    });
  }

  function twilioEnabled() {
    return !!(getTwilioGlobal() && state.provider.twilioToken);
  }

  function makeActiveCallModel(call, fallbackDigits, fallbackName) {
    var params = (call && call.parameters) || {};
    var digits = params.To || params.to || fallbackDigits || '';
    var name = params.CallerName || params.From || params.from || fallbackName || '';
    return {
      id: (call && call.parameters && (call.parameters.CallSid || call.parameters.call_sid)) || ('call_' + Date.now()),
      digits: digits,
      name: name,
      started: Date.now(),
      mute: false,
      hold: false,
      recording: false,
      conference: false,
    };
  }

  function attachTwilioCallEvents(call) {
    if (!call || typeof call.on !== 'function') return;
    call.on('accept', function () {
      state.twilioCall = call;
      state.activeCall = makeActiveCallModel(call, state.activeCall && state.activeCall.digits, state.activeCall && state.activeCall.name);
      emit('call', { phase: 'connected', call: state.activeCall });
    });

    call.on('disconnect', function () {
      var endedCall = state.activeCall;
      if (endedCall) {
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
      state.twilioCall = null;
      state.activeCall = null;
      state.pendingConference = false;
      emit('call', { phase: 'idle' });
    });

    call.on('cancel', function () {
      state.twilioCall = null;
      state.activeCall = null;
      emit('call', { phase: 'idle' });
    });

    call.on('reject', function () {
      state.twilioCall = null;
      state.activeCall = null;
      emit('call', { phase: 'idle' });
    });

    call.on('error', function (error) {
      state.provider.twilioLastError = error && error.message ? error.message : String(error);
      emit('error', { message: state.provider.twilioLastError });
    });
  }

  function setupTwilioDeviceEventBridge(device) {
    if (!device || typeof device.on !== 'function') return;

    device.on('registered', function () {
      state.provider.mode = 'twilio-registered';
      state.provider.twilioDeviceRegistered = true;
      emit('provider', { mode: state.provider.mode });
    });

    device.on('unregistered', function () {
      state.provider.mode = 'twilio-ready';
      state.provider.twilioDeviceRegistered = false;
      emit('provider', { mode: state.provider.mode });
    });

    device.on('error', function (error) {
      state.provider.twilioLastError = error && error.message ? error.message : String(error);
      emit('provider', { mode: state.provider.mode, error: state.provider.twilioLastError });
      emit('error', { message: state.provider.twilioLastError });
    });

    device.on('incoming', function (call) {
      attachTwilioCallEvents(call);
      var params = (call && call.parameters) || {};
      emit('call', {
        phase: 'ringing',
        from: params.From || params.from || 'Unknown',
        name: params.CallerName || params.From || 'Inbound caller',
      });
      try {
        call.accept();
      } catch (e) {}
    });

    device.on('tokenWillExpire', function () {
      emit('provider', { mode: state.provider.mode, tokenWillExpire: true });
    });
  }

  function emit(type, payload) {
    state.subscribers.forEach(function (fn) {
      try {
        fn({ type: type, payload: payload });
      } catch (e) {}
    });
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

    getLines: function () {
      return state.lines.slice();
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
      return cur;
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
        throw new Error('Twilio Voice SDK not loaded');
      }
      if (!state.provider.twilioToken) {
        throw new Error('Twilio token missing');
      }

      if (state.twilioDevice && state.provider.twilioDeviceRegistered) {
        return state.twilioDevice;
      }

      try {
        if (state.twilioDevice && typeof state.twilioDevice.destroy === 'function') {
          state.twilioDevice.destroy();
        }
      } catch (e) {}

      var device = new TwilioGlobal.Device(state.provider.twilioToken, {
        logLevel: 1,
        edge: 'ashburn',
      });
      setupTwilioDeviceEventBridge(device);
      state.twilioDevice = device;
      await device.register();
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
        throw new Error('Twilio Voice SDK not loaded. Check network / script tag.');
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
        throw new Error('Supabase is not configured for Twilio token fetch');
      }
      var client = supa.getClient();
      if (!client) throw new Error('Supabase client unavailable');

      var functionName = (supa.config && supa.config.twilioTokenFunction) || 'twilio-access-token';
      var payload = {
        identity: identity || state.userName || state.extension || 'agent',
        extension: state.extension || '101',
        lineId: state.lineId,
      };

      var response = await client.functions.invoke(functionName, { body: payload });
      if (response.error) {
        state.provider.twilioLastError = response.error.message || String(response.error);
        emit('provider', { mode: state.provider.mode, error: state.provider.twilioLastError });
        throw response.error;
      }

      var token = response.data && response.data.token ? response.data.token : null;
      if (!token) {
        state.provider.twilioLastError = 'Token response missing token property';
        emit('provider', { mode: state.provider.mode, error: state.provider.twilioLastError });
        throw new Error(state.provider.twilioLastError);
      }

      state.provider.mode = 'twilio-ready';
      state.provider.twilioToken = token;
      state.provider.twilioTokenFetchedAt = Date.now();
      state.provider.twilioIdentity = payload.identity;
      state.provider.twilioLastError = null;
      emit('provider', { mode: state.provider.mode, fetchedAt: state.provider.twilioTokenFetchedAt });
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
        started: Date.now(),
        mute: false,
        hold: false,
        recording: false,
        conference: false,
      };

      if (wantsTwilio && twilioEnabled() && state.twilioDevice && state.provider.twilioDeviceRegistered) {
        state.twilioDevice.connect({
          params: {
            To: e164To || digits,
            lineId: state.lineId,
            callerId: e164Caller,
          },
        }).then(function (call) {
          state.twilioCall = call;
          attachTwilioCallEvents(call);
        }).catch(function (error) {
          state.provider.twilioLastError = error && error.message ? error.message : String(error);
          emit('error', { message: state.provider.twilioLastError });
          emit('provider', { mode: state.provider.mode, error: state.provider.twilioLastError });
          state.activeCall = null;
          emit('call', { phase: 'idle' });
        });
      } else if (!wantsTwilio) {
        emit('call', { phase: 'connected', call: state.activeCall });
      } else {
        state.provider.twilioLastError = 'Voice not registered yet — wait a moment and try again';
        emit('error', { message: state.provider.twilioLastError });
        state.activeCall = null;
        emit('call', { phase: 'idle' });
      }
    },

    hangup: function () {
      if (state.twilioCall && typeof state.twilioCall.disconnect === 'function') {
        state.twilioCall.disconnect();
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
          state.twilioCall.mute(state.activeCall.mute);
        } catch (e) {}
      }
      emit('call', { phase: 'mute', mute: state.activeCall.mute });
    },

    toggleHold: function () {
      if (!state.activeCall) return;
      state.activeCall.hold = !state.activeCall.hold;
      emit('call', { phase: 'hold', hold: state.activeCall.hold });
    },

    toggleRecord: function () {
      if (!state.activeCall) return;
      state.activeCall.recording = !state.activeCall.recording;
      emit('call', { phase: 'record', recording: state.activeCall.recording });
      return state.activeCall.recording;
    },

    /** Blind transfer — provider sends REFER */
    transferBlind: function (destination) {
      emit('transfer', { mode: 'blind', destination: destination });
      Telephony.hangup();
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
      if (!state.activeCall) return;
      state.activeCall.conference = true;
      state.pendingConference = false;
      emit('conference', { phase: 'merged' });
    },

    flip: function () {
      emit('flip', {});
    },

    park: function () {
      if (!state.activeCall) return;
      var slot = String(Math.floor(Math.random() * 80) + 20);
      state.activeCall.parkedSlot = slot;
      emit('park', { slot: slot });
      Telephony.hangup();
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
      emit('call', { phase: 'ringing', from: '(210) 555-0900', name: 'Inbound queue' });
    },
  };

  global.NorthstarTelephony = Telephony;
})(typeof window !== 'undefined' ? window : this);
