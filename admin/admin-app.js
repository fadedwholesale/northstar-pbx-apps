/* global NorthstarCRM */
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function adminGo(id) {
    document.querySelectorAll('.admin-nav button[data-adm]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-adm') === id);
    });
    document.querySelectorAll('.admin-section').forEach(function (s) {
      s.classList.toggle('on', s.id === 'adm-' + id);
    });
    if (id === 'crm') refreshCrmView();
    if (id === 'integrations') hydrateIntegrationHints();
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

  window.refreshCrmView = function refreshCrmView() {
    var contacts = NorthstarCRM.listContacts();
    document.getElementById('crmContacts').innerHTML = contacts.map(function (c) {
      return '<div class="crm-row"><h4>' + esc(c.business) + '</h4><p>' + esc(c.name) + ' · ' + esc(c.phone) + '</p><p><span class="pill pill-b">' + esc(c.stage) + '</span> ' + (c.lastOutcome ? '<span class="pill pill-gr">' + esc(c.lastOutcome) + '</span>' : '') + '</p></div>';
    }).join('') || '<p style="font-size:12px;color:#6b7280">No contacts yet.</p>';

    var acts = NorthstarCRM.listActivities(120);
    document.getElementById('crmActivities').innerHTML = acts.map(function (a) {
      return '<div class="act-row"><strong>' + esc(a.createdAt) + '</strong><br/>' + esc(a.agentName) + ' · ' + esc(a.business) + '<br/><span style="color:#6b7280">' + esc(a.disposition || '') + (a.notes ? ' — ' + esc(a.notes).slice(0, 140) : '') + '</span></div>';
    }).join('') || '<p style="font-size:12px;color:#6b7280">No activities.</p>';

    var stages = NorthstarCRM.load().pipelines.stages || [];
    document.getElementById('crmStages').innerHTML = stages.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('');
  };

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

  if (typeof NorthstarCRM.initialize === 'function') {
    NorthstarCRM.initialize()
      .then(function (status) {
        if (!status.enabled) NorthstarCRM.seedDemo();
        refreshCrmView();
      })
      .catch(function () {
        NorthstarCRM.seedDemo();
        refreshCrmView();
      });
  } else {
    refreshCrmView();
  }
})();
