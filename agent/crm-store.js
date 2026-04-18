/**
 * Northstar CRM — lightweight client-side store for prototyping.
 * Replace with API calls to your backend in production.
 */
(function (global) {
  var STORAGE_KEY = 'northstar_crm_v1';

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return {
      contacts: [],
      activities: [],
      pipelines: { stages: ['New', 'Working', 'Appointment set', 'Won', 'Lost'] },
      meta: { updatedAt: null },
    };
  }

  function save(db) {
    db.meta.updatedAt = new Date().toISOString();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch (e) {}
  }

  function normalizePhone(p) {
    return String(p || '').replace(/\D/g, '');
  }

  function findContactIndex(db, phone, biz) {
    var np = normalizePhone(phone);
    for (var i = 0; i < db.contacts.length; i++) {
      var c = db.contacts[i];
      if (np && normalizePhone(c.phone) === np) return i;
      if (biz && c.business === biz) return i;
    }
    return -1;
  }

  var CRM = {
    load: load,
    save: save,

    /** @returns {{ db: object, contact: object }} */
    upsertContact: function (payload) {
      var db = load();
      var ix = findContactIndex(db, payload.phone, payload.business);
      var row = {
        id: ix >= 0 ? db.contacts[ix].id : 'c_' + Date.now(),
        business: payload.business || 'Unknown',
        name: payload.name || '',
        phone: payload.phone || '',
        city: payload.city || '',
        vertical: payload.vertical || '',
        stage: payload.stage || 'Working',
        lastOutcome: payload.lastOutcome || null,
        updatedAt: new Date().toISOString(),
      };
      if (ix >= 0) db.contacts[ix] = Object.assign({}, db.contacts[ix], row);
      else db.contacts.push(row);
      save(db);
      return { db: db, contact: ix >= 0 ? db.contacts[ix] : db.contacts[db.contacts.length - 1] };
    },

    logActivity: function (opts) {
      var db = load();
      var act = {
        id: 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        type: opts.type || 'call',
        agentId: opts.agentId || null,
        agentName: opts.agentName || 'Agent',
        contactId: opts.contactId || null,
        business: opts.business || '',
        vertical: opts.vertical || '',
        disposition: opts.disposition || null,
        notes: opts.notes || '',
        durationSec: opts.durationSec != null ? opts.durationSec : null,
        recording: opts.recording || false,
        createdAt: new Date().toISOString(),
      };
      db.activities.unshift(act);
      if (db.activities.length > 500) db.activities.length = 500;
      save(db);
      return { db: db, activity: act };
    },

    listContacts: function () {
      return load().contacts.slice();
    },

    listActivities: function (limit) {
      var a = load().activities;
      return typeof limit === 'number' ? a.slice(0, limit) : a.slice();
    },

    exportJson: function () {
      return JSON.stringify(load(), null, 2);
    },

    importJson: function (jsonStr) {
      var parsed = JSON.parse(jsonStr);
      save(parsed);
      return load();
    },

    resetDemo: function () {
      localStorage.removeItem(STORAGE_KEY);
      CRM.seedDemo();
    },

    seedDemo: function () {
      var db = load();
      if (db.contacts.length) return db;
      [
        { business: "Mike's Pro Detailing", name: 'Mike Pena', phone: '(210) 555-0182', city: 'San Antonio, TX', vertical: 'Detailing', stage: 'Working' },
        { business: 'SA Luxury Detail', name: 'Alex Torres', phone: '(210) 555-0241', city: 'San Antonio, TX', vertical: 'Detailing', stage: 'New' },
        { business: 'El Rancho Grill', name: 'Rosa M.', phone: '(210) 555-0319', city: 'San Antonio, TX', vertical: 'Restaurant', stage: 'Appointment set' },
      ].forEach(function (p) {
        CRM.upsertContact(p);
      });
      return load();
    },
  };

  global.NorthstarCRM = CRM;
})(typeof window !== 'undefined' ? window : this);
