// ReachOut panel.js — side panel controller
'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let currentProfile  = null;
let session         = null;
let firebaseProfile = null;
let contacts        = [];
let senderProfile   = null;
let lastMessages    = null;

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function bg(action, params = {}, timeoutMs = 20000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ error: 'Request timed out. Please try again.' }), timeoutMs);
    chrome.runtime.sendMessage({ action, ...params }, res => {
      clearTimeout(timer);
      resolve(res || {});
    });
  });
}

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Tab navigation ────────────────────────────────────────────────────────────
document.querySelectorAll('.ro-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.ro-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.ro-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-${tab.dataset.tab}`).classList.add('active');

    if (tab.dataset.tab === 'pipeline') renderPipeline();
    if (tab.dataset.tab === 'account')  refreshAccount();
    if (tab.dataset.tab === 'outreach') renderOutreachProfile();
  });
});

// ── Finder tab ────────────────────────────────────────────────────────────────
function showFinderProfile(profile) {
  currentProfile = profile;
  const noProfileEl  = $('ro-no-profile');
  const profileCard  = $('ro-profile-card');

  if (!profile || !profile.name) {
    noProfileEl.hidden = false;
    profileCard.hidden = true;
    return;
  }

  noProfileEl.hidden = true;
  profileCard.hidden = false;
  $('ro-profile-name').textContent    = profile.name;
  $('ro-profile-title').textContent   = profile.currentTitle || '';
  $('ro-profile-company').textContent = profile.currentCompany ? `at ${profile.currentCompany}` : '';

  // Reset results
  $('ro-email-results').hidden = true;
  $('ro-email-list').innerHTML = '';
  $('ro-find-error').hidden    = true;
  $('ro-find-limit').hidden    = true;
  $('ro-save-success').hidden  = true;
}

$('ro-refresh-btn').addEventListener('click', async () => {
  const btn = $('ro-refresh-btn');
  btn.classList.add('ro-spinning');
  const { profile } = await bg('SCRAPE_ACTIVE_TAB');
  showFinderProfile(profile || null);
  btn.classList.remove('ro-spinning');
});

$('ro-find-email-btn').addEventListener('click', async () => {
  if (!currentProfile) return;
  if (!session) { switchToTab('account'); return; }

  $('ro-find-error').hidden   = true;
  $('ro-find-limit').hidden   = true;
  $('ro-save-success').hidden = true;
  $('ro-email-results').hidden = true;
  $('ro-find-spinner').hidden  = false;
  $('ro-find-email-btn').disabled = true;

  const nameParts = (currentProfile.name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ') || nameParts[0] || '';

  const result = await bg('FIND_EMAIL', {
    companyName: currentProfile.currentCompany || '',
    firstName,
    lastName,
  });

  $('ro-find-spinner').hidden     = true;
  $('ro-find-email-btn').disabled = false;

  if (result.error === 'monthly_limit') {
    $('ro-find-limit').hidden = false;
    return;
  }
  if (result.error) {
    $('ro-find-error').textContent = result.error;
    $('ro-find-error').hidden = false;
    return;
  }

  const emails = result.emails || [];
  if (!emails.length) {
    $('ro-find-error').textContent = result.note || 'No email found for this company. Try a different profile.';
    $('ro-find-error').hidden = false;
    return;
  }

  renderEmailResults(emails);
});

function renderEmailResults(emails) {
  const list = $('ro-email-list');
  list.innerHTML = '';

  for (const e of emails) {
    const li = document.createElement('li');
    li.className = 'ro-email-item' + (e.confidence === 'high' ? ' high' : '');
    li.innerHTML = `
      <span class="ro-email-addr">${escHtml(e.address)}</span>
      <span class="ro-confidence ro-conf-${e.confidence}">${e.confidence === 'high' ? 'Verified' : 'Likely'}</span>
      <button class="ro-copy-email-btn" data-email="${escHtml(e.address)}">Copy</button>`;
    li.querySelector('.ro-copy-email-btn').addEventListener('click', async (evt) => {
      const btn = evt.currentTarget;
      await navigator.clipboard.writeText(btn.dataset.email).catch(() => {});
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
    list.appendChild(li);
  }

  $('ro-email-results').hidden = false;
}

$('ro-save-contact-btn').addEventListener('click', async () => {
  if (!currentProfile) return;

  const bestEmail = $('ro-email-list').querySelector('.ro-email-addr')?.textContent || '';

  await bg('SAVE_CONTACT', {
    contact: {
      linkedinId:  currentProfile.linkedinId,
      name:        currentProfile.name,
      url:         currentProfile.url,
      currentTitle:    currentProfile.currentTitle,
      currentCompany:  currentProfile.currentCompany,
      email:       bestEmail,
      status:      'found_email',
    },
  });

  contacts = (await bg('GET_CONTACTS')).contacts || [];
  $('ro-save-success').hidden = false;
  setTimeout(() => { $('ro-save-success').hidden = true; }, 2500);
});

$('ro-upgrade-from-finder').addEventListener('click', () => switchToTab('account'));

// ── Outreach tab ──────────────────────────────────────────────────────────────
function renderOutreachProfile() {
  const noProfileEl = $('ro-outreach-no-profile');
  const card        = $('ro-outreach-card');
  const setupBanner = $('ro-setup-banner');

  // Show setup banner if no sender profile
  setupBanner.hidden = !!(senderProfile?.senderName);

  if (!currentProfile || !currentProfile.name) {
    noProfileEl.hidden = false;
    card.hidden = true;
    return;
  }

  noProfileEl.hidden = true;
  card.hidden = false;
  $('ro-outreach-name').textContent    = currentProfile.name;
  $('ro-outreach-company').textContent = currentProfile.currentCompany
    ? `at ${currentProfile.currentCompany}` : '';
}

$('ro-open-setup-btn').addEventListener('click', () => {
  $('ro-setup-form').hidden = !$('ro-setup-form').hidden;
  if (!$('ro-setup-form').hidden && senderProfile) {
    $('ro-sender-name').value    = senderProfile.senderName    || '';
    $('ro-sender-company').value = senderProfile.senderCompany || '';
    $('ro-sender-offer').value   = senderProfile.senderOffer   || '';
  }
});

$('ro-save-sender-btn').addEventListener('click', async () => {
  const profile = {
    senderName:    $('ro-sender-name').value.trim(),
    senderCompany: $('ro-sender-company').value.trim(),
    senderOffer:   $('ro-sender-offer').value.trim(),
  };
  await bg('SAVE_SENDER_PROFILE', { profile });
  senderProfile = profile;
  $('ro-setup-form').hidden = true;
  $('ro-setup-banner').hidden = !!(profile.senderName);
});

$('ro-generate-btn').addEventListener('click', async () => {
  if (!currentProfile || !session) {
    if (!session) switchToTab('account');
    return;
  }

  $('ro-gen-error').hidden     = true;
  $('ro-messages-output').hidden = true;
  $('ro-gen-spinner').hidden   = false;
  $('ro-generate-btn').disabled = true;

  const result = await bg('GENERATE_OUTREACH', {
    profile: currentProfile,
    senderProfile,
  });

  $('ro-gen-spinner').hidden    = true;
  $('ro-generate-btn').disabled = false;

  if (result.error) {
    $('ro-gen-error').textContent = result.error;
    $('ro-gen-error').hidden = false;
    return;
  }

  lastMessages = result.messages;
  $('ro-conn-text').value = result.messages.connectionNote || '';
  $('ro-dm-text').value   = result.messages.coldDm         || '';
  $('ro-fu1-text').value  = result.messages.followup1      || '';
  $('ro-fu2-text').value  = result.messages.followup2      || '';
  $('ro-messages-output').hidden = false;

  updateCharCount();
});

// Connection note character counter (LinkedIn cap = 300)
function updateCharCount() {
  const textarea = $('ro-conn-text');
  const counter  = $('ro-conn-chars');
  if (!textarea || !counter) return;
  const len = textarea.value.length;
  counter.textContent = `${len} / 300`;
  counter.className = 'ro-char-count' + (len > 300 ? ' over' : '');
}
$('ro-conn-text')?.addEventListener('input', updateCharCount);

// Copy buttons on message blocks
document.querySelectorAll('.ro-copy-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const targetId = btn.dataset.target;
    const textarea = $(targetId);
    if (!textarea) return;
    try {
      await navigator.clipboard.writeText(textarea.value);
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    } catch {}
  });
});

// ── Pipeline tab ──────────────────────────────────────────────────────────────
function renderPipeline() {
  const list     = $('ro-contact-list');
  const emptyEl  = $('ro-pipe-empty');
  const countEl  = $('ro-pipe-count');

  countEl.textContent = `${contacts.length} contact${contacts.length !== 1 ? 's' : ''}`;
  emptyEl.hidden = contacts.length > 0;
  list.innerHTML = '';

  for (const c of contacts) {
    const li = document.createElement('li');
    li.className = 'ro-contact-item';
    const date = c.savedAt ? new Date(c.savedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
    li.innerHTML = `
      <div class="ro-contact-top">
        <div>
          <div class="ro-contact-name">${escHtml(c.name)}</div>
          <div class="ro-contact-role">${escHtml([c.currentTitle, c.currentCompany].filter(Boolean).join(' at '))}</div>
          ${c.email ? `<div class="ro-contact-email">${escHtml(c.email)}</div>` : ''}
          ${date ? `<div style="font-size:11px;color:var(--text-2);margin-top:3px">${date}</div>` : ''}
        </div>
        <button class="ro-delete-btn" title="Remove" data-id="${escHtml(c.linkedinId)}">&times;</button>
      </div>
      <div class="ro-contact-bottom">
        <select class="ro-status-select" data-id="${escHtml(c.linkedinId)}">
          ${['found_email','messaged','replied','converted'].map(s =>
            `<option value="${s}"${s === c.status ? ' selected' : ''}>${s.replace('_', ' ')}</option>`
          ).join('')}
        </select>
        ${c.url ? `<a href="${escHtml(c.url)}" target="_blank" rel="noopener noreferrer" class="ro-text-btn" style="font-size:11px">View ↗</a>` : ''}
      </div>`;

    li.querySelector('.ro-delete-btn').addEventListener('click', async () => {
      await bg('DELETE_CONTACT', { linkedinId: c.linkedinId });
      contacts = contacts.filter(x => x.linkedinId !== c.linkedinId);
      renderPipeline();
    });

    li.querySelector('.ro-status-select').addEventListener('change', async (e) => {
      await bg('UPDATE_CONTACT', { linkedinId: c.linkedinId, changes: { status: e.target.value } });
      const idx = contacts.findIndex(x => x.linkedinId === c.linkedinId);
      if (idx !== -1) contacts[idx].status = e.target.value;
    });

    list.appendChild(li);
  }
}

$('ro-export-btn').addEventListener('click', () => {
  if (!contacts.length) return;
  const header = ['Name', 'Title', 'Company', 'Email', 'Status', 'LinkedIn', 'Date'];
  const rows = contacts.map(c => [
    c.name, c.currentTitle, c.currentCompany, c.email || '', c.status, c.url || '',
    c.savedAt ? new Date(c.savedAt).toLocaleDateString() : '',
  ].map(v => `"${String(v || '').replace(/"/g, '""')}"`));
  const csv  = [header, ...rows].map(r => r.join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `reachout-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── Account tab ───────────────────────────────────────────────────────────────
async function refreshAccount() {
  session = await bg('GET_SESSION');
  if (!session) { showAuth(); return; }

  $('ro-account-section').hidden = false;
  $('ro-auth-section').hidden    = true;
  $('ro-account-email').textContent = session.user?.email || '';

  try {
    const { profile } = await bg('GET_FIREBASE_PROFILE');
    firebaseProfile = profile;
  } catch {}

  renderUsage();
}

function showAuth() {
  $('ro-auth-section').hidden    = false;
  $('ro-account-section').hidden = true;
}

function renderUsage() {
  if (!firebaseProfile) return;
  const plan  = firebaseProfile.plan || 'free';
  const isPro = plan === 'pro';
  const cap   = isPro ? 300 : 10;
  const used  = firebaseProfile.email_lookups_used || 0;

  $('ro-plan-badge').textContent = isPro ? 'Pro' : 'Free';
  $('ro-plan-badge').className   = 'ro-plan-badge' + (isPro ? ' pro' : '');
  $('ro-usage-count').textContent = `${used} / ${cap}`;
  $('ro-usage-fill').style.width  = `${Math.min(100, (used / cap) * 100)}%`;
  $('ro-upgrade-box').hidden = isPro;
}

$('ro-signin-btn').addEventListener('click', async () => {
  const email    = $('ro-email').value.trim();
  const password = $('ro-password').value;
  if (!email || !password) { showAuthError('Enter email and password.'); return; }
  $('ro-auth-error').hidden = true;
  $('ro-signin-btn').disabled = true;
  const result = await bg('SIGN_IN', { email, password });
  $('ro-signin-btn').disabled = false;
  if (!result.success) { showAuthError(result.error); return; }
  session = { user: { email: result.email } };
  refreshAccount();
});

$('ro-signup-btn').addEventListener('click', async () => {
  const email    = $('ro-email').value.trim();
  const password = $('ro-password').value;
  if (!email || !password) { showAuthError('Enter email and password.'); return; }
  $('ro-auth-error').hidden = true;
  $('ro-signup-btn').disabled = true;
  const result = await bg('SIGN_UP', { email, password });
  $('ro-signup-btn').disabled = false;
  if (!result.success) { showAuthError(result.error); return; }
  if (result.needsConfirmation) { showAuthError(result.error); return; }
  session = { user: { email: result.email } };
  refreshAccount();
});

function showAuthError(msg) {
  const el = $('ro-auth-error');
  el.textContent = msg;
  el.hidden = false;
}

$('ro-signout-btn').addEventListener('click', async () => {
  await bg('SIGN_OUT');
  session = null;
  firebaseProfile = null;
  showAuth();
});

$('ro-upgrade-btn').addEventListener('click', async () => {
  if (!session?.user) return;
  await bg('OPEN_CHECKOUT', { userId: session.user.id, email: session.user.email });
});

$('ro-portal-btn').addEventListener('click', async () => {
  if (!session?.user) return;
  await bg('OPEN_PORTAL', { userId: session.user.id });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function switchToTab(name) {
  const tab = document.querySelector(`.ro-tab[data-tab="${name}"]`);
  if (tab) tab.click();
}

// Listen for background PROFILE_DATA messages (SPA navigation)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'PROFILE_DATA' && msg.profile) {
    showFinderProfile(msg.profile);
    renderOutreachProfile();
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  // Load local data
  contacts      = (await bg('GET_CONTACTS')).contacts || [];
  senderProfile = await bg('GET_SENDER_PROFILE');

  // Scrape current tab
  const { profile } = await bg('SCRAPE_ACTIVE_TAB');
  showFinderProfile(profile || null);

  // Check auth silently
  session = await bg('GET_SESSION');
})();
