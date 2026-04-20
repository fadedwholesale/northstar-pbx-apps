/**
 * Northstar CRM store
 * - Local-first for fast UI.
 * - Optional Supabase sync when configured.
 */
(function (global) {
  var STORAGE_KEY = 'northstar_crm_v1';
  var CONTACTS_TABLE = 'northstar_contacts';
  var ACTIVITIES_TABLE = 'northstar_activities';
  var REMOTE_ACTIVITY_LIMIT = 500;

  var remoteState = {
    initialized: false,
    enabled: false,
    syncing: false,
    lastSyncAt: null,
    lastError: null,
  };

  function buildEmptyDb() {
    return {
      contacts: [],
      activities: [],
      pipelines: { stages: ['New', 'Working', 'Appointment set', 'Won', 'Lost'] },
      meta: { updatedAt: null },
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return buildEmptyDb();
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

  function sortByUpdatedAtDesc(a, b) {
    var av = new Date(a.updatedAt || 0).getTime();
    var bv = new Date(b.updatedAt || 0).getTime();
    return bv - av;
  }

  function sortByCreatedAtDesc(a, b) {
    var av = new Date(a.createdAt || 0).getTime();
    var bv = new Date(b.createdAt || 0).getTime();
    return bv - av;
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

  function getSupabaseClient() {
    if (!global.NorthstarSupabase || typeof global.NorthstarSupabase.getClient !== 'function') return null;
    return global.NorthstarSupabase.getClient();
  }

  function toRemoteContact(localContact) {
    return {
      id: localContact.id,
      business: localContact.business,
      name: localContact.name,
      phone: localContact.phone,
      city: localContact.city,
      vertical: localContact.vertical,
      stage: localContact.stage,
      last_outcome: localContact.lastOutcome,
      updated_at: localContact.updatedAt,
    };
  }

  function fromRemoteContact(remoteContact) {
    return {
      id: remoteContact.id,
      business: remoteContact.business || 'Unknown',
      name: remoteContact.name || '',
      phone: remoteContact.phone || '',
      city: remoteContact.city || '',
      vertical: remoteContact.vertical || '',
      stage: remoteContact.stage || 'Working',
      lastOutcome: remoteContact.last_outcome || null,
      updatedAt: remoteContact.updated_at || new Date().toISOString(),
    };
  }

  function toRemoteActivity(localActivity) {
    return {
      id: localActivity.id,
      type: localActivity.type,
      agent_id: localActivity.agentId,
      agent_name: localActivity.agentName,
      contact_id: localActivity.contactId,
      business: localActivity.business,
      vertical: localActivity.vertical,
      disposition: localActivity.disposition,
      notes: localActivity.notes,
      duration_sec: localActivity.durationSec,
      recording: !!localActivity.recording,
      created_at: localActivity.createdAt,
    };
  }

  function fromRemoteActivity(remoteActivity) {
    return {
      id: remoteActivity.id,
      type: remoteActivity.type || 'call',
      agentId: remoteActivity.agent_id || null,
      agentName: remoteActivity.agent_name || 'Agent',
      contactId: remoteActivity.contact_id || null,
      business: remoteActivity.business || '',
      vertical: remoteActivity.vertical || '',
      disposition: remoteActivity.disposition || null,
      notes: remoteActivity.notes || '',
      durationSec: remoteActivity.duration_sec != null ? remoteActivity.duration_sec : null,
      recording: !!remoteActivity.recording,
      createdAt: remoteActivity.created_at || new Date().toISOString(),
    };
  }

  function queueRemoteWrite(task) {
    if (!remoteState.enabled) return;
    Promise.resolve()
      .then(task)
      .catch(function (error) {
        remoteState.lastError = error && error.message ? error.message : String(error);
        console.error('[NorthstarCRM] Remote write failed:', error);
      });
  }

  function mergeDbWithRemote(db, remoteContacts, remoteActivities) {
    var contactsById = {};
    db.contacts.forEach(function (c) { contactsById[c.id] = c; });
    remoteContacts.forEach(function (c) { contactsById[c.id] = fromRemoteContact(c); });
    db.contacts = Object.keys(contactsById).map(function (id) { return contactsById[id]; }).sort(sortByUpdatedAtDesc);

    var activitiesById = {};
    db.activities.forEach(function (a) { activitiesById[a.id] = a; });
    remoteActivities.forEach(function (a) { activitiesById[a.id] = fromRemoteActivity(a); });
    db.activities = Object.keys(activitiesById).map(function (id) { return activitiesById[id]; }).sort(sortByCreatedAtDesc);
    if (db.activities.length > REMOTE_ACTIVITY_LIMIT) db.activities.length = REMOTE_ACTIVITY_LIMIT;
  }

  var CRM = {
    load: load,
    save: save,

    initialize: async function () {
      if (remoteState.initialized) return this.getRemoteStatus();
      remoteState.initialized = true;

      var client = getSupabaseClient();
      if (!client) {
        remoteState.enabled = false;
        return this.getRemoteStatus();
      }

      remoteState.enabled = true;
      try {
        await this.syncFromRemote();
      } catch (error) {
        remoteState.lastError = error && error.message ? error.message : String(error);
      }
      return this.getRemoteStatus();
    },

    getRemoteStatus: function () {
      return {
        initialized: remoteState.initialized,
        enabled: remoteState.enabled,
        syncing: remoteState.syncing,
        lastSyncAt: remoteState.lastSyncAt,
        lastError: remoteState.lastError,
      };
    },

    isRemoteEnabled: function () {
      return remoteState.enabled;
    },

    syncFromRemote: async function () {
      var client = getSupabaseClient();
      if (!client) return { synced: false, reason: 'supabase-not-configured' };

      remoteState.syncing = true;
      remoteState.lastError = null;
      try {
        var contactsResult = await client
          .from(CONTACTS_TABLE)
          .select('*')
          .order('updated_at', { ascending: false });

        if (contactsResult.error) throw contactsResult.error;

        var activitiesResult = await client
          .from(ACTIVITIES_TABLE)
          .select('*')
          .order('created_at', { ascending: false })
          .limit(REMOTE_ACTIVITY_LIMIT);

        if (activitiesResult.error) throw activitiesResult.error;

        var db = load();
        mergeDbWithRemote(db, contactsResult.data || [], activitiesResult.data || []);
        save(db);
        remoteState.lastSyncAt = new Date().toISOString();
        return { synced: true, contacts: db.contacts.length, activities: db.activities.length };
      } catch (error) {
        remoteState.lastError = error && error.message ? error.message : String(error);
        throw error;
      } finally {
        remoteState.syncing = false;
      }
    },

    /** @returns {{ db: object, contact: object }} */
    upsertContact: function (payload) {
      var db = load();
      var ix = findContactIndex(db, payload.phone, payload.business);
      var row = {
        id: ix >= 0 ? db.contacts[ix].id : 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
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
      db.contacts.sort(sortByUpdatedAtDesc);
      save(db);

      queueRemoteWrite(async function () {
        var client = getSupabaseClient();
        if (!client) return;
        var result = await client.from(CONTACTS_TABLE).upsert(toRemoteContact(row), { onConflict: 'id' });
        if (result.error) throw result.error;
      });

      return { db: db, contact: ix >= 0 ? db.contacts[ix] : db.contacts[0] };
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
        recording: !!opts.recording,
        createdAt: new Date().toISOString(),
      };
      db.activities.unshift(act);
      if (db.activities.length > REMOTE_ACTIVITY_LIMIT) db.activities.length = REMOTE_ACTIVITY_LIMIT;
      save(db);

      queueRemoteWrite(async function () {
        var client = getSupabaseClient();
        if (!client) return;
        var result = await client.from(ACTIVITIES_TABLE).upsert(toRemoteActivity(act), { onConflict: 'id' });
        if (result.error) throw result.error;
      });

      return { db: db, activity: act };
    },

    listContacts: function () {
      return load().contacts.slice().sort(sortByUpdatedAtDesc);
    },

    listActivities: function (limit) {
      var items = load().activities.slice().sort(sortByCreatedAtDesc);
      return typeof limit === 'number' ? items.slice(0, limit) : items;
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
