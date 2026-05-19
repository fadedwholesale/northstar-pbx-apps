/**
 * Northstar CRM store
 * - Local-first for fast UI.
 * - Optional Supabase sync when configured.
 */
(function (global) {
  var STORAGE_KEY = 'northstar_crm_v1';
  var CONTACTS_TABLE = 'northstar_contacts';
  var ACTIVITIES_TABLE = 'northstar_activities';
  var REMOTE_ACTIVITY_LIMIT = 2500;

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

  function findContactIndexById(db, id) {
    if (!id) return -1;
    var sid = String(id);
    for (var j = 0; j < db.contacts.length; j++) {
      if (String(db.contacts[j].id) === sid) return j;
    }
    return -1;
  }

  /** Partial updates (e.g. disposition) must not wipe lead ownership. */
  function buildContactRow(existing, payload) {
    var prev = existing || {};
    var p = payload || {};
    var hasAid = Object.prototype.hasOwnProperty.call(p, 'assignedAgentId');
    var hasAname = Object.prototype.hasOwnProperty.call(p, 'assignedAgentName');
    var hasSource = Object.prototype.hasOwnProperty.call(p, 'sourceFile');
    var hasImported = Object.prototype.hasOwnProperty.call(p, 'importedAt');
    return {
      id: prev.id || p.id || 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      business: p.business != null && p.business !== '' ? p.business : prev.business || 'Unknown',
      name: p.name != null ? p.name : prev.name || '',
      phone: p.phone != null ? p.phone : prev.phone || '',
      city: p.city != null ? p.city : prev.city || '',
      vertical: p.vertical != null ? p.vertical : prev.vertical || '',
      stage: p.stage != null ? p.stage : prev.stage || 'Working',
      lastOutcome: Object.prototype.hasOwnProperty.call(p, 'lastOutcome') ? p.lastOutcome : prev.lastOutcome || null,
      assignedAgentId: hasAid ? p.assignedAgentId || null : prev.assignedAgentId || null,
      assignedAgentName: hasAname ? p.assignedAgentName || null : prev.assignedAgentName || null,
      sourceFile: hasSource ? p.sourceFile || null : prev.sourceFile || null,
      importedAt: hasImported ? p.importedAt || null : prev.importedAt || null,
      updatedAt: new Date().toISOString(),
    };
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
      assigned_agent_id: localContact.assignedAgentId || null,
      assigned_agent_name: localContact.assignedAgentName || null,
      source_file: localContact.sourceFile || null,
      imported_at: localContact.importedAt || null,
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
      assignedAgentId: remoteContact.assigned_agent_id || null,
      assignedAgentName: remoteContact.assigned_agent_name || null,
      sourceFile: remoteContact.source_file || null,
      importedAt: remoteContact.imported_at || null,
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

  function isPendingLocalContactId(id) {
    return String(id || '').indexOf('c_') === 0;
  }

  function isPendingLocalActivityId(id) {
    return String(id || '').indexOf('a_') === 0;
  }

  /**
   * Remote is source of truth: rows removed in Supabase must disappear locally.
   * Keep only optimistic local rows whose ids are client-pending (c_* / a_*)
   * and not yet returned by the server fetch.
   */
  function mergeDbWithRemote(db, remoteContacts, remoteActivities) {
    var remoteList = remoteContacts || [];
    var remoteIds = {};
    remoteList.forEach(function (c) {
      if (c && c.id) remoteIds[c.id] = true;
    });
    var fromRemote = remoteList.map(fromRemoteContact);
    var pendingContacts = (db.contacts || []).filter(function (c) {
      return c && c.id && !remoteIds[c.id] && isPendingLocalContactId(c.id);
    });
    db.contacts = fromRemote.concat(pendingContacts).sort(sortByUpdatedAtDesc);

    var actRemote = remoteActivities || [];
    var remoteActIds = {};
    actRemote.forEach(function (a) {
      if (a && a.id) remoteActIds[a.id] = true;
    });
    var fromRemoteAct = actRemote.map(fromRemoteActivity);
    var pendingActs = (db.activities || []).filter(function (a) {
      return a && a.id && !remoteActIds[a.id] && isPendingLocalActivityId(a.id);
    });
    var mergedActs = fromRemoteAct.concat(pendingActs).sort(sortByCreatedAtDesc);
    if (mergedActs.length > REMOTE_ACTIVITY_LIMIT) mergedActs.length = REMOTE_ACTIVITY_LIMIT;
    db.activities = mergedActs;
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
        var PAGE = 1000;
        var remoteContactRows = [];
        var offset = 0;
        for (;;) {
          var contactsPage = await client
            .from(CONTACTS_TABLE)
            .select('*')
            .order('updated_at', { ascending: false })
            .range(offset, offset + PAGE - 1);
          if (contactsPage.error) throw contactsPage.error;
          var chunk = contactsPage.data || [];
          remoteContactRows = remoteContactRows.concat(chunk);
          if (chunk.length < PAGE) break;
          offset += PAGE;
          if (offset > 200000) break;
        }

        var activitiesResult = await client
          .from(ACTIVITIES_TABLE)
          .select('*')
          .order('created_at', { ascending: false })
          .limit(REMOTE_ACTIVITY_LIMIT);

        if (activitiesResult.error) throw activitiesResult.error;

        var db = load();
        mergeDbWithRemote(db, remoteContactRows, activitiesResult.data || []);
        // Belt-and-suspenders: if the server returned no contacts, never keep stale UUID rows locally.
        if (!remoteContactRows.length) {
          db.contacts = (db.contacts || []).filter(function (c) {
            return c && c.id && isPendingLocalContactId(c.id);
          });
        }
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
      var ix = -1;
      if (payload && payload.id) ix = findContactIndexById(db, payload.id);
      if (ix < 0) ix = findContactIndex(db, payload.phone, payload.business);
      var existing = ix >= 0 ? db.contacts[ix] : null;
      var row = buildContactRow(existing, payload);
      if (ix >= 0) db.contacts[ix] = row;
      else db.contacts.push(row);
      db.contacts.sort(sortByUpdatedAtDesc);
      save(db);

      queueRemoteWrite(async function () {
        var client = getSupabaseClient();
        if (!client) return;
        var result = await client.from(CONTACTS_TABLE).upsert(toRemoteContact(row), { onConflict: 'id' });
        if (result.error) throw result.error;
      });

      var outContact = row;
      for (var k = 0; k < db.contacts.length; k++) {
        if (db.contacts[k].id === row.id) {
          outContact = db.contacts[k];
          break;
        }
      }
      return { db: db, contact: outContact };
    },

    /**
     * Same as upsertContact but awaits northstar_contacts upsert before returning.
     * Required before inserting northstar_call_list_items (FK on contact_id).
     */
    upsertContactAwaitRemote: async function (payload) {
      var db = load();
      var ix = -1;
      if (payload && payload.id) ix = findContactIndexById(db, payload.id);
      if (ix < 0) ix = findContactIndex(db, payload.phone, payload.business);
      var existing = ix >= 0 ? db.contacts[ix] : null;
      var row = buildContactRow(existing, payload);
      if (ix >= 0) db.contacts[ix] = row;
      else db.contacts.push(row);
      db.contacts.sort(sortByUpdatedAtDesc);

      var client = getSupabaseClient();
      if (!client || !remoteState.enabled) {
        save(db);
        return { db: db, contact: row };
      }
      var result = await client.from(CONTACTS_TABLE).upsert(toRemoteContact(row), { onConflict: 'id' });
      if (result.error) throw result.error;
      save(db);
      var outContact = row;
      for (var k = 0; k < db.contacts.length; k++) {
        if (db.contacts[k].id === row.id) {
          outContact = db.contacts[k];
          break;
        }
      }
      return { db: db, contact: outContact };
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

    /** Optimistic local remove so admin UI updates immediately after deletes. */
    removeContactsLocal: function (contactIds) {
      var ids = (contactIds || []).map(function (x) {
        return String(x || '').trim();
      }).filter(Boolean);
      if (!ids.length) return load();
      var idSet = {};
      ids.forEach(function (id) {
        idSet[id] = true;
      });
      var db = load();
      db.contacts = (db.contacts || []).filter(function (c) {
        return !(c && c.id && idSet[String(c.id)]);
      });
      db.activities = (db.activities || []).filter(function (a) {
        return !(a && a.contactId && idSet[String(a.contactId)]);
      });
      save(db);
      return db;
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
        { business: '78255 Plumbing', name: 'Dan K.', phone: '(210) 555-0488', city: 'San Antonio, TX', vertical: 'Contractor', stage: 'Working' },
        { business: 'Southside Roofing', name: 'Phil R.', phone: '(210) 555-0562', city: 'San Antonio, TX', vertical: 'Contractor', stage: 'Working' },
        { business: 'Prestige Shine Co.', name: 'Lena V.', phone: '(210) 555-0614', city: 'San Antonio, TX', vertical: 'Detailing', stage: 'Working' },
        { business: 'Taco Fiesta SA', name: 'Omar G.', phone: '(210) 555-0733', city: 'San Antonio, TX', vertical: 'Restaurant', stage: 'Working' },
      ].forEach(function (p) {
        CRM.upsertContact(p);
      });
      return load();
    },
  };

  global.NorthstarCRM = CRM;
})(typeof window !== 'undefined' ? window : this);
