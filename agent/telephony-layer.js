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
    subscribers: [],
  };

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

    /** Simulate placing outbound call — wire to provider SDK */
    dial: function (raw, contactMeta) {
      var digits = normalizeDigits(raw);
      if (!digits) {
        emit('error', { message: 'Enter a number' });
        return;
      }
      Telephony.logOutboundAttempt(digits, contactMeta);
      state.activeCall = {
        id: 'call_' + Date.now(),
        digits: digits,
        name: contactMeta && contactMeta.name,
        started: Date.now(),
        mute: false,
        hold: false,
        recording: false,
        conference: false,
      };
      emit('call', { phase: 'connected', call: state.activeCall });
    },

    hangup: function () {
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
      emit('dtmf', { tone: tone });
    },

    simulateInboundRing: function () {
      emit('call', { phase: 'ringing', from: '(210) 555-0900', name: 'Inbound queue' });
    },
  };

  global.NorthstarTelephony = Telephony;
})(typeof window !== 'undefined' ? window : this);
