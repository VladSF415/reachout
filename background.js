// ReachOut background.js — service worker
'use strict';

// ── Config ─────────────────────────────────────────────────────────────────────
const FIREBASE_API_KEY    = 'AIzaSyCuVPYkibzv6r_zf8ZLC8WFPCWiJu35fG0';
const FIREBASE_PROJECT_ID = 'reachout-4e9e8';
const WEBHOOK_BASE        = 'https://reachout-production.up.railway.app';

const _FB_AUTH  = 'https://identitytoolkit.googleapis.com/v1/accounts';
const _FB_TOKEN = 'https://securetoken.googleapis.com/v1/token';
const _FS_BASE  = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

const _SESSION_KEYS = ['fb_id_token', 'fb_refresh_token', 'fb_uid', 'fb_email', 'fb_expires_at'];

// ── Side panel opens on toolbar click ────────────────────────────────────────
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ── In-memory current profile (from content.js) ───────────────────────────────
let currentProfile = null;

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const { action } = msg;

  if (action === 'PROFILE_DATA') {
    currentProfile = msg.profile;
    return;
  }

  if (action === 'GET_PROFILE_DATA') {
    sendResponse({ profile: currentProfile });
    return true;
  }

  if (action === 'SCRAPE_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      if (!tab || !tab.url?.includes('linkedin.com/in/')) {
        sendResponse({ profile: currentProfile });
        return;
      }
      try {
        const res = await chrome.tabs.sendMessage(tab.id, { action: 'SCRAPE_PROFILE' });
        if (res?.profile) currentProfile = res.profile;
        sendResponse({ profile: currentProfile });
      } catch {
        sendResponse({ profile: currentProfile });
      }
    });
    return true;
  }

  if (action === 'FIND_EMAIL') {
    handleFindEmail(msg.companyName, msg.firstName, msg.lastName).then(sendResponse);
    return true;
  }

  if (action === 'GENERATE_OUTREACH') {
    handleGenerateOutreach(msg.profile, msg.senderProfile).then(sendResponse);
    return true;
  }

  if (action === 'GET_CONTACTS') {
    getContacts().then(sendResponse);
    return true;
  }

  if (action === 'SAVE_CONTACT') {
    saveContact(msg.contact).then(sendResponse);
    return true;
  }

  if (action === 'UPDATE_CONTACT') {
    updateContact(msg.linkedinId, msg.changes).then(sendResponse);
    return true;
  }

  if (action === 'DELETE_CONTACT') {
    deleteContact(msg.linkedinId).then(sendResponse);
    return true;
  }

  if (action === 'GET_SENDER_PROFILE') {
    getSenderProfile().then(sendResponse);
    return true;
  }

  if (action === 'SAVE_SENDER_PROFILE') {
    saveSenderProfile(msg.profile).then(sendResponse);
    return true;
  }

  if (action === 'SIGN_IN')     { authSignIn(msg.email, msg.password).then(sendResponse); return true; }
  if (action === 'SIGN_UP')     { authSignUp(msg.email, msg.password).then(sendResponse); return true; }
  if (action === 'SIGN_OUT')    { authSignOut().then(sendResponse); return true; }
  if (action === 'GET_SESSION') { getSession().then(sendResponse); return true; }

  if (action === 'GET_FIREBASE_PROFILE') {
    getSession().then(session => {
      if (!session) { sendResponse({ profile: null }); return; }
      getFirebaseProfile(session.user.id, session.access_token).then(profile => sendResponse({ profile }));
    });
    return true;
  }

  if (action === 'OPEN_CHECKOUT') { openCheckout(msg.userId, msg.email).then(sendResponse); return true; }
  if (action === 'OPEN_PORTAL')   { openPortal(msg.userId).then(sendResponse); return true; }
});

// ── Find email ────────────────────────────────────────────────────────────────
async function handleFindEmail(companyName, firstName, lastName) {
  const session = await getSession();
  if (!session) return { error: 'Please sign in first.' };

  try {
    const res = await fetch(`${WEBHOOK_BASE}/find-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId:      session.user.id,
        idToken:     session.access_token,
        companyName,
        firstName,
        lastName,
      }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Email lookup failed.' };
    return { emails: data.emails };
  } catch {
    return { error: 'Network error — check your connection.' };
  }
}

// ── Generate outreach ─────────────────────────────────────────────────────────
async function handleGenerateOutreach(profile, senderProfile) {
  const session = await getSession();
  if (!session) return { error: 'Please sign in first.' };

  try {
    const res = await fetch(`${WEBHOOK_BASE}/generate-outreach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId:        session.user.id,
        idToken:       session.access_token,
        profile,
        senderProfile,
      }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error || 'Generation failed.' };
    return { messages: data.messages };
  } catch {
    return { error: 'Network error — check your connection.' };
  }
}

// ── Local contact tracker ─────────────────────────────────────────────────────
async function getContacts() {
  const s = await chrome.storage.local.get('contacts');
  return { contacts: s.contacts || [] };
}

async function saveContact(contact) {
  const s = await chrome.storage.local.get('contacts');
  const list = s.contacts || [];
  const existing = list.findIndex(c => c.linkedinId === contact.linkedinId);
  if (existing >= 0) {
    list[existing] = { ...list[existing], ...contact, updatedAt: new Date().toISOString() };
  } else {
    list.unshift({ ...contact, savedAt: new Date().toISOString(), status: 'found_email' });
  }
  await chrome.storage.local.set({ contacts: list });
  return { success: true };
}

async function updateContact(linkedinId, changes) {
  const s = await chrome.storage.local.get('contacts');
  const list = (s.contacts || []).map(c =>
    c.linkedinId === linkedinId ? { ...c, ...changes, updatedAt: new Date().toISOString() } : c
  );
  await chrome.storage.local.set({ contacts: list });
  return { success: true };
}

async function deleteContact(linkedinId) {
  const s = await chrome.storage.local.get('contacts');
  const list = (s.contacts || []).filter(c => c.linkedinId !== linkedinId);
  await chrome.storage.local.set({ contacts: list });
  return { success: true };
}

// ── Sender profile (stored locally) ──────────────────────────────────────────
async function getSenderProfile() {
  const s = await chrome.storage.local.get('senderProfile');
  return s.senderProfile || null;
}

async function saveSenderProfile(profile) {
  await chrome.storage.local.set({ senderProfile: profile });
  return { success: true };
}

// ── Firestore helpers ─────────────────────────────────────────────────────────
function _fsEncode(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) fields[k] = { nullValue: null };
    else if (typeof v === 'string')    fields[k] = { stringValue: v };
    else if (typeof v === 'number')    fields[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean')   fields[k] = { booleanValue: v };
  }
  return fields;
}

function _fsDecode(fields = {}) {
  const obj = {};
  for (const [k, v] of Object.entries(fields)) {
    if ('stringValue'  in v) obj[k] = v.stringValue;
    else if ('integerValue' in v) obj[k] = Number(v.integerValue);
    else if ('booleanValue' in v) obj[k] = v.booleanValue;
    else if ('nullValue'    in v) obj[k] = null;
  }
  return obj;
}

async function _fsGet(uid, idToken) {
  const res = await fetch(`${_FS_BASE}/users/${uid}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (res.status === 404) return null;
  const doc = await res.json();
  return doc?.fields ? _fsDecode(doc.fields) : null;
}

async function _fsCreate(uid, idToken, obj) {
  await fetch(`${_FS_BASE}/users/${uid}`, {
    method:  'PATCH',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ fields: _fsEncode(obj), currentDocument: { exists: false } }),
  }).catch(() => {});
}

// ── Firebase Auth helpers ─────────────────────────────────────────────────────
async function _fbPost(endpoint, body) {
  const res = await fetch(`${_FB_AUTH}:${endpoint}?key=${FIREBASE_API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

async function _saveSession(data) {
  await chrome.storage.local.set({
    fb_id_token:      data.idToken      || null,
    fb_refresh_token: data.refreshToken || null,
    fb_uid:           data.localId      || null,
    fb_email:         data.email        || null,
    fb_expires_at:    data.expiresIn ? Date.now() + Number(data.expiresIn) * 1000 : null,
  });
}

async function getSession() {
  let s = await chrome.storage.local.get(_SESSION_KEYS);
  if (!s.fb_id_token) return null;

  if (s.fb_expires_at && Date.now() > s.fb_expires_at - 60_000) {
    const res = await fetch(`${_FB_TOKEN}?key=${FIREBASE_API_KEY}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    `grant_type=refresh_token&refresh_token=${encodeURIComponent(s.fb_refresh_token)}`,
    });
    const data = await res.json();
    if (!data.id_token) {
      await chrome.storage.local.remove(_SESSION_KEYS);
      return null;
    }
    await chrome.storage.local.set({
      fb_id_token:      data.id_token,
      fb_refresh_token: data.refresh_token,
      fb_expires_at:    Date.now() + Number(data.expires_in) * 1000,
    });
    s = await chrome.storage.local.get(_SESSION_KEYS);
  }

  return {
    access_token: s.fb_id_token,
    user: { id: s.fb_uid, email: s.fb_email },
  };
}

async function ensureProfile(uid, idToken) {
  await _fsCreate(uid, idToken, {
    plan:                'free',
    email_lookups_used:  0,
    email_lookups_month: 0,
  });
}

async function getFirebaseProfile(userId, idToken) {
  const profile = await _fsGet(userId, idToken);
  if (!profile) return null;

  const thisMonth = Number(new Date().toISOString().slice(0, 7).replace('-', ''));
  const usedThisMonth = profile.email_lookups_month === thisMonth
    ? (profile.email_lookups_used || 0)
    : 0;

  return {
    plan:               profile.plan || 'free',
    email_lookups_used: usedThisMonth,
  };
}

// ── Auth actions ──────────────────────────────────────────────────────────────
async function authSignIn(email, password) {
  const { ok, data } = await _fbPost('signInWithPassword', { email, password, returnSecureToken: true });
  if (!ok) return { success: false, error: _friendlyError(data) };
  if (!data.emailVerified) {
    return { success: false, error: 'Please confirm your email address first — check your inbox.' };
  }
  await _saveSession(data);
  await ensureProfile(data.localId, data.idToken);
  return { success: true, email: data.email };
}

async function authSignUp(email, password) {
  const { ok, data } = await _fbPost('signUp', { email, password, returnSecureToken: true });
  if (!ok) return { success: false, error: _friendlyError(data) };
  await _fbPost('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken: data.idToken });
  return { success: false, needsConfirmation: true, error: 'Account created! Check your inbox to confirm your email, then sign in.' };
}

async function authSignOut() {
  await chrome.storage.local.remove(_SESSION_KEYS);
  return { success: true };
}

// ── Stripe ────────────────────────────────────────────────────────────────────
async function openCheckout(userId, email) {
  try {
    const res = await fetch(`${WEBHOOK_BASE}/checkout`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId, email }),
    });
    const data = await res.json();
    if (data.url) { chrome.tabs.create({ url: data.url }); return { success: true }; }
    return { success: false, error: data.error || 'No checkout URL returned.' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function openPortal(userId) {
  try {
    const res = await fetch(`${WEBHOOK_BASE}/portal-session`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ userId }),
    });
    const data = await res.json();
    if (data.url) { chrome.tabs.create({ url: data.url }); return { success: true }; }
    return { success: false, error: data.error || 'No portal URL returned.' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function _friendlyError(data) {
  const raw = String(data?.error?.message || data?.error || '').toLowerCase();
  if (raw.includes('email_exists'))      return 'An account with this email already exists. Sign in instead.';
  if (raw.includes('invalid_password') || raw.includes('invalid login credentials') || raw.includes('email not found'))
                                         return 'Incorrect email or password.';
  if (raw.includes('weak_password'))     return 'Password must be at least 6 characters.';
  if (raw.includes('invalid_email'))     return 'Please enter a valid email address.';
  if (raw.includes('too_many_attempts')) return 'Too many attempts — wait a moment and try again.';
  return data?.error?.message || data?.error || 'Something went wrong. Please try again.';
}
