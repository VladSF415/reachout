// ReachOut content.js — LinkedIn profile scraper
'use strict';

const PROFILE_RE = /linkedin\.com\/in\//;

function extractProfileData() {
  if (!PROFILE_RE.test(location.href)) return null;

  // Name — first h1 on profile pages
  const name = document.querySelector('h1')?.textContent?.trim() || '';
  if (!name) return null;

  // Headline — first .text-body-medium with real content (not empty or tiny)
  let headline = '';
  const bodyMediums = document.querySelectorAll('.text-body-medium');
  for (const el of bodyMediums) {
    const t = el.textContent.trim();
    if (t.length > 5 && t.length < 300 && !t.includes('\n\n\n')) {
      headline = t;
      break;
    }
  }

  // Experience section — find it by id anchor or section heading
  let currentTitle = '';
  let currentCompany = '';
  let yearsAtCompany = '';

  const expAnchor = document.querySelector('#experience');
  const expSection = expAnchor
    ? expAnchor.closest('section') || expAnchor.parentElement?.closest('section')
    : null;

  if (expSection) {
    const items = expSection.querySelectorAll('li.artdeco-list__item');
    if (items.length > 0) {
      const firstItem = items[0];
      // Collect all visible spans (aria-hidden="true" are the display spans)
      const spans = [...firstItem.querySelectorAll('span[aria-hidden="true"]')]
        .map(s => s.textContent.trim())
        .filter(Boolean);

      if (spans.length >= 1) currentTitle = spans[0];
      if (spans.length >= 2) currentCompany = spans[1].split('·')[0].trim();

      // Duration span contains "yr" or "mo" e.g. "3 yrs 2 mos"
      const dur = spans.find(s => /\byr|\bmo/.test(s));
      if (dur) {
        // "Jan 2020 – Present · 3 yrs 2 mos" → "3 yrs 2 mos"
        yearsAtCompany = dur.includes('·') ? dur.split('·').pop().trim() : dur.trim();
      }
    }
  }

  // Fallback for company: look for company link in top card area
  if (!currentCompany) {
    const companyLink = document.querySelector('a[href*="/company/"] span[aria-hidden="true"]');
    if (companyLink) currentCompany = companyLink.textContent.trim();
  }

  // Connection degree
  const degreeEl = document.querySelector('.dist-value') ||
                   document.querySelector('[class*="distance-badge"]');
  const connectionDegree = degreeEl?.textContent?.replace('degree connection', '').trim() || '';

  // LinkedIn username from URL
  const linkedinId = location.href.match(/\/in\/([^/?#]+)/)?.[1] || '';

  return {
    name,
    headline,
    currentTitle,
    currentCompany,
    yearsAtCompany,
    connectionDegree,
    linkedinId,
    url: location.href,
  };
}

function notifyBackground(profile) {
  if (!profile) return;
  chrome.runtime.sendMessage({ action: 'PROFILE_DATA', profile }).catch(() => {});
}

// Respond to panel scrape requests
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'SCRAPE_PROFILE') {
    // Give DOM a moment to settle after SPA nav
    setTimeout(() => sendResponse({ profile: extractProfileData() }), 600);
    return true;
  }
});

// Watch for SPA navigation (LinkedIn is a SPA)
let lastUrl = location.href;
const navObserver = new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    if (PROFILE_RE.test(location.href)) {
      setTimeout(() => notifyBackground(extractProfileData()), 1500);
    }
  }
});
navObserver.observe(document.documentElement, { subtree: true, childList: true });

// Initial scrape after page settles
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(() => notifyBackground(extractProfileData()), 1200));
} else {
  setTimeout(() => notifyBackground(extractProfileData()), 1200);
}
