// ReachOut webhook server — Railway (Node.js + Express)
'use strict';

const express    = require('express');
const Stripe     = require('stripe');
const admin      = require('firebase-admin');
const { Resend } = require('resend');
const dns      = require('dns').promises;
const net      = require('net');

const app = express();

console.log('Env check — FIREBASE_SERVICE_ACCOUNT:', process.env.FIREBASE_SERVICE_ACCOUNT ? 'SET' : 'MISSING');
console.log('Env check — STRIPE_SECRET_KEY:',        process.env.STRIPE_SECRET_KEY        ? 'SET' : 'MISSING');

// ── Lazy singletons ───────────────────────────────────────────────────────────
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
  return Stripe(process.env.STRIPE_SECRET_KEY);
}

function getDb() {
  if (!admin.apps.length) {
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  }
  return admin.firestore();
}

// ── CORS (chrome-extension origins) ──────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin.startsWith('chrome-extension://') || origin === '') {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const PORT         = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://reachout-production.up.railway.app';

const PRICE_PRO = 'price_1TPYMaIwh8neLfLGNYutwJdh';

const MONTHLY_CAPS = { free: 10, pro: 300 };

app.get('/', (_req, res) => res.send('ReachOut webhook server OK'));

// ── GET /get-profile ──────────────────────────────────────────────────────────
app.post('/get-profile', async (req, res) => {
  const { userId, idToken } = req.body || {};
  if (!userId || !idToken) return res.status(400).json({ error: 'Missing fields.' });

  const decoded = await verifyToken(idToken);
  if (!decoded || decoded.uid !== userId) return res.status(401).json({ error: 'Unauthorized.' });

  try {
    const db  = getDb();
    const doc = await db.collection('users').doc(userId).get();

    if (!doc.exists) {
      await db.collection('users').doc(userId).set({
        plan: 'free', email_lookups_used: 0, email_lookups_month: 0,
      }, { merge: true });
      return res.json({ profile: { plan: 'free', email_lookups_used: 0 } });
    }

    const d = doc.data();
    const thisMonth = Number(new Date().toISOString().slice(0, 7).replace('-', ''));
    const used = d.email_lookups_month === thisMonth ? (d.email_lookups_used || 0) : 0;

    res.json({ profile: { plan: d.plan || 'free', email_lookups_used: used } });
  } catch (err) {
    console.error('get-profile error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Auth helper ───────────────────────────────────────────────────────────────
async function verifyToken(idToken) {
  try {
    return await admin.auth().verifyIdToken(idToken);
  } catch {
    return null;
  }
}

// ── Email lookup cap check + increment ───────────────────────────────────────
async function checkAndIncrementCap(userId) {
  const db = getDb();
  const ref = db.collection('users').doc(userId);
  const doc = await ref.get();

  const thisMonth = Number(new Date().toISOString().slice(0, 7).replace('-', '')); // YYYYMM

  let plan = 'free';
  let used = 0;

  if (doc.exists) {
    const d = doc.data();
    plan = d.plan || 'free';
    const sameMonth = d.email_lookups_month === thisMonth;
    used = sameMonth ? (d.email_lookups_used || 0) : 0;
  }

  const cap = MONTHLY_CAPS[plan] ?? MONTHLY_CAPS.free;

  if (used >= cap) {
    return { allowed: false, plan, cap, used };
  }

  await ref.set({
    email_lookups_used:  used + 1,
    email_lookups_month: thisMonth,
  }, { merge: true });

  return { allowed: true, plan, cap, used: used + 1 };
}

// ── Domain guessing from company name ────────────────────────────────────────
function guessCompanyDomains(companyName) {
  if (!companyName) return [];

  const cleaned = companyName
    .replace(/\b(inc\.?|llc\.?|corp\.?|ltd\.?|co\.?|company|group|holdings|international|solutions|services|technologies|technology|tech|global|the)\b/gi, '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .trim()
    .toLowerCase();

  const words = cleaned.split(/\s+/).filter(w => w.length > 0);
  if (!words.length) return [];

  const joined    = words.join('');
  const firstWord = words[0];
  const hyphen    = words.join('-');

  const candidates = new Set();

  // Primary guesses: most companies use these patterns
  if (firstWord.length >= 2)  candidates.add(`${firstWord}.com`);
  if (joined !== firstWord)   candidates.add(`${joined}.com`);
  if (hyphen !== joined && hyphen !== firstWord) candidates.add(`${hyphen}.com`);

  // Tech startup .io variants
  if (firstWord.length >= 3)  candidates.add(`${firstWord}.io`);
  if (joined !== firstWord)   candidates.add(`${joined}.io`);

  return [...candidates].slice(0, 6); // max 6 domain candidates
}

// ── Email pattern generation ──────────────────────────────────────────────────
function generateEmailPatterns(firstName, lastName, domain) {
  const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = lastName.toLowerCase().replace(/[^a-z]/g, '');
  if (!f || !l || !domain) return [];

  return [
    `${f}.${l}@${domain}`,
    `${f}${l}@${domain}`,
    `${f[0]}.${l}@${domain}`,
    `${f}@${domain}`,
    `${f[0]}${l}@${domain}`,
  ];
}

// ── DNS MX check ──────────────────────────────────────────────────────────────
async function hasMxRecords(domain) {
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    return Array.isArray(records) && records.length > 0;
  } catch {
    return false;
  }
}

// ── SMTP verification (best-effort — port 25 may be blocked on some hosts) ──
async function smtpVerify(email, domain) {
  return new Promise(async (resolve) => {
    let mxHost;
    try {
      const records = await dns.resolveMx(domain);
      if (!records?.length) return resolve('unknown');
      mxHost = records.sort((a, b) => a.priority - b.priority)[0].exchange;
    } catch {
      return resolve('unknown');
    }

    const timeout = setTimeout(() => {
      socket.destroy();
      resolve('unknown');
    }, 6000);

    const socket = net.createConnection({ host: mxHost, port: 25 });
    let buf = '';
    let step = 0;

    socket.on('connect', () => {});

    socket.on('data', chunk => {
      buf += chunk.toString();

      if (step === 0 && buf.includes('220')) {
        buf = '';
        step = 1;
        socket.write('EHLO reachout.app\r\n');
      } else if (step === 1 && /^250/m.test(buf)) {
        buf = '';
        step = 2;
        socket.write('MAIL FROM:<noreply@reachout.app>\r\n');
      } else if (step === 2 && /^250/m.test(buf)) {
        buf = '';
        step = 3;
        socket.write(`RCPT TO:<${email}>\r\n`);
      } else if (step === 3) {
        clearTimeout(timeout);
        socket.write('QUIT\r\n');
        socket.destroy();

        const code = parseInt(buf.trim().slice(0, 3), 10);
        if (code === 250 || code === 251) return resolve('verified');
        if (code >= 550 && code <= 554)  return resolve('invalid');
        resolve('unknown'); // catch-all, greylisted, or temporarily unavailable
      }
    });

    socket.on('error', () => {
      clearTimeout(timeout);
      resolve('unknown');
    });

    socket.on('close', () => {
      clearTimeout(timeout);
      if (step < 3) resolve('unknown');
    });
  });
}

// ── POST /find-email ──────────────────────────────────────────────────────────
app.post('/find-email', async (req, res) => {
  const { userId, idToken, companyName, firstName, lastName } = req.body || {};

  if (!userId || !idToken || !companyName || !firstName || !lastName) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  // Verify Firebase token
  const decoded = await verifyToken(idToken);
  if (!decoded || decoded.uid !== userId) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  // Check monthly cap
  const cap = await checkAndIncrementCap(userId);
  if (!cap.allowed) {
    return res.status(429).json({
      error: 'monthly_limit',
      plan:  cap.plan,
      cap:   cap.cap,
      message: `Monthly limit of ${cap.cap} email lookups reached. Resets on the 1st.`,
    });
  }

  // Find the best domain for this company
  const domainCandidates = guessCompanyDomains(companyName);
  let workingDomain = null;

  for (const domain of domainCandidates) {
    const hasMx = await hasMxRecords(domain);
    if (hasMx) { workingDomain = domain; break; }
  }

  if (!workingDomain) {
    return res.json({
      emails: [],
      note: 'Could not resolve a mail server for this company. Try entering the company domain manually.',
    });
  }

  // Generate patterns + verify via SMTP
  const patterns = generateEmailPatterns(firstName, lastName, workingDomain);
  const results  = [];

  for (const email of patterns) {
    const smtpResult = await smtpVerify(email, workingDomain);

    if (smtpResult === 'invalid') continue; // skip known-invalid

    let confidence;
    if (smtpResult === 'verified') confidence = 'high';
    else if (smtpResult === 'unknown') confidence = 'medium'; // domain valid, smtp uncertain

    results.push({ address: email, confidence, domain: workingDomain });

    // If we have a high-confidence result, no need to check more
    if (smtpResult === 'verified') break;
  }

  // If no SMTP results at all, return top 2 patterns at medium confidence
  if (results.length === 0) {
    patterns.slice(0, 2).forEach(email =>
      results.push({ address: email, confidence: 'medium', domain: workingDomain })
    );
  }

  res.json({ emails: results });
});

// ── Template engine ───────────────────────────────────────────────────────────

function classifyRole(title = '') {
  const t = title.toLowerCase();
  if (/\b(founder|co.?founder|ceo|chief executive|president|owner|proprietor)\b/.test(t)) return 'founder';
  if (/\b(cto|cmo|coo|cfo|cpo|c[a-z]o|vp|vice.?president|svp|evp|chief)\b/.test(t)) return 'executive';
  if (/\b(recruiter|talent|hr|human resources|people ops|people partner|ta manager)\b/.test(t)) return 'recruiter';
  if (/\b(sales|account.?exec|account executive|ae|sdr|bdr|business dev|revenue|account manager)\b/.test(t)) return 'sales';
  if (/\b(marketing|growth|content|seo|social media|brand|demand gen|campaign|digital)\b/.test(t)) return 'marketing';
  if (/\b(engineer|developer|dev|programmer|architect|sre|devops|ml|data scientist|data engineer|fullstack|backend|frontend)\b/.test(t)) return 'engineer';
  if (/\b(manager|director|head of|lead |team lead)\b/.test(t)) return 'manager';
  return 'general';
}

function yearsNote(yearsAtCompany) {
  if (!yearsAtCompany) return '';
  return `, having been there ${yearsAtCompany}`;
}

function render(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}

const TEMPLATES = {
  founder: [
    {
      connectionNote: "Hi {firstName} — love what you're building at {company}. Would love to connect and stay in touch with the founder community.",
      coldDm: "Hi {firstName},\n\nI've been following {company}'s progress and genuinely impressed with what you've built{yearsNote}.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nThought there might be a natural fit. Would a quick 20-minute call make sense?",
      followup1: "Hi {firstName} — just wanted to follow up in case my last message got lost. Happy to share more details or answer any questions upfront. Worth a quick chat?",
      followup2: "Hi {firstName}, last follow-up from me — if timing isn't right, totally understood. Feel free to reach out whenever it makes more sense.",
    },
    {
      connectionNote: "Hi {firstName} — {company} has been on my radar. I connect with founders building interesting things. Would love to stay in touch.",
      coldDm: "Hi {firstName},\n\nBig fan of what you're creating at {company}. Founders building in this space are exactly who I love talking to.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould you be open to a brief call to see if there's a fit?",
      followup1: "Hi {firstName} — circling back on my last note. Happy to make it worth your time — would a 15-minute call work?",
      followup2: "Hi {firstName}, I'll keep this short — if there's any interest in what I shared, I'm happy to chat. Otherwise, best of luck with {company}.",
    },
    {
      connectionNote: "Hi {firstName}, always excited to connect with founders doing real work. {company} caught my eye — would love to be in each other's networks.",
      coldDm: "Hi {firstName},\n\nI rarely reach out cold, but {company} kept coming up in conversations I was having.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nWould love to see if this is relevant. Open to a quick call?",
      followup1: "Hi {firstName} — wanted to bump this in case it got buried. No pressure — even a quick 'not right now' helps me know where we stand.",
      followup2: "Hi {firstName}, one last note — if the timing ever changes, feel free to reach out. Wishing {company} continued success.",
    },
    {
      connectionNote: "Hi {firstName} — I work with founders and your name keeps coming up. Would love to connect.",
      coldDm: "Hi {firstName},\n\nBeen keeping an eye on {company}{yearsNote} — great work building this.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nThink it could be relevant to where you are right now. Open to a quick chat?",
      followup1: "Hi {firstName} — following up in case timing was off. What does your schedule look like this week for a quick call?",
      followup2: "Hi {firstName}, making this my last follow-up. If it ever makes sense to connect, you know where to find me. Best of luck.",
    },
    {
      connectionNote: "Hi {firstName} — {company} is doing impressive work. Would love to connect with you.",
      coldDm: "Hi {firstName},\n\nI follow companies like {company} closely and your story stood out.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nWould love 20 minutes if you think there could be a fit.",
      followup1: "Hi {firstName} — just wanted to make sure my message landed. Happy to send over something concrete if that would help.",
      followup2: "Hi {firstName}, I'll leave you alone after this — but if the topic ever becomes relevant, don't hesitate to reach out.",
    },
  ],

  executive: [
    {
      connectionNote: "Hi {firstName} — your work leading {company} stood out. Would love to connect with leaders who are shaping the space.",
      coldDm: "Hi {firstName},\n\nYour tenure at {company}{yearsNote} is impressive — building at that level is no easy feat.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love to connect and see if there's a fit. Open to a quick call?",
      followup1: "Hi {firstName} — following up on my last message. Happy to share a brief overview first if that would help. Worth 15 minutes?",
      followup2: "Hi {firstName}, last follow-up from me — if timing isn't right, feel free to reach out down the road.",
    },
    {
      connectionNote: "Hi {firstName}, always looking to connect with executives doing interesting work. What you're building at {company} fits that perfectly.",
      coldDm: "Hi {firstName},\n\nI work closely with leaders at companies like {company} and your background immediately stood out.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nThought there could be a good fit. Do you have 20 minutes this week?",
      followup1: "Hi {firstName} — wanted to follow up. I'll keep it short: would a quick intro call make sense?",
      followup2: "Hi {firstName}, won't take more of your time after this. If it ever makes sense, feel free to reach back out.",
    },
    {
      connectionNote: "Hi {firstName} — I respect what you've built at {company}. Would love to connect and stay in each other's network.",
      coldDm: "Hi {firstName},\n\nI came across your profile while researching leadership in this space — your experience at {company} is exactly the kind of background I was looking for.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love to find a time to connect — does a brief call work?",
      followup1: "Hi {firstName} — circling back here. Even a quick 'not a fit right now' is helpful so I know where things stand.",
      followup2: "Hi {firstName}, making this my last check-in. Hope things are going well at {company} — feel free to reach out anytime.",
    },
    {
      connectionNote: "Hi {firstName} — I follow {company} closely. Would love to connect with the leadership team.",
      coldDm: "Hi {firstName},\n\n{company} has been on my radar for a while and your role there is particularly interesting to me.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nWould a quick 15-minute call make sense to explore?",
      followup1: "Hi {firstName} — just wanted to bump this in case it slipped through. Happy to adjust timing or format if easier.",
      followup2: "Hi {firstName}, last one from me. If there's interest in the future, you know where to find me.",
    },
    {
      connectionNote: "Hi {firstName} — noticed your work at {company} and would love to add you to my network.",
      coldDm: "Hi {firstName},\n\nI don't often reach out cold, but {company} specifically came up in conversations I've been having.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love 20 minutes to share what I mean specifically — worth a call?",
      followup1: "Hi {firstName} — following up one more time. Happy to send a quick overview by email first if that's easier.",
      followup2: "Hi {firstName}, making this my last message. Best of luck with {company} — reach out anytime if the timing changes.",
    },
  ],

  manager: [
    {
      connectionNote: "Hi {firstName} — I work with teams in this space and would love to connect. {company} is doing interesting work.",
      coldDm: "Hi {firstName},\n\nYour role at {company} caught my attention — leading a team in this area is exactly what I've been looking for.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love to explore if there's a fit. Open to a quick call?",
      followup1: "Hi {firstName} — just following up on my last message. Happy to make it quick — even 15 minutes would be great.",
      followup2: "Hi {firstName}, last message from me. If timing changes, feel free to reach out.",
    },
    {
      connectionNote: "Hi {firstName}, always great to connect with leaders at growing companies like {company}.",
      coldDm: "Hi {firstName},\n\nI've been connecting with team leaders at companies like {company} and your profile specifically stood out.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nThought there could be a fit. Would a quick call work?",
      followup1: "Hi {firstName} — circling back in case the timing was off. What does your week look like for a quick chat?",
      followup2: "Hi {firstName}, one last follow-up. If there's ever a good time, I'm easy to reach.",
    },
    {
      connectionNote: "Hi {firstName} — I'd love to connect. Your work at {company} looks like exactly the kind of team I like to stay in touch with.",
      coldDm: "Hi {firstName},\n\n{company} keeps coming up in my conversations and your role managing the team there makes you exactly who I should be talking to.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love 20 minutes — does that work?",
      followup1: "Hi {firstName} — bumping this in case it got lost. Happy to send details first if that's easier.",
      followup2: "Hi {firstName}, last check-in from me. Best of luck at {company} — reach out anytime.",
    },
    {
      connectionNote: "Hi {firstName} — love what {company} is doing in this space. Would love to be connected.",
      coldDm: "Hi {firstName},\n\nI've been researching teams doing work like {company} and your name came up. Impressive background{yearsNote}.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nWould a quick call make sense?",
      followup1: "Hi {firstName} — following up. Even just 15 minutes would be valuable. Does this week work?",
      followup2: "Hi {firstName}, making this my last follow-up. Feel free to reach out whenever makes sense.",
    },
    {
      connectionNote: "Hi {firstName} — came across your profile and would love to connect. Great work at {company}.",
      coldDm: "Hi {firstName},\n\nI rarely reach out cold but {company} stood out specifically.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nThink it could be worth 15 minutes. Open to a quick chat?",
      followup1: "Hi {firstName} — one more follow-up. Happy to answer any questions by email first if that's easier.",
      followup2: "Hi {firstName}, I'll leave it here. If there's any interest, you know where to find me.",
    },
  ],

  recruiter: [
    {
      connectionNote: "Hi {firstName} — I love connecting with talent professionals. Would be great to have you in my network.",
      coldDm: "Hi {firstName},\n\nI saw your work in talent at {company} and wanted to reach out directly.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nThought there could be a good fit to collaborate. Open to a quick call?",
      followup1: "Hi {firstName} — following up in case my message got lost. Even 15 minutes would be great.",
      followup2: "Hi {firstName}, last follow-up from me. If timing changes, feel free to reach back out.",
    },
    {
      connectionNote: "Hi {firstName}, always happy to connect with people doing interesting work in recruiting and talent.",
      coldDm: "Hi {firstName},\n\nTalent professionals at companies like {company} are exactly who I've been hoping to connect with.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nWould love to find 20 minutes. Does that work?",
      followup1: "Hi {firstName} — circling back. Happy to make it short — even 10 minutes over a call would be great.",
      followup2: "Hi {firstName}, last one from me. Best of luck with your work at {company}.",
    },
    {
      connectionNote: "Hi {firstName} — your work at {company} is impressive. Would love to stay connected.",
      coldDm: "Hi {firstName},\n\nYour name came up when I was looking into talent teams doing great work, and {company} is one I respect.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould a quick call work this week?",
      followup1: "Hi {firstName} — bumping this one more time. Happy to start with an intro email if that's easier.",
      followup2: "Hi {firstName}, making this my last check-in. Feel free to reach out anytime.",
    },
    {
      connectionNote: "Hi {firstName} — I connect with HR and talent professionals regularly. Would love to add you to my network.",
      coldDm: "Hi {firstName},\n\nI follow talent teams at companies like {company} and your experience specifically stood out{yearsNote}.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nWould love to explore a fit. Open to a call?",
      followup1: "Hi {firstName} — following up. Is there a better time or format that works for you?",
      followup2: "Hi {firstName}, last message from me. I'm easy to reach whenever the timing is right.",
    },
    {
      connectionNote: "Hi {firstName} — the talent work at {company} is interesting. Would love to connect.",
      coldDm: "Hi {firstName},\n\nI don't often reach out cold but {company}'s talent operation caught my attention.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nDoes 15 minutes make sense to explore?",
      followup1: "Hi {firstName} — one last follow-up. Happy to send a quick overview by message if that's easier.",
      followup2: "Hi {firstName}, I'll leave it here. Reach out anytime if it ever makes sense.",
    },
  ],

  sales: [
    {
      connectionNote: "Hi {firstName} — I work in revenue and would love to connect with others building in this space.",
      coldDm: "Hi {firstName},\n\nFellow sales professional here — your role at {company} caught my eye and I wanted to reach out directly.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love to find 20 minutes to connect. Open to a call?",
      followup1: "Hi {firstName} — just following up in case my last message slipped through. Does this week work for a quick chat?",
      followup2: "Hi {firstName}, last follow-up from me. If the timing ever changes, feel free to reach out.",
    },
    {
      connectionNote: "Hi {firstName}, always good to connect with sales professionals doing interesting work. Would love to be in each other's networks.",
      coldDm: "Hi {firstName},\n\nI respect what {company} is doing in the market and your background in sales there is impressive{yearsNote}.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nThought there could be a fit. Open to a quick call?",
      followup1: "Hi {firstName} — circling back. Happy to make it short — even 15 minutes would be great.",
      followup2: "Hi {firstName}, making this my last follow-up. Best of luck at {company}.",
    },
    {
      connectionNote: "Hi {firstName} — love what {company} is doing in the market. Would love to connect.",
      coldDm: "Hi {firstName},\n\nI connect with sales leaders at companies like {company} regularly — your profile specifically stood out.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love to see if there's a fit. Does a quick call work?",
      followup1: "Hi {firstName} — one more follow-up. Happy to answer any questions by message first if easier.",
      followup2: "Hi {firstName}, I'll leave it here. Reach out whenever the timing is right.",
    },
    {
      connectionNote: "Hi {firstName} — came across your profile and would love to add you to my sales network.",
      coldDm: "Hi {firstName},\n\n{company} has come up a lot in my conversations lately and your name specifically was recommended.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nWould 20 minutes make sense this week?",
      followup1: "Hi {firstName} — following up one more time. Happy to adjust format — email, call, or video — whatever works best for you.",
      followup2: "Hi {firstName}, last one from me. Feel free to reach out whenever it makes sense.",
    },
    {
      connectionNote: "Hi {firstName} — would love to connect and share what's been working. {company} looks exciting.",
      coldDm: "Hi {firstName},\n\nI rarely reach out cold but {company} stood out specifically in this space.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love to explore if there's a fit. Open to a quick call?",
      followup1: "Hi {firstName} — bumping this one last time. Even 10 minutes would be worth it.",
      followup2: "Hi {firstName}, making this my last follow-up. Best of luck — feel free to reach out anytime.",
    },
  ],

  marketing: [
    {
      connectionNote: "Hi {firstName} — love the work {company} is doing in this space. Would love to connect with you.",
      coldDm: "Hi {firstName},\n\nI follow marketing and growth work at companies like {company} and your profile stood out immediately.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love to explore a fit. Open to a quick call?",
      followup1: "Hi {firstName} — just following up in case my message got lost. Does this week work for a quick chat?",
      followup2: "Hi {firstName}, last follow-up from me. Feel free to reach out whenever the timing works.",
    },
    {
      connectionNote: "Hi {firstName}, always happy to connect with marketers and growth professionals. Would love to be in each other's networks.",
      coldDm: "Hi {firstName},\n\nI work with marketing teams regularly and your work at {company}{yearsNote} is exactly the kind of experience I've been looking for.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nThought there might be a fit. Does a quick call work?",
      followup1: "Hi {firstName} — circling back. Happy to keep it short — 15 minutes max. Does that work?",
      followup2: "Hi {firstName}, making this my last follow-up. Best of luck with the work at {company}.",
    },
    {
      connectionNote: "Hi {firstName} — your role at {company} caught my eye. Would love to stay connected.",
      coldDm: "Hi {firstName},\n\nMarketing teams at companies like {company} are exactly who I love talking to — your profile in particular stood out.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love to find 20 minutes. Does that work?",
      followup1: "Hi {firstName} — one last follow-up. Happy to send a quick overview by email if that's easier.",
      followup2: "Hi {firstName}, I'll leave it here. Reach out anytime if it ever makes sense.",
    },
    {
      connectionNote: "Hi {firstName} — I work with marketing teams and wanted to connect. {company} is on my radar.",
      coldDm: "Hi {firstName},\n\n{company} has been on my radar for a while and your role there makes you exactly who I should be talking to.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nWould 20 minutes work this week?",
      followup1: "Hi {firstName} — following up. Is there a better time that works for you?",
      followup2: "Hi {firstName}, last check-in from me. Feel free to reach out anytime.",
    },
    {
      connectionNote: "Hi {firstName} — I follow {company} closely and would love to add you to my network.",
      coldDm: "Hi {firstName},\n\nI don't often reach out cold but {company}'s marketing specifically caught my attention.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nDoes 15 minutes make sense to explore?",
      followup1: "Hi {firstName} — one more follow-up. Happy to make it as short as you need.",
      followup2: "Hi {firstName}, making this my last message. Best of luck — reach out anytime.",
    },
  ],

  engineer: [
    {
      connectionNote: "Hi {firstName} — love the engineering work at {company}. Would be great to connect.",
      coldDm: "Hi {firstName},\n\nI came across your profile while looking into engineering teams at companies like {company} — really impressive work{yearsNote}.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love to explore if there's a fit. Open to a quick call?",
      followup1: "Hi {firstName} — following up in case my message slipped through. Does this week work for a quick chat?",
      followup2: "Hi {firstName}, last follow-up from me. Reach out anytime if the timing changes.",
    },
    {
      connectionNote: "Hi {firstName}, always happy to connect with talented engineers doing great work. {company} has a great reputation.",
      coldDm: "Hi {firstName},\n\nEngineering at {company} has been on my radar and your profile specifically stood out.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nWould love to find time to connect — does a quick call work?",
      followup1: "Hi {firstName} — circling back one more time. Even 15 minutes would be great.",
      followup2: "Hi {firstName}, making this my last note. Best of luck — feel free to reach out anytime.",
    },
    {
      connectionNote: "Hi {firstName} — your work at {company} looks great. Would love to stay connected.",
      coldDm: "Hi {firstName},\n\nI work with engineering teams regularly and {company} specifically caught my attention.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nThought there could be a fit. Open to a quick call?",
      followup1: "Hi {firstName} — one last follow-up. Happy to answer any questions by message first.",
      followup2: "Hi {firstName}, I'll leave it here. Reach out whenever it makes sense.",
    },
    {
      connectionNote: "Hi {firstName} — I'm connected with a lot of people in the tech space and would love to add you.",
      coldDm: "Hi {firstName},\n\nI don't often reach out cold but {company}'s engineering work specifically came up in conversations I was having.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nWould 20 minutes make sense this week?",
      followup1: "Hi {firstName} — bumping this in case it got buried. Happy to adjust format if easier.",
      followup2: "Hi {firstName}, last message from me. Feel free to reach out anytime.",
    },
    {
      connectionNote: "Hi {firstName} — I respect the technical work at {company}. Would love to be in each other's networks.",
      coldDm: "Hi {firstName},\n\n{company} has been on my radar for a while — the engineering culture there stands out.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love to connect. Does a quick call work?",
      followup1: "Hi {firstName} — following up one more time. Even 10-15 minutes would be valuable.",
      followup2: "Hi {firstName}, making this my last follow-up. Best of luck with your work at {company}.",
    },
  ],

  general: [
    {
      connectionNote: "Hi {firstName} — came across your profile and would love to connect. {company} looks like a great place to be.",
      coldDm: "Hi {firstName},\n\nYour background at {company} stood out and I wanted to reach out directly.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love to explore if there's a fit. Open to a quick call?",
      followup1: "Hi {firstName} — following up in case my message got lost. Does this week work for a quick chat?",
      followup2: "Hi {firstName}, last follow-up from me. Feel free to reach out whenever the timing is right.",
    },
    {
      connectionNote: "Hi {firstName}, your background is impressive and I'd love to have you in my professional network.",
      coldDm: "Hi {firstName},\n\nI came across your profile while researching people at {company} and wanted to reach out.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nThought there could be a natural fit. Would a brief call work?",
      followup1: "Hi {firstName} — circling back. Happy to make it short — 15 minutes max.",
      followup2: "Hi {firstName}, making this my last follow-up. Best of luck at {company} — reach out anytime.",
    },
    {
      connectionNote: "Hi {firstName} — would love to connect and stay in touch.",
      coldDm: "Hi {firstName},\n\n{company} has been on my radar and your profile came up specifically.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love 20 minutes to explore if there's a fit. Open to a call?",
      followup1: "Hi {firstName} — one more follow-up. Happy to send details by message first if that's easier.",
      followup2: "Hi {firstName}, I'll leave it here. Feel free to reach out whenever it makes sense.",
    },
    {
      connectionNote: "Hi {firstName} — always happy to expand my network with professionals at companies like {company}.",
      coldDm: "Hi {firstName},\n\nI don't often reach out cold but your profile at {company} stood out specifically.\n\nI'm {senderName} at {senderCompany}. {senderOffer}\n\nWould a quick call make sense this week?",
      followup1: "Hi {firstName} — bumping this one last time. Happy to adjust to whatever format works for you.",
      followup2: "Hi {firstName}, last message from me. Reach out anytime if it ever makes sense.",
    },
    {
      connectionNote: "Hi {firstName} — your work at {company} looks interesting. Would love to be connected.",
      coldDm: "Hi {firstName},\n\nI came across your profile and wanted to reach out — {company} keeps coming up in conversations I'm having.\n\nI'm {senderName} from {senderCompany}. {senderOffer}\n\nWould love to explore. Does a brief call work?",
      followup1: "Hi {firstName} — following up one more time. Even a quick 'not right now' is helpful so I know where things stand.",
      followup2: "Hi {firstName}, making this my last check-in. Best of luck — reach out anytime.",
    },
  ],
};

// ── POST /generate-outreach ───────────────────────────────────────────────────
app.post('/generate-outreach', async (req, res) => {
  const { userId, idToken, profile, senderProfile } = req.body || {};

  if (!userId || !idToken || !profile) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const decoded = await verifyToken(idToken);
  if (!decoded || decoded.uid !== userId) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const firstName    = (profile.name || '').split(' ')[0] || 'there';
  const company      = profile.currentCompany || 'your company';
  const title        = profile.currentTitle || '';
  const bucket       = classifyRole(title);
  const variants     = TEMPLATES[bucket] || TEMPLATES.general;

  // Pick a variant based on a hash of the LinkedIn ID so the same profile
  // always gets the same variant (feels consistent, not random on each click)
  const idxSeed = (profile.linkedinId || '').split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const variant  = variants[idxSeed % variants.length];

  const yNote = yearsNote(profile.yearsAtCompany || '');

  const vars = {
    firstName,
    company,
    title,
    yearsNote:     yNote,
    senderName:    senderProfile?.senderName    || 'me',
    senderCompany: senderProfile?.senderCompany || 'my company',
    senderOffer:   senderProfile?.senderOffer   || '',
  };

  res.json({
    messages: {
      connectionNote: render(variant.connectionNote, vars),
      coldDm:         render(variant.coldDm,         vars),
      followup1:      render(variant.followup1,       vars),
      followup2:      render(variant.followup2,       vars),
    },
  });
});

// ── Stripe checkout ───────────────────────────────────────────────────────────
app.post('/checkout', async (req, res) => {
  const { userId, email } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    const db     = getDb();
    const stripe = getStripe();

    const doc      = await db.collection('users').doc(userId).get();
    let customerId = doc.exists ? doc.data().stripe_customer_id : null;

    if (!customerId) {
      const customer = await stripe.customers.create({ email, metadata: { firebase_uid: userId } });
      customerId = customer.id;
      await db.collection('users').doc(userId).set({ stripe_customer_id: customerId }, { merge: true });
    }

    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      payment_method_types: ['card'],
      mode:                 'subscription',
      line_items:           [{ price: PRICE_PRO, quantity: 1 }],
      success_url:          `${FRONTEND_URL}/success`,
      cancel_url:           `${FRONTEND_URL}/cancel`,
      metadata:             { firebase_uid: userId },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('checkout error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe portal ─────────────────────────────────────────────────────────────
app.post('/portal-session', async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    const db  = getDb();
    const doc = await db.collection('users').doc(userId).get();

    if (!doc.exists || !doc.data().stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found.' });
    }

    const stripe  = getStripe();
    const session = await stripe.billingPortal.sessions.create({
      customer:   doc.data().stripe_customer_id,
      return_url: FRONTEND_URL,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('portal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe webhook ────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = getStripe().webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const db = getDb();

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const userId  = session.metadata?.firebase_uid;
      if (userId) {
        await db.collection('users').doc(userId).set({
          plan:                   'pro',
          stripe_customer_id:     session.customer,
          stripe_subscription_id: session.subscription,
          email_lookups_used:     0,
          email_lookups_month:    0,
        }, { merge: true });
        console.log(`Upgraded user ${userId} to pro`);
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const snapshot = await db.collection('users').where('stripe_customer_id', '==', event.data.object.customer).get();
      for (const doc of snapshot.docs) {
        await doc.ref.set({ plan: 'free', stripe_subscription_id: null }, { merge: true });
        console.log(`Downgraded user ${doc.id} to free`);
      }
    }
  } catch (err) {
    console.error('webhook handler error:', err);
  }

  res.json({ received: true });
});

// ── Success / cancel pages ────────────────────────────────────────────────────
app.get('/success', (_req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h1 style="color:#059669">Welcome to ReachOut Pro!</h1>
      <p>Your subscription is active. Open the extension to start finding emails.</p>
      <p style="margin-top:30px;color:#888">You can close this tab.</p>
    </body></html>
  `);
});

app.get('/cancel', (_req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h1>Checkout Cancelled</h1>
      <p>No charge was made. You can close this tab.</p>
    </body></html>
  `);
});

app.post('/send-verification', async (req, res) => {
  const { idToken, email } = req.body || {};
  if (!idToken || !email) return res.status(400).json({ error: 'Missing idToken or email.' });
  try {
    if (!admin.apps.length) getDb();
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (!decoded || decoded.email !== email) return res.status(401).json({ error: 'Unauthorized.' });
    const link = await admin.auth().generateEmailVerificationLink(email);
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: 'ReachOut <noreply@extensionsmarket.com>',
      to: email,
      subject: 'Verify your ReachOut account',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="margin:0 0 8px">Verify your email</h2>
        <p style="color:#555;margin:0 0 24px">Click the button below to confirm your ReachOut account.</p>
        <a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">Verify Email</a>
        <p style="color:#999;font-size:12px;margin:24px 0 0">If you didn't create this account, you can ignore this email.</p>
      </div>`,
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/set-pro', async (req, res) => {
  if (req.headers['x-admin-key'] !== 'APR2026-SETPRO') return res.status(403).json({ error: 'Forbidden' });
  const { email, plan = 'pro' } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const db = getDb();
    const user = await admin.auth().getUserByEmail(email);
    await db.collection('users').doc(user.uid).set({ plan }, { merge: true });
    res.json({ ok: true, uid: user.uid, project: 'reachout-4e9e8' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => console.log(`ReachOut server on port ${PORT}`));
