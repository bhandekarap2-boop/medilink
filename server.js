const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const indexFile = path.join(__dirname, 'index.html');

// The `verify` hook stashes the raw request bytes on req.rawBody — needed alongside the parsed
// req.body because Razorpay webhook signatures are computed over the exact raw payload, not a
// re-serialized copy of it (whitespace/key-order differences would break the HMAC check).
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// ============ AI PROVIDER: GROQ (OpenAI-compatible Chat Completions) ============
// Moved off Gemini — its free tier caps out at 20 requests/DAY total, which a live WhatsApp bot
// (each conversation turn can burn several requests via function-calling) exhausts almost
// immediately. Groq's free tier is dramatically more generous and includes fast Whisper
// transcription, which replaced Gemini's native inline-audio support for WhatsApp voice notes
// (see transcribeAudioWithGroq below). `openai/gpt-oss-120b` was chosen for solid instruction-
// following and reliable tool-calling; swap GROQ_MODEL here if Groq's model lineup changes.
const GROQ_MODEL = 'openai/gpt-oss-120b';
async function callGroq(apiKey, body) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify({ model: GROQ_MODEL, ...body })
    });
    if (resp.ok) return resp;
    if ((resp.status === 503 || resp.status === 429) && attempt < maxAttempts - 1) {
      // A 429 here is Groq's per-minute token budget, not a "try again in a moment" blip — its
      // own error message tells us exactly how long that takes to clear (seen in practice: 9-12s),
      // which a short fixed backoff (previously 800ms/1600ms) never waits out. Read that real
      // number back instead of guessing; 503s stay on the old short backoff since those really are
      // transient. Capped at 15s so one retry can't eat the whole WhatsApp webhook time budget.
      let waitMs = 800 * (attempt + 1);
      if (resp.status === 429) {
        try {
          const cloned = resp.clone();
          const errBody = await cloned.json();
          const m = /try again in ([\d.]+)s/i.exec((errBody.error && errBody.error.message) || '');
          if (m) waitMs = Math.min(15000, Math.ceil(parseFloat(m[1]) * 1000) + 300);
        } catch(e) {}
      }
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }
    return resp;
  }
}

// Pulls the assistant's plain-text reply out of a Groq/OpenAI-shaped chat-completion response.
// `openai/gpt-oss-120b` is a reasoning model — its "thinking" goes in message.reasoning, only the
// final answer lands in message.content, so this never accidentally surfaces chain-of-thought.
function extractGroqText(data) {
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  return (msg && msg.content) || '';
}

// AI symptom triage — proxied server-side so the Groq API key never reaches the browser.
// Returns a suggested urgency/specialization, never a diagnosis or prescription. Requires the
// GROQ_API_KEY env var to be set in the Vercel project (Settings > Environment Variables);
// until it is, this responds 503 so the client can show a clear "not configured yet" message.
app.post('/api/symptom-check', async (req, res) => {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'AI symptom checker is not configured yet. Ask the platform admin to add a GROQ_API_KEY.' });
    const { symptoms, age, gender } = req.body || {};
    if (!symptoms || !String(symptoms).trim()) return res.status(400).json({ error: 'Describe your symptoms first.' });

    const systemPrompt = 'You are a triage assistant inside a hospital app. You are NOT a doctor and must never diagnose or prescribe medication. Given a patient\'s symptoms, respond with STRICT JSON only, no markdown fences, matching exactly this shape: {"urgency":"routine"|"soon"|"emergency","suggestedSpecialization":"<one of: General Physician, Dentist, Cardiologist, Dermatologist, ENT, Orthopedic, Pediatrician, Gynecologist, Neurologist, Psychiatrist, Ophthalmologist, Gastroenterologist>","summary":"<1-2 sentence plain-language summary of what the symptoms might suggest, phrased as possibilities, never a diagnosis>","advice":"<2-3 sentence plain-language advice on what to do next>"}. Use "emergency" only for symptoms suggesting an immediate life-threatening condition (chest pain, difficulty breathing, stroke signs, severe bleeding, loss of consciousness). Output nothing outside the JSON object.';
    const userMsg = 'Patient symptoms: ' + String(symptoms).trim() + (age ? ('\nAge: ' + age) : '') + (gender ? ('\nGender: ' + gender) : '');

    const aiResp = await callGroq(apiKey, {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
      temperature: 0.3, max_tokens: 2048
    });

    if (!aiResp.ok) {
      console.error('Groq API error:', aiResp.status, await aiResp.text());
      return res.status(502).json({ error: 'AI service error. Try again later.' });
    }

    const data = await aiResp.json();
    const text = extractGroqText(data);
    let parsed;
    try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '')); } catch(e) {
      console.error('symptom-check: could not parse Groq response. finish_reason:', data.choices && data.choices[0] && data.choices[0].finish_reason, '| text:', text);
      parsed = { urgency: 'soon', suggestedSpecialization: 'General Physician', summary: text.slice(0, 300), advice: 'Please consult a doctor for proper evaluation.' };
    }
    res.json(parsed);
  } catch(e) {
    console.error('symptom-check error:', e);
    res.status(500).json({ error: 'Something went wrong. Try again later.' });
  }
});

// ============ PAID-PLAN CHECK (gates Hospital Registration) ============
// mediflowinfo.lovable.app is the separate marketing/sales site where a hospital actually buys a
// MediFlow plan. This proxies its customer-plans API server-side (the API key never reaches the
// browser) so the Register Hospital form can confirm the email registering actually bought a
// plan before an account is created — without this, anyone could self-register a free hospital.
app.get('/api/check-plan', async (req, res) => {
  try {
    const apiKey = process.env.MEDIFLOWINFO_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Plan verification is not configured yet.' });
    const email = String(req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required.' });

    const resp = await fetch('https://mediflowinfo.lovable.app/api/public/customer-plans', {
      headers: { 'x-api-key': apiKey }
    });
    if (!resp.ok) {
      console.error('check-plan upstream error:', resp.status, await resp.text());
      return res.status(502).json({ error: 'Could not reach the plans service. Try again later.' });
    }
    const data = await resp.json();
    // Response shape isn't guaranteed, so accept a bare array or a wrapped {customers:[...]} /
    // {data:[...]} object, and match on whatever field looks like the email.
    const list = Array.isArray(data) ? data : (data.customers || data.data || data.plans || []);
    const match = list.find(c => String(c.email || c.customerEmail || '').trim().toLowerCase() === email);
    if (!match) return res.json({ hasPlan: false });

    // Being in this list only means an order EXISTS for this email — it may still be sitting
    // unpaid/awaiting-payment. `paid_orders_count` (vs `orders_count`) is what actually confirms
    // money changed hands, so that's the real gate: no completed payment, no plan, no code sent.
    const paidOrders = typeof match.paid_orders_count === 'number' ? match.paid_orders_count : (match.total_paid_inr > 0 ? 1 : 0);
    if (!paidOrders) return res.json({ hasPlan: false, paymentAwaiting: true });

    // The real shape (confirmed against the live API) is `plans: [<plan names>]` plus
    // `last_order_at` — same fields /api/membership-sweep anchors its expiry math on, so the
    // days-left number shown to an admin matches exactly what the sweep will act on.
    const planNames = match.plans || [];
    const planLabel = planNames[0] || match.plan || match.planName || 'Unknown plan';
    let daysLeft = null, expiryDate = null, isExpired = false;
    const durationDays = planDurationDays(planNames);
    if (match.last_order_at && planNames.length && durationDays !== null) {
      const purchaseTime = new Date(match.last_order_at).getTime();
      if (!isNaN(purchaseTime)) {
        const expiryTime = purchaseTime + durationDays * 24 * 60 * 60 * 1000;
        expiryDate = new Date(expiryTime).toISOString();
        daysLeft = Math.ceil((expiryTime - Date.now()) / (24 * 60 * 60 * 1000));
        isExpired = daysLeft < 0;
      }
    }
    // durationDays === null means this plan doesn't expire (e.g. the one-time setup fee) —
    // daysLeft/expiryDate/isExpired stay at their defaults (null/null/false), which the dashboard
    // banner and everything else already treats as "nothing to show", not "expired".
    res.json({ hasPlan: true, plan: planLabel, daysLeft, expiryDate, isExpired, updatesIncluded: planIncludesUpdates(planNames) });
  } catch(e) {
    console.error('check-plan error:', e);
    res.status(500).json({ error: 'Something went wrong. Try again later.' });
  }
});

// ============ MEMBERSHIP SWEEP (daily cron — expiry warning + grace period + auto-block) ============
// Membership is only ever purchased/renewed on mediflowinfo.lovable.app — this is the enforcement
// side inside MediFlow itself, run once a day by Vercel Cron (see vercel.json). For every
// registered hospital it checks the SAME customer-plans API /api/check-plan uses, and:
//   - still within their paid period          -> nothing (and clears any earlier grace/block)
//   - expired, within the 2-day grace window  -> flags membershipGraceUntil once (client shows a
//                                                 banner on next admin login), doesn't block yet
//   - expired past the 2-day grace window      -> sets status:'blocked', same field Manage
//                                                 Hospitals already uses to lock a hospital out
// "Plan" duration is inferred from the plan name(s) mediflowinfo reports, anchored on the
// customer's most recent order (`last_order_at`) — that API doesn't expose an explicit expiry
// date, so this is the best approximation available from it.
// Returns the plan's renewal period in days, or `null` for a plan that doesn't expire at all —
// "Cloud Database (One-time Setup) Membership" is exactly that: a one-time setup fee, not a
// recurring subscription, so it must never be treated as expiring. It used to fall through to a
// 30-day default, which would have silently started counting it down toward auto-block. Add a
// day count here only for plans that genuinely have a defined renewal cadence.
function planDurationDays(planNames) {
  const joined = (planNames || []).join(' ').toLowerCase();
  if (joined.includes('one-time') || joined.includes('one time') || joined.includes('setup')) return null;
  if (joined.includes('year') || joined.includes('bundle')) return 365;
  if (joined.includes('month')) return 30;
  return null; // unrecognized plan name — don't guess an expiry for it
}

// Same keyword-sniffing approach as planDurationDays above, since mediflowinfo.lovable.app has no
// dedicated "includes updates" field — only a plan name. Defaults to true (includes updates)
// unless the plan name explicitly says otherwise, so an unrecognized/new plan name never
// accidentally freezes a paying hospital on old code.
function planIncludesUpdates(planNames) {
  const joined = (planNames || []).join(' ').toLowerCase();
  if (joined.includes('without update') || joined.includes('no update') || joined.includes('excl. update') || joined.includes('excludes update') || joined.includes('update-free')) return false;
  return true;
}

app.get('/api/membership-sweep', async (req, res) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== 'Bearer ' + cronSecret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const admin = require('firebase-admin');
    const adminDb = getAdminDb();
    const planApiKey = process.env.MEDIFLOWINFO_API_KEY;
    if (!adminDb || !planApiKey) return res.status(503).json({ error: 'Not configured — need FIREBASE_SERVICE_ACCOUNT and MEDIFLOWINFO_API_KEY.' });

    const plansResp = await fetch('https://mediflowinfo.lovable.app/api/public/customer-plans', { headers: { 'x-api-key': planApiKey } });
    if (!plansResp.ok) return res.status(502).json({ error: 'Could not reach the plans service.' });
    const plansData = await plansResp.json();
    const customers = Array.isArray(plansData) ? plansData : (plansData.customers || plansData.data || plansData.plans || []);
    const byEmail = {};
    customers.forEach(c => { if (c.email) byEmail[String(c.email).trim().toLowerCase()] = c; });

    const hospSnap = await adminDb.collection('hospitals').get();
    const now = Date.now();
    const GRACE_MS = 2 * 24 * 60 * 60 * 1000;
    let checked = 0, warned = 0, blocked = 0, restored = 0;

    for (const doc of hospSnap.docs) {
      const h = doc.data();
      if (!h.email) continue; // nothing to match this hospital against
      const customer = byEmail[String(h.email).trim().toLowerCase()];
      if (!customer || !customer.last_order_at || !(customer.plans || []).length) continue; // no purchase history — leave alone, don't guess
      const paidOrders = typeof customer.paid_orders_count === 'number' ? customer.paid_orders_count : (customer.total_paid_inr > 0 ? 1 : 0);
      if (!paidOrders) continue; // most recent order is unpaid/awaiting — don't anchor expiry math on it
      checked++;

      // Keep the update-inclusion state in sync with whatever plan they're actually on right
      // now (they may have upgraded/downgraded since last checked) — runs independent of the
      // expiry-date logic below, since a one-time/never-expiring plan still has an update tier.
      try {
        const shouldInclude = planIncludesUpdates(customer.plans);
        if (shouldInclude && h.pinnedVersion) {
          await doc.ref.update({ pinnedVersion: admin.firestore.FieldValue.delete(), updatesIncludedDetected: true });
        } else if (!shouldInclude && !h.pinnedVersion) {
          const latestSnap = await adminDb.collection('platformVersions').doc('latest').get();
          const latestVersion = latestSnap.exists ? latestSnap.data().version : null;
          if (latestVersion) await doc.ref.update({ pinnedVersion: latestVersion, updatesIncludedDetected: false });
        } else if (h.updatesIncludedDetected !== shouldInclude) {
          await doc.ref.update({ updatesIncludedDetected: shouldInclude });
        }
      } catch(e) { console.warn('Could not sync updatesIncluded for', doc.id, ':', e.message); }

      const purchaseTime = new Date(customer.last_order_at).getTime();
      if (isNaN(purchaseTime)) continue;
      const durationDays = planDurationDays(customer.plans);
      if (durationDays === null) continue; // one-time setup fee or unrecognized plan — never expires, nothing to warn/block on
      const expiryTime = purchaseTime + durationDays * 24 * 60 * 60 * 1000;
      const overdueMs = now - expiryTime;

      if (overdueMs <= 0) {
        // Currently paid up — clear any grace flag or membership-only block from a past lapse.
        if (h.membershipGraceUntil || (h.status === 'blocked' && h.blockedReason === 'Membership expired — renew at mediflowinfo.lovable.app to restore access')) {
          await doc.ref.update({
            membershipGraceUntil: admin.firestore.FieldValue.delete(),
            membershipWarningSentAt: admin.firestore.FieldValue.delete(),
            status: 'active',
            blockedReason: admin.firestore.FieldValue.delete()
          });
          restored++;
        }
        continue;
      }

      if (overdueMs <= GRACE_MS) {
        if (!h.membershipWarningSentAt) {
          await doc.ref.update({
            membershipGraceUntil: new Date(expiryTime + GRACE_MS).toISOString(),
            membershipWarningSentAt: admin.firestore.FieldValue.serverTimestamp()
          });
          warned++;
        }
        continue;
      }

      if (h.status !== 'blocked') {
        await doc.ref.update({
          status: 'blocked',
          blockedReason: 'Membership expired — renew at mediflowinfo.lovable.app to restore access',
          membershipGraceUntil: admin.firestore.FieldValue.delete()
        });
        blocked++;
      }
    }

    res.json({ ok: true, checked, warned, blocked, restored });
  } catch(e) {
    console.error('membership-sweep error:', e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ============ GENERIC AI ASSIST (diet plan / translate / lab explain / patient briefing /
// medicine suggest / report summary / feedback priority) ============
// One endpoint instead of seven near-identical ones — `feature` picks the prompt, everything
// else (Gemini call, retry, key check) is shared. Every one of these is advisory only; medicine
// suggestions in particular are explicitly framed as a starting point for the doctor to review,
// never an instruction to prescribe.
const AI_ASSIST_PROMPTS = {
  dietPlan: (p) => ({
    system: 'You are a hospital dietitian assistant. Given a patient\'s basic details, write a simple, practical daily diet plan in plain text (use short headings like Breakfast/Lunch/Dinner/Snacks and bullet points with "-"). Keep it realistic for an Indian household unless told otherwise. Always end with one line reminding the reader this is general guidance, not a substitute for a dietitian\'s personal advice.' +
      (p.language && p.language !== 'English' ? ' Write the ENTIRE response in ' + p.language + ', not English.' : ''),
    user: 'Patient: ' + (p.patientName || 'Patient') + (p.age ? ', age ' + p.age : '') + (p.gender ? ', ' + p.gender : '') +
      (p.weight ? '\nWeight: ' + p.weight + ' kg' : '') + (p.height ? '\nHeight: ' + p.height + ' cm' : '') +
      (p.conditions ? '\nHealth conditions / goals: ' + p.conditions : '\nNo specific conditions mentioned.')
  }),
  translate: (p) => ({
    system: 'You are a medical-context translator. Translate the given text into ' + (p.targetLanguage || 'Hindi') + '. Keep medical terms accurate and simple. Output ONLY the translated text, nothing else — no notes, no quotes.',
    user: String(p.text || '').slice(0, 4000)
  }),
  labExplain: (p) => ({
    system: 'You are a friendly assistant explaining lab report values to a patient with no medical background. Given raw lab report text/values, explain in plain simple language what each notable value means and whether it looks in-range, low, or high, based on the reference ranges given (or standard ranges if none given). Use short bullet points. Always end with a line saying this is not a diagnosis and to discuss the actual report with their doctor.' +
      (p.language && p.language !== 'English' ? ' Write the ENTIRE response in ' + p.language + ', not English.' : ''),
    user: String(p.reportText || '').slice(0, 4000)
  }),
  patientBriefing: (p) => ({
    system: 'You are a clinical assistant preparing a doctor for an upcoming consultation. Given a patient\'s recent visit history, summarize it into a short briefing (4-6 bullet points): key past diagnoses, medicines prescribed, any recurring complaints, and anything the doctor should watch for. Be concise and factual — do not invent details not present in the history.',
    user: 'Patient: ' + (p.patientName || 'Patient') + '\nRecent history:\n' + String(p.history || 'No prior history on record.').slice(0, 6000)
  }),
  medicineSuggest: (p) => ({
    system: 'You are a clinical reference assistant helping a doctor think through options — you are NOT prescribing and the doctor makes the final call. Given a diagnosis/symptoms, list 3-5 commonly used medicine options (generic names) relevant to it, each with a one-line note on typical use/caution. Keep it brief. End with a line reminding the doctor to verify against the patient\'s allergies, current medication, and clinical judgement before prescribing.',
    user: 'Diagnosis / symptoms: ' + String(p.diagnosis || '').slice(0, 2000)
  }),
  reportSummary: (p) => ({
    system: 'You are a hospital operations assistant. Given raw stats/numbers for a hospital, write a short plain-English summary (4-6 bullet points) highlighting notable trends, what looks healthy, and what might need attention. Be concise and factual — do not invent numbers not given.',
    user: String(p.statsText || '').slice(0, 4000)
  })
};

app.post('/api/ai-assist', async (req, res) => {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'AI features are not configured yet. Ask the platform admin to add a GROQ_API_KEY.' });
    const { feature, payload } = req.body || {};
    const builder = AI_ASSIST_PROMPTS[feature];
    if (!builder) return res.status(400).json({ error: 'Unknown AI feature.' });
    const { system, user } = builder(payload || {});
    if (!user || !user.trim()) return res.status(400).json({ error: 'Nothing to work with — please fill in the details first.' });

    const aiResp = await callGroq(apiKey, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.4, max_tokens: 2048
    });
    if (!aiResp.ok) {
      console.error('ai-assist Groq error:', feature, aiResp.status, await aiResp.text());
      return res.status(502).json({ error: 'AI service error. Try again later.' });
    }
    const data = await aiResp.json();
    const text = extractGroqText(data).trim();
    res.json({ result: text || 'AI did not return a response — try again.' });
  } catch(e) {
    console.error('ai-assist error:', e);
    res.status(500).json({ error: 'Something went wrong. Try again later.' });
  }
});

// ============ IN-APP HELP CHAT (floating "Ask AI" widget, every role, every page) ============
// A general Q&A assistant about MediFlow itself — what a feature does, where to find it, and
// basic hospital info (name/address/phone/OPD timings, passed in by the client since it already
// has it loaded) — NOT medical advice and NOT a way to look up another patient's private data, so
// the prompt is deliberately scoped away from both. Multi-turn (unlike the single-shot /api/ai-
// assist above) since a help conversation naturally has follow-ups ("where's that exactly?").
const APP_HELP_FEATURES = {
  admin: 'Dashboard (today\'s appointments/queue, present staff), Doctors, Patients, Appointments, Queue, Reports, Rooms, Inventory/Assets, Doctor Time Slots, Audit Log, Diet Plans, Patient Scanner (RFID), RFID Cards, Attendance, Online Consult, Health Cards, Insurance, QR Payment, Notifications, Staff, OTA Update, Medical Charts, Lab Tests, Billing, Payment Approvals, Medical Store (pharmacy), Surgery, Patient Files, Print History (look up any patient\'s appointments/bills/prescriptions/lab orders/insurance/health card/diet plan and print them), Feedback Inbox, Requests (WhatsApp AI escalations), WhatsApp Messages (broadcast, live chat with a patient, and a read-only view of the admin\'s own AI conversation), Settings (hospital info, logo, features on/off, sidebar order, WhatsApp sending mode), Customization.',
  doctor: 'Dashboard, My Queue, Patients, Appointments (book/cancel), Next Patient, Patient Scanner, Online Consult, Diet Plans, QR Payment, Patient Symptoms, Notifications, Surgery, Patient Files, Lab Reports, Lab Test Ticket, Charts, My Attendance, Time Slots, Feedback, AI Preferences (personal AI feature toggles, WhatsApp sending mode, personal WhatsApp number linking, a read-only view of their own AI conversation, sidebar order).',
  patient: 'Dashboard, My Profile, Book Appointment, History, My Medicines, Medical Store, My Diet Plan, Online Consult, Health Card, Insurance, Due Bills, My Surgeries, Notifications, My Symptoms, My Files, My Bills, Lab Reports, Doctors Present, Feedback & Reviews, AI Preferences (personal AI feature toggles, sidebar order, language).'
};

app.post('/api/app-help-chat', async (req, res) => {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'AI chat is not configured yet. Ask the platform admin to add a GROQ_API_KEY.' });
    const { role, question, hospital, history } = req.body || {};
    if (!question || !String(question).trim()) return res.status(400).json({ error: 'Ask something first.' });
    const roleKey = ['admin', 'doctor', 'patient'].includes(role) ? role : 'patient';
    const h = hospital || {};
    const hospitalInfo = 'Hospital: ' + (h.name || 'this hospital') +
      (h.address1 || h.address2 ? '\nAddress: ' + [h.address1, h.address2].filter(Boolean).join(', ') : '') +
      (h.phone ? '\nPhone: ' + h.phone : '') + (h.opdTimings ? '\nOPD timings: ' + h.opdTimings : '') +
      (h.website ? '\nWebsite: ' + h.website : '');
    const system = 'You are the MediFlow in-app help assistant, answering a logged-in ' + roleKey +
      ' inside the MediFlow hospital-management app. Your job is ONLY to explain what MediFlow can do, where to find a feature in the sidebar, and general info about this hospital from the details given below. ' +
      'Available sidebar sections for this role: ' + APP_HELP_FEATURES[roleKey] + '\n' + hospitalInfo +
      '\nRules: Never give medical advice or diagnose anything — redirect medical questions to the doctor/AI Symptom Checker feature instead. Never invent a patient\'s personal data (bills, appointment times, results) you were not given — tell them which page shows that instead. Keep answers short (2-5 sentences), friendly, plain language.';
    const messages = [{ role: 'system', content: system }];
    if (Array.isArray(history)) {
      history.slice(-8).forEach(m => {
        if (m && (m.role === 'user' || m.role === 'assistant') && m.content) messages.push({ role: m.role, content: String(m.content).slice(0, 2000) });
      });
    }
    messages.push({ role: 'user', content: String(question).slice(0, 1000) });

    const aiResp = await callGroq(apiKey, { messages, temperature: 0.3, max_tokens: 500 });
    if (!aiResp.ok) {
      console.error('app-help-chat Groq error:', aiResp.status, await aiResp.text());
      return res.status(502).json({ error: 'AI service error. Try again later.' });
    }
    const data = await aiResp.json();
    const text = extractGroqText(data).trim();
    res.json({ answer: text || 'Sorry, I didn\'t catch that — could you rephrase?' });
  } catch(e) {
    console.error('app-help-chat error:', e);
    res.status(500).json({ error: 'Something went wrong. Try again later.' });
  }
});

// ============ FULL UI TRANSLATION ============
// MediFlow's interface strings are hardcoded English throughout the app, so instead of hand-
// translating every page, the client walks the visible DOM, batches up the text it finds, and
// this endpoint machine-translates it in one shot per batch. Order/count must round-trip exactly
// since the client maps translations back onto DOM nodes positionally — falls back to returning
// the originals untouched (rather than erroring) if Gemini's output doesn't line up, so a bad
// translation pass never corrupts the UI, it just silently stays in English for that batch.
// In-app voice/chat assistant. It deliberately has NO access to anyone's records — it can explain
// the app, answer general (non-diagnostic) questions, and tell the page which screen to open.
// Personal data stays on each screen behind the normal login.
const _assistHits = new Map();
app.post('/api/app-assistant', async (req, res) => {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'The AI assistant is not set up yet. Ask the platform admin to add a GROQ_API_KEY.' });
    const ip = String(req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    const now = Date.now();
    const hits = (_assistHits.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
    if (hits.length >= 40) return res.status(429).json({ error: 'Too many messages — please wait a few minutes and try again.' });
    hits.push(now); _assistHits.set(ip, hits);

    const { role, language, hospitalName, history, pages } = req.body || {};
    const who = ['admin', 'doctor', 'patient'].includes(role) ? role : 'user';
    const msgs = (Array.isArray(history) ? history : []).slice(-10)
      .map(m => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', content: String((m && m.content) || '').slice(0, 800) })).filter(m => m.content);
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return res.status(400).json({ error: 'Please ask a question first.' });
    const pageList = (Array.isArray(pages) ? pages : []).slice(0, 80)
      .filter(p => p && typeof p.id === 'string' && /^[A-Za-z0-9_]+$/.test(p.id)).map(p => ({ id: p.id, label: String(p.label || '').slice(0, 60) }));
    const ids = new Set(pageList.map(p => p.id));

    const system =
      'You are the in-app voice assistant of ' + (String(hospitalName || '').slice(0, 80) || 'the hospital') + ', inside the MediFlow hospital app. The person talking to you is a ' + who + '.\n' +
      'Reply in the same language the person used (their preferred language is ' + (String(language || 'English').slice(0, 30)) + '). Keep it to 1-3 short sentences, plain spoken style — your reply is read aloud, so no markdown, no emojis, no bullet lists.\n' +
      'You CANNOT see any appointments, bills, prescriptions, reports or other personal records, and you must never pretend to. If asked for them, say which screen shows them and open it.\n' +
      'Screens available to this person (id: name):\n' + pageList.map(p => p.id + ': ' + p.label).join('\n') + '\n' +
      'If the person asks to open, go to or show a screen, set "navigate" to the matching id from that list; otherwise null. Never invent an id.\n' +
      'You can explain how to use MediFlow features. For health questions give only general educational information — never diagnose, never name a medicine dose, and suggest seeing a doctor. If it sounds like an emergency (chest pain, trouble breathing, heavy bleeding, unconsciousness) tell them to call their local emergency number or go to the nearest emergency room right now.\n' +
      'Output ONLY JSON: {"reply":"...","navigate":"<screen id or null>"}';

    const aiResp = await callGroq(apiKey, { messages: [{ role: 'system', content: system }, ...msgs], temperature: 0.3, max_tokens: 400 });
    if (!aiResp.ok) { console.error('app-assistant Groq error:', aiResp.status, await aiResp.text()); return res.status(502).json({ error: 'The assistant is busy right now. Please try again.' }); }
    const text = extractGroqText(await aiResp.json()).trim();
    let reply = text, navigate = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { const j = JSON.parse(m[0]); if (j.reply) reply = String(j.reply); if (j.navigate && ids.has(String(j.navigate))) navigate = String(j.navigate); }
    } catch (e) {}
    res.json({ reply: reply || 'Sorry, I could not answer that. Please try again.', navigate });
  } catch (e) {
    console.error('app-assistant error:', e);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

app.post('/api/translate-ui', async (req, res) => {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'AI features are not configured yet. Ask the platform admin to add a GROQ_API_KEY.' });
    const { texts, targetLanguage } = req.body || {};
    if (!Array.isArray(texts) || !texts.length) return res.status(400).json({ error: 'No text to translate.' });
    if (texts.length > 60) return res.status(400).json({ error: 'Too many strings in one batch.' });
    if (!targetLanguage || typeof targetLanguage !== 'string') return res.status(400).json({ error: 'Missing target language.' });

    const system = 'You are a UI translation engine for a hospital web app. Translate each element of the given JSON array of short UI strings into ' + targetLanguage + '. ' +
      'Respond with STRICT JSON only — a single array of strings, same length and same order as the input, no markdown fences, no commentary. ' +
      'Keep emoji, numbers, dates, currency amounts, patient/record IDs (like DEF-0001), and proper nouns/brand names unchanged. ' +
      'If an item is not real UI text (already just a number, code, or symbols), return it unchanged.';
    const user = JSON.stringify(texts);

    const aiResp = await callGroq(apiKey, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.2, max_tokens: 4096
    });
    if (!aiResp.ok) {
      console.error('translate-ui Groq error:', aiResp.status, await aiResp.text());
      return res.status(502).json({ error: 'AI service error. Try again later.' });
    }
    const data = await aiResp.json();
    const raw = extractGroqText(data).trim();
    // The model occasionally ignores "no commentary" and wraps the array in a stray sentence or
    // fence despite the system prompt — this used to fail parsing on those responses and silently
    // fall back to the untouched English originals, which is exactly what "translation isn't
    // working" looks like to a user (no error shown, page just... doesn't change). Try a plain
    // parse first, then fall back to pulling out the first [...] block before giving up.
    let translations;
    try {
      translations = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ''));
    } catch(e) {
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) {
        try { translations = JSON.parse(m[0]); }
        catch(e2) { console.error('translate-ui: could not parse extracted array either:', m[0].slice(0, 300)); translations = null; }
      } else {
        console.error('translate-ui: no JSON array found in response:', raw.slice(0, 300));
        translations = null;
      }
    }
    if (!Array.isArray(translations) || translations.length !== texts.length) {
      console.error('translate-ui: translation count mismatch — got', Array.isArray(translations) ? translations.length : typeof translations, 'expected', texts.length, '— falling back to English for this batch');
      translations = texts;
    }
    res.json({ translations });
  } catch(e) {
    console.error('translate-ui error:', e);
    res.status(500).json({ error: 'Something went wrong. Try again later.' });
  }
});

// Feedback priority uses strict JSON (needs a machine-readable urgency level), so it's separate
// from the free-text /api/ai-assist above.
app.post('/api/feedback-priority', async (req, res) => {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'AI features are not configured yet. Ask the platform admin to add a GROQ_API_KEY.' });
    const { feedbackText } = req.body || {};
    if (!feedbackText || !String(feedbackText).trim()) return res.status(400).json({ error: 'No feedback text given.' });

    const systemPrompt = 'You are triaging patient feedback for a hospital admin. Given one piece of feedback, respond with STRICT JSON only, no markdown fences, matching exactly: {"priority":"low"|"medium"|"high","reason":"<one short sentence why>"}. Use "high" for anything suggesting a safety issue, serious complaint, or very upset patient; "medium" for a real but non-urgent complaint; "low" for general/positive feedback or minor suggestions.';
    const aiResp = await callGroq(apiKey, {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: String(feedbackText).slice(0, 2000) }],
      temperature: 0.2, max_tokens: 512
    });
    if (!aiResp.ok) {
      console.error('feedback-priority Groq error:', aiResp.status, await aiResp.text());
      return res.status(502).json({ error: 'AI service error. Try again later.' });
    }
    const data = await aiResp.json();
    const text = extractGroqText(data);
    let parsed;
    try { parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '')); } catch(e) { parsed = { priority: 'medium', reason: 'Could not auto-classify — please review manually.' }; }
    res.json(parsed);
  } catch(e) {
    console.error('feedback-priority error:', e);
    res.status(500).json({ error: 'Something went wrong. Try again later.' });
  }
});

// ============ WHATSAPP AI ASSISTANT (booking + FAQ + cancellations) ============
// Rebuilt in-app (instead of a separate n8n/Supabase workflow) so it reads/writes the SAME
// Firestore data MediFlow already uses — an appointment booked over WhatsApp shows up instantly
// in the hospital's admin/doctor panels, and vice versa.
//
// Multi-hospital by design: ALL hospitals share one Meta WhatsApp Business Account (one access
// token, one webhook, one verify token), but each hospital gets its OWN phone number under that
// account. Every inbound message tells us exactly which number it arrived on
// (value.metadata.phone_number_id), which is looked up against each hospital's own
// `whatsappPhoneNumberId` field (set from Manage Hospitals) to route the message — so hospitals'
// data never mixes even though the webhook and credentials are shared infrastructure.
//
// Needs these Vercel env vars before it does anything (all gated — the webhook just logs and
// no-ops until they're present, so it's safe to have this deployed early):
//   GROQ_API_KEY            — already used by /api/symptom-check
//   FIREBASE_SERVICE_ACCOUNT — the FULL JSON from Firebase Console > Project Settings >
//                              Service Accounts > Generate New Private Key, pasted as one string
//   WA_VERIFY_TOKEN         — any string you choose; must match what you enter in Meta's
//                              WhatsApp webhook setup
//   WA_ACCESS_TOKEN         — from Meta Business/WhatsApp Cloud API (shared across all hospitals)
// Per-hospital: each hospital's own WhatsApp phone number ID is stored on its Firestore doc as
// `whatsappPhoneNumberId` — set that from Manage Hospitals in the app, NOT as an env var.
const admin = require('firebase-admin');
let _adminApp = null;
function getAdminDb() {
  if (_adminApp) return _adminApp.firestore();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const serviceAccount = JSON.parse(raw);
    _adminApp = admin.apps.length ? admin.app() : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    return _adminApp.firestore();
  } catch(e) {
    console.error('Firebase Admin init failed — check FIREBASE_SERVICE_ACCOUNT is valid JSON:', e.message);
    return null;
  }
}

// `fromPhoneNumberId` is the specific hospital's WhatsApp number to send FROM — required now
// that multiple hospitals share one Meta WhatsApp Business Account, each with its own number.
// Returns {ok, id} rather than a plain boolean — `id` is WhatsApp's own message id (wamid) for
// this send, which the read-receipt webhook below reports back against once the recipient reads
// it. Existing callers that only care about success can keep doing `if (r.ok)`.
// The token pasted into Admin Settings (super-admin only) takes priority over the env var —
// stored in platformConfig/whatsapp so it survives redeploys and can be rotated without one.
// Cached for 20s per warm serverless instance to avoid a Firestore read on every single send.
let _waTokenCache = { token: null, at: 0 };
async function getWaAccessToken() {
  if (Date.now() - _waTokenCache.at < 20000) return _waTokenCache.token;
  let token = process.env.WA_ACCESS_TOKEN || null;
  try {
    const db = getAdminDb();
    if (db) {
      const snap = await db.collection('platformConfig').doc('whatsapp').get();
      if (snap.exists && snap.data().accessToken) token = snap.data().accessToken;
    }
  } catch(e) { console.warn('getWaAccessToken Firestore lookup failed, using env var:', e.message); }
  _waTokenCache = { token, at: Date.now() };
  return token;
}

async function sendWhatsAppText(to, body, fromPhoneNumberId) {
  const token = await getWaAccessToken();
  const phoneNumberId = fromPhoneNumberId;
  if (!token || !phoneNumberId) { console.warn('WA_ACCESS_TOKEN not set, or no phoneNumberId given — cannot send WhatsApp reply'); return { ok: false, id: null, reason: !token ? 'WhatsApp token is missing or expired' : 'No WhatsApp number linked for this hospital' }; }
  try {
    const resp = await fetch('https://graph.facebook.com/v21.0/' + phoneNumberId + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body } })
    });
    if (!resp.ok) { const txt = await resp.text(); console.error('WhatsApp send rejected by Meta:', resp.status, txt); let why = 'Meta error ' + resp.status; try { const j = JSON.parse(txt); if (j.error && j.error.message) why = j.error.message + (j.error.error_data && j.error.error_data.details ? ' — ' + j.error.error_data.details : ''); } catch(e) {} return { ok: false, id: null, reason: why }; }
    const data = await resp.json().catch(() => ({}));
    const id = data.messages && data.messages[0] && data.messages[0].id;
    return { ok: true, id: id || null };
  } catch(e) { console.error('WhatsApp send failed:', e.message); return { ok: false, id: null, reason: e.message }; }
}

// Same as sendWhatsAppText but for an image message (e.g. the QR/order-code sent when a medicine
// order is accepted) — Meta fetches the image itself from `imageUrl`, so it must be a publicly
// reachable link (the QR image host used elsewhere in this file already is).
async function sendWhatsAppImage(to, imageUrl, caption, fromPhoneNumberId) {
  const token = await getWaAccessToken();
  const phoneNumberId = fromPhoneNumberId;
  if (!token || !phoneNumberId) { console.warn('WA_ACCESS_TOKEN not set, or no phoneNumberId given — cannot send WhatsApp image'); return { ok: false, id: null }; }
  try {
    const resp = await fetch('https://graph.facebook.com/v21.0/' + phoneNumberId + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl, caption: caption || '' } })
    });
    if (!resp.ok) { console.error('WhatsApp image send rejected by Meta:', resp.status, await resp.text()); return { ok: false, id: null }; }
    const data = await resp.json().catch(() => ({}));
    const id = data.messages && data.messages[0] && data.messages[0].id;
    return { ok: true, id: id || null };
  } catch(e) { console.error('WhatsApp image send failed:', e.message); return { ok: false, id: null }; }
}

// WhatsApp only lets a business send free-form text to someone who messaged it in the last 24
// hours. Anything the APP starts (delivery code, "order ready", booking confirmation) outside that
// window is accepted by Meta (HTTP 200) and then silently dropped later (error 131047) — so those
// go out as an approved message template instead. `mediflow_update` is one generic utility
// template: "Hello {{1}}, this is an update about your request from {{2}}. Details: {{3}} ..."
function waTemplateParam(t) { return String(t || '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 900); }
async function sendWhatsAppTemplate(to, templateName, bodyParams, fromPhoneNumberId) {
  const token = await getWaAccessToken();
  if (!token || !fromPhoneNumberId) return { ok: false, id: null, reason: 'not configured' };
  try {
    const resp = await fetch('https://graph.facebook.com/v21.0/' + fromPhoneNumberId + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template',
        template: { name: templateName, language: { code: 'en' }, components: [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: waTemplateParam(t) || '-' })) }] } })
    });
    if (!resp.ok) { const txt = await resp.text(); console.error('WhatsApp template send rejected by Meta:', resp.status, txt); return { ok: false, id: null, reason: txt }; }
    const data = await resp.json().catch(() => ({}));
    return { ok: true, id: (data.messages && data.messages[0] && data.messages[0].id) || null };
  } catch(e) { console.error('WhatsApp template send failed:', e.message); return { ok: false, id: null, reason: e.message }; }
}
// True if this number messaged the business within the last 24h (so free-form text will be delivered).
async function hasOpenWhatsAppWindow(db, hospitalId, to, hospData) {
  try {
    let chatDocId = null;
    const patient = await findPatientByPhone(db, hospitalId, to);
    if (patient) chatDocId = patient.patientId;
    else {
      const doctor = await findDoctorByWhatsAppNumber(db, hospitalId, to);
      if (doctor) chatDocId = 'DOCTOR_' + doctor.id;
      else if (hospData && hospData.adminWhatsAppNumber && String(hospData.adminWhatsAppNumber).replace(/\D/g, '').slice(-10) === String(to).replace(/\D/g, '').slice(-10)) chatDocId = 'ADMIN';
    }
    if (!chatDocId) return false;
    const snap = await db.collection('hospitals/' + hospitalId + '/waChats/' + chatDocId + '/messages').where('direction', '==', 'in').get();
    let latest = 0;
    snap.docs.forEach(d => { const t = d.data().at && d.data().at.toMillis ? d.data().at.toMillis() : 0; if (t > latest) latest = t; });
    return latest > 0 && (Date.now() - latest) < 23.5 * 60 * 60 * 1000;
  } catch(e) { console.warn('hasOpenWhatsAppWindow failed:', e.message); return false; }
}
// ---- SMS ----------------------------------------------------------------------------------------
// Two providers, tried in this order:
//   1. Fast2SMS  — a normal SMS gateway; needs NO phone. API key pasted in Settings (stored server-side).
//   2. TextBee   — sends from the SIM of an Android phone you link to your TextBee account.
// Keys live in Firestore (platformConfig/sms, written only by the owner through /api/sms-set-key) or in the
// FAST2SMS_API_KEY / TEXTBEE_API_KEY environment variables.
let _smsKeyCache = { at: 0, f2s: null, tb: null };
async function loadSmsKeys() {
  if (Date.now() - _smsKeyCache.at < 20000) return _smsKeyCache;
  let f2s = process.env.FAST2SMS_API_KEY || null, tb = process.env.TEXTBEE_API_KEY || null;
  try {
    const db = getAdminDb();
    if (db) { const sn = await db.collection('platformConfig').doc('sms').get(); if (sn.exists) { f2s = sn.data().fast2smsKey || f2s; tb = sn.data().textbeeKey || tb; } }
  } catch (e) {}
  _smsKeyCache = { at: Date.now(), f2s, tb };
  return _smsKeyCache;
}
async function smsReady() { const k = await loadSmsKeys(); return !!(k.f2s || k.tb); }
function toE164India(to) {
  const d = String(to).replace(/\D/g, '');
  if (d.length === 10) return '+91' + d;
  return '+' + d;
}
// Emoji and the rupee sign push a message into costly 70-character unicode SMS parts — swap for plain text.
function smsSafeText(s) {
  return String(s || '')
    .replace(/₹/g, 'Rs.')
    .replace(/[—–]/g, '-')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function smsErrText(data, status) {
  const m = data && (data.message || data.error);
  return Array.isArray(m) ? m.join('; ') : (m ? String(m) : 'HTTP ' + status);
}
async function sendSmsFast2sms(to, text, key) {
  const num = String(to).replace(/\D/g, '').slice(-10);
  if (num.length !== 10) return { ok: false, error: 'Fast2SMS needs a 10-digit Indian mobile number.' };
  try {
    const resp = await fetch('https://www.fast2sms.com/dev/bulkV2', {
      method: 'POST', headers: { authorization: key, 'content-type': 'application/json' },
      body: JSON.stringify({ route: process.env.FAST2SMS_ROUTE || 'q', message: text, language: 'english', flash: 0, numbers: num })
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data && data.return === true) return { ok: true, data };
    console.warn('Fast2SMS send failed:', resp.status, JSON.stringify(data).slice(0, 300));
    return { ok: false, error: 'Fast2SMS: ' + smsErrText(data, resp.status) };
  } catch (e) { return { ok: false, error: 'Fast2SMS: ' + e.message }; }
}
async function sendSmsTextbee(to, text, key) {
  const deviceId = process.env.TEXTBEE_DEVICE_ID;
  const url = deviceId
    ? 'https://api.textbee.dev/api/v1/gateway/devices/' + encodeURIComponent(deviceId) + '/send-sms'
    : 'https://api.textbee.dev/api/v1/gateway/send-sms';
  try {
    const resp = await fetch(url, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ recipients: [toE164India(to)], message: text }) });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) { console.warn('TextBee send failed:', resp.status, JSON.stringify(data).slice(0, 300)); return { ok: false, error: 'TextBee: ' + smsErrText(data, resp.status) }; }
    return { ok: true, data };
  } catch (e) { return { ok: false, error: 'TextBee: ' + e.message }; }
}
async function sendSms(to, text) {
  const k = await loadSmsKeys();
  const order = [];
  if (k.f2s) order.push(['fast2sms', () => sendSmsFast2sms(to, text, k.f2s)]);
  if (k.tb) order.push(['textbee', () => sendSmsTextbee(to, text, k.tb)]);
  if (!order.length) return { ok: false, error: 'SMS is not configured.' };
  const errors = [];
  for (const [name, fn] of order) {
    const r = await fn();
    if (r.ok) return Object.assign({}, r, { provider: name });
    errors.push(r.error);
  }
  return { ok: false, error: errors.join(' | ') };
}
// Which channel(s) a message goes out on:
//   otp / update  -> SMS only (WhatsApp is the fallback if SMS can't be sent)
//   document / both -> SMS and WhatsApp together
//   whatsapp -> WhatsApp only (live chat replies, anything that starts a chat thread)
// Callers can force one with `kind`; otherwise it is worked out from the wording.
function classifyNotice(message, kind) {
  if (['otp', 'update', 'document', 'both', 'whatsapp'].includes(kind)) return kind;
  const m = String(message || '');
  if (/reply\s+yes/i.test(m)) return 'both';
  if (/\b(otp|verification code|confirmation code|delivery code|activation code)\b/i.test(m) || /\bcode\s*(is|:)\s*\d{4,6}\b/i.test(m)) return 'otp';
  if (/\/\?(rx|bill|labrx)=/.test(m) || (/https?:\/\//.test(m) && /\b(prescription|bill|invoice|receipt|report)\b/i.test(m))) return 'document';
  return 'update';
}
// Sends one notice on the channels its kind calls for. Returns which channels actually delivered.
async function deliverNotice(db, hospitalId, hospData, to, message, kind, tpl) {
  const k = classifyNotice(message, kind);
  const phoneNumberId = hospData && hospData.whatsappPhoneNumberId;
  const wantSms = k !== 'whatsapp' && (await smsReady());
  const smsFirst = k === 'otp' || k === 'update';
  const out = { kind: k, sms: null, whatsapp: null, via: null, error: null };
  const doSms = async () => {
    const tail = hospData && hospData.name ? '\n- ' + hospData.name : '';
    const r = await sendSms(to, smsSafeText(message) + tail);
    out.sms = r.ok; if (!r.ok) out.error = r.error;
    return r.ok;
  };
  const doWa = async () => {
    if (!phoneNumberId) { out.whatsapp = false; out.error = out.error || 'No WhatsApp number linked for this hospital.'; return false; }
    const r = await sendWhatsAppSmart(db, hospitalId, hospData, to, message, phoneNumberId, tpl);
    out.whatsapp = r.ok; out.via = r.via || null; if (!r.ok) out.error = out.error || (r.error || 'WhatsApp send failed');
    return r.ok;
  };
  if (smsFirst && wantSms) {
    if (!(await doSms())) await doWa();
  } else if (wantSms) {
    await Promise.all([doSms(), doWa()]);
  } else {
    await doWa();
  }
  out.sent = !!(out.sms || out.whatsapp);
  return out;
}

// Text when the window is open. Outside the window: the specific approved template the caller
// asked for (`tpl` = { name, params }), and if that's missing/not approved yet, plain text as a
// last resort so nothing is lost while Meta reviews templates.
async function sendWhatsAppSmart(db, hospitalId, hospData, to, message, fromPhoneNumberId, tpl) {
  if (await hasOpenWhatsAppWindow(db, hospitalId, to, hospData)) {
    const r = await sendWhatsAppText(to, message, fromPhoneNumberId);
    return { ...r, via: 'text' };
  }
  if (tpl && tpl.name && Array.isArray(tpl.params)) {
    const t = await sendWhatsAppTemplate(to, tpl.name, tpl.params, fromPhoneNumberId);
    if (t.ok) return { ...t, via: 'template:' + tpl.name };
  }
  const r = await sendWhatsAppText(to, message, fromPhoneNumberId);
  return { ...r, via: 'text-fallback' };
}

// Meta's webhook verification handshake — set this same URL + WA_VERIFY_TOKEN in Meta's
// WhatsApp app configuration.
app.get('/api/whatsapp-webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && process.env.WA_VERIFY_TOKEN && token === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.status(403).json({ error: 'hub.verify_token mismatch' });
});

// Doctor/date -> bookable slots, mirroring the client-side resolveDoctorSlotsForDate() in
// index.html (per-date override collection, falling back to the doctor's default template).
async function resolveDoctorSlotsForDateAdmin(db, hospitalId, doctorId, dateStr) {
  const ref = db.collection('hospitals/' + hospitalId + '/doctorSlots').doc(doctorId);
  const overrideSnap = await ref.collection('overrides').doc(dateStr).get();
  if (overrideSnap.exists) return overrideSnap.data().slots || [];
  const templateSnap = await ref.get();
  return templateSnap.exists ? (templateSnap.data().template || []) : [];
}

function computeSeniorPriorityAdmin(patient) {
  const age = parseInt(patient && patient.age) || 0;
  return age >= 60 ? { priority: 'senior', priorityReason: 'Senior citizen (Age ' + age + ')' } : {};
}

// Attendance is only ever tracked for TODAY (doctors check in fresh each morning), so this only
// blocks same-day slots/bookings — future dates aren't gated since presence can't be known yet.
// Mirrors the same rule the in-app patient booking flow already enforces (loadBookingSlots()).
async function isDoctorPresentToday(db, hospitalId, doctorId, dateStr) {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (dateStr !== todayStr) return true;
  const snap = await db.collection('hospitals/' + hospitalId + '/attendance')
    .where('date', '==', todayStr).where('doctorId', '==', doctorId).limit(1).get();
  return !snap.empty;
}

// Books a real MediFlow appointment + queue entry, respecting the same per-slot capacity limit
// (atomic transaction on the slotBookings doc) that the in-app patient booking flow uses.
async function bookAppointmentAdmin(db, hospitalId, patient, doctorId, dateStr, slotId, appointmentType) {
  const base = 'hospitals/' + hospitalId;
  const present = await isDoctorPresentToday(db, hospitalId, doctorId, dateStr);
  if (!present) return { error: 'This doctor has not checked in as present today, so today\'s slots cannot be booked yet. Tell the patient to try again later today, or offer a future date instead.' };
  const slots = await resolveDoctorSlotsForDateAdmin(db, hospitalId, doctorId, dateStr);
  const slot = slots.find(s => s.id === slotId);
  if (!slot) return { error: 'That slot no longer exists — call get_available_slots again for fresh options.' };

  const bookingRef = db.collection(base + '/slotBookings').doc(doctorId + '_' + dateStr + '_' + slotId);
  try {
    await db.runTransaction(async t => {
      const snap = await t.get(bookingRef);
      let current = snap.exists ? (snap.data().count || 0) : 0;
      if (current >= slot.limit) {
        // The counter says full — before trusting that, recount from the actual appointment
        // records (the real source of truth). A stale/inflated counter (e.g. from a duplicate
        // webhook delivery incrementing it more than once for one booking attempt) is exactly
        // the kind of drift that made a genuinely open slot report FULL — self-heal it here
        // instead of making every booking depend on someone noticing and fixing it manually.
        const apptSnap = await db.collection(base + '/appointments')
          .where('doctorId', '==', doctorId).where('appointmentDate', '==', dateStr).get();
        const real = apptSnap.docs.filter(d => d.data().slotId === slotId && d.data().status !== 'cancelled').length;
        if (real >= slot.limit) throw new Error('FULL');
        current = real; // corrected — proceed with the true count
      }
      t.set(bookingRef, { count: current + 1, limit: slot.limit, doctorId, date: dateStr, slotId }, { merge: true });
    });
  } catch(e) {
    if (e.message === 'FULL') return { error: 'That slot just filled up — pick a different one.' };
    return { error: e.message };
  }

  const docSnap = await db.collection(base + '/doctors').doc(doctorId).get();
  const doctorName = docSnap.exists ? docSnap.data().name : '';
  const [h, m] = slot.start.split(':').map(Number);
  const apptDate = new Date(dateStr + 'T00:00:00');
  apptDate.setHours(h, m, 0, 0);

  const qCountSnap = await db.collection(base + '/queue').where('date','==',dateStr).where('doctorId','==',doctorId).get();
  const token = qCountSnap.size + 1;
  const priority = computeSeniorPriorityAdmin(patient);

  const apptRef = await db.collection(base + '/appointments').add({
    patientId: patient.patientId, patientName: patient.name,
    doctorId, doctorName,
    date: admin.firestore.Timestamp.fromDate(apptDate),
    appointmentDate: dateStr, appointmentTime: slot.label,
    slotId: slot.id, slotLabel: slot.label,
    token, status: 'pending', notes: 'Booked via WhatsApp',
    appointmentType: appointmentType === 'online' ? 'online' : 'offline',
    hospitalId, createdAt: admin.firestore.FieldValue.serverTimestamp(), emailSent: false,
    source: 'whatsapp',
    ...priority
  });
  await db.collection(base + '/queue').add({
    patientId: patient.patientId, patientName: patient.name,
    doctorId, appointmentId: apptRef.id, token, status: 'waiting', date: dateStr,
    ...priority
  });
  return { ok: true, token, doctorName, date: dateStr, time: slot.label };
}

// The model's tool menu — names/descriptions ARE the interface the model reasons over, keep them
// specific rather than generic.
// Same public no-login links the app itself generates (see buildPrescriptionLink/buildBillLink in
// index.html) — used below so the WhatsApp assistant can hand a patient a real tappable link
// instead of just describing their prescription/bill in text.
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://mediflow-naitik.vercel.app';
function buildPrescriptionLinkServer(apptId, hospitalId) {
  return APP_BASE_URL + '/?rx=' + encodeURIComponent(apptId) + '&h=' + encodeURIComponent(hospitalId);
}
function buildBillLinkServer(billId, hospitalId) {
  return APP_BASE_URL + '/?bill=' + encodeURIComponent(billId) + '&h=' + encodeURIComponent(hospitalId);
}
// Pulls YYYY-MM-DD out of whichever date shape a record happens to have — some are Firestore
// Timestamps (completedAt/createdAt), some are plain strings already in that shape (date,
// appointmentDate) — so a caller can compare either against a patient-supplied date string.
function recordDateStr(r, ...fields) {
  for (const f of fields) {
    const v = r[f];
    if (typeof v === 'string' && v) return v.slice(0, 10);
    if (v && typeof v.toDate === 'function') return v.toDate().toISOString().slice(0, 10);
  }
  return '';
}

const WA_TOOLS = [
  { name: 'list_doctors', description: 'List all active doctors with specialization and their internal doctor ID. Call this first for any question about doctors, departments, or before booking.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'get_available_slots', description: 'Get a doctor\'s bookable time slots for one date, including how many seats are already taken in each. Always call this before book_appointment. For today\'s date, this also reports whether the doctor has checked in as present yet (doctorPresentToday) — if false, tell the patient today\'s slots aren\'t available yet instead of trying to book.', parameters: { type: 'OBJECT', properties: { doctorId: { type: 'STRING' }, date: { type: 'STRING', description: 'YYYY-MM-DD' } }, required: ['doctorId', 'date'] } },
  { name: 'book_appointment', description: 'Books a confirmed appointment for THIS patient. Only call after the patient has explicitly confirmed a specific doctor, date and slot from get_available_slots, AND told you whether they want an online (video call) or offline (in-person) visit.', parameters: { type: 'OBJECT', properties: { doctorId: { type: 'STRING' }, date: { type: 'STRING' }, slotId: { type: 'STRING' }, appointmentType: { type: 'STRING', description: '"online" for a video consultation, or "offline" for an in-person visit' } }, required: ['doctorId', 'date', 'slotId', 'appointmentType'] } },
  { name: 'get_my_appointments', description: 'Lists THIS patient\'s own upcoming pending appointments, with their appointment IDs.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'cancel_appointment', description: 'Cancels one of THIS patient\'s own upcoming appointments. Get the appointment_id from get_my_appointments first and confirm with the patient before cancelling.', parameters: { type: 'OBJECT', properties: { appointmentId: { type: 'STRING' } }, required: ['appointmentId'] } },
  { name: 'get_prescription', description: 'Finds THIS patient\'s own completed prescription and returns the medicines prescribed (name, dose, when to take, with/after food, duration) plus a tappable link to view/download it. Use it when they ask for their prescription OR to see/show their medicines. Leave date empty for their most recent one, or pass a specific date if they asked for that visit\'s prescription.', parameters: { type: 'OBJECT', properties: { date: { type: 'STRING', description: 'YYYY-MM-DD, optional — the visit date they\'re asking about' } } } },
  { name: 'get_bill', description: 'Finds THIS patient\'s own bill and returns its amount, payment status, and a tappable link to view/pay it. Leave date empty for their most recent bill, or pass a specific date if they asked for that date\'s bill.', parameters: { type: 'OBJECT', properties: { date: { type: 'STRING', description: 'YYYY-MM-DD, optional' } } } },
  { name: 'escalate_to_admin', description: 'Hands off to hospital front-desk staff for anything you cannot or should not resolve yourself — complaints, billing disputes, emergencies, or clinical questions. Always tell the patient a team member will reach out.', parameters: { type: 'OBJECT', properties: { reason: { type: 'STRING' }, urgent: { type: 'BOOLEAN' } }, required: ['reason'] } },
  { name: 'submit_feedback', description: 'Records THIS patient\'s feedback or star rating about a completed visit (e.g. after they reply to a "your appointment is completed" message, or whenever they volunteer feedback). Goes straight into the hospital admin\'s Feedback Inbox.', parameters: { type: 'OBJECT', properties: { message: { type: 'STRING', description: 'The feedback text, in the patient\'s own words (translate to English is not required — store as given)' }, rating: { type: 'NUMBER', description: '1-5 star rating if the patient gave one, otherwise omit' } }, required: ['message'] } },
  { name: 'list_medicine_prices', description: 'Looks up medicines in the hospital pharmacy\'s catalog and returns their price and stock. Use this whenever the patient asks the price/rate of a medicine, asks what medicines the store has / to "show the medicines", or before order_medicine to confirm what\'s actually in stock. Leave query empty to list the catalog (in-stock first); pass a name or part of one to search.', parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Medicine name or partial name to search for. Optional — omit to list what the pharmacy has.' } } } },
  { name: 'order_medicine', description: 'Places a medicine order for THIS patient with the hospital pharmacy. Only call after confirming the exact medicine names + quantities (via list_medicine_prices) AND whether they want store pickup or home delivery — for delivery, also get their address. Payment is collected as cash on pickup/delivery; there is no online payment over WhatsApp.', parameters: { type: 'OBJECT', properties: { items: { type: 'ARRAY', items: { type: 'OBJECT', properties: { name: { type: 'STRING' }, qty: { type: 'NUMBER' } }, required: ['name', 'qty'] }, description: 'Medicine names (matched against list_medicine_prices results) and quantities' }, fulfillment: { type: 'STRING', description: '"pickup" or "delivery"' }, deliveryAddress: { type: 'STRING', description: 'Required when fulfillment is "delivery"' } }, required: ['items', 'fulfillment'] } },
  { name: 'get_order_status', description: 'Checks THIS patient\'s own medicine order(s) — status, order code, and (if out for delivery) the delivery code and assigned delivery person\'s name/phone. Use this whenever the patient asks "where is my order", "what\'s my order status", or asks for their code again because they lost it.', parameters: { type: 'OBJECT', properties: {} } }
];

async function execWaTool(db, hospitalId, patient, name, args) {
  const base = 'hospitals/' + hospitalId;
  // Gemini's functionResponse.response field must be a JSON object/struct — never a bare array —
  // so every list result here is wrapped (e.g. { doctors: [...] }) instead of returned raw.
  if (name === 'list_doctors') {
    const snap = await db.collection(base + '/doctors').where('active', '==', true).get();
    return { doctors: snap.docs.map(d => ({ doctorId: d.id, name: d.data().name, specialization: d.data().specialization || '' })) };
  }
  if (name === 'get_available_slots') {
    const present = await isDoctorPresentToday(db, hospitalId, args.doctorId, args.date);
    if (!present) return { doctorPresentToday: false, slots: [], note: 'This doctor has not checked in as present today. Tell the patient today\'s slots are not available yet and suggest trying later today or picking a future date.' };
    const slots = await resolveDoctorSlotsForDateAdmin(db, hospitalId, args.doctorId, args.date);
    const counts = await Promise.all(slots.map(s => db.collection(base + '/slotBookings').doc(args.doctorId + '_' + args.date + '_' + s.id).get()));
    return { doctorPresentToday: true, slots: slots.map((s, i) => ({ slotId: s.id, label: s.label, limit: s.limit, booked: counts[i].exists ? (counts[i].data().count || 0) : 0 })) };
  }
  if (name === 'book_appointment') return await bookAppointmentAdmin(db, hospitalId, patient, args.doctorId, args.date, args.slotId, args.appointmentType);
  if (name === 'get_my_appointments') {
    const snap = await db.collection(base + '/appointments').where('patientId', '==', patient.patientId).where('status', '==', 'pending').get();
    return { appointments: snap.docs.map(d => ({ appointmentId: d.id, doctorName: d.data().doctorName, date: d.data().appointmentDate, time: d.data().appointmentTime, token: d.data().token })) };
  }
  if (name === 'cancel_appointment') {
    await db.collection(base + '/appointments').doc(args.appointmentId).update({ status: 'cancelled' });
    const qSnap = await db.collection(base + '/queue').where('appointmentId', '==', args.appointmentId).get();
    await Promise.all(qSnap.docs.map(d => d.ref.update({ status: 'cancelled' })));
    return { ok: true };
  }
  if (name === 'get_prescription') {
    const snap = await db.collection(base + '/appointments').where('patientId', '==', patient.patientId).where('status', '==', 'done').get();
    // A prescription's medicines are an array of objects on the appointment (older records may be
    // plain text). An empty array or the text 'None' used to count as "has medicines".
    const medsOf = r => Array.isArray(r.medicines) ? r.medicines.filter(m => m && (m.medicineName || m.name)) : [];
    const hasMeds = r => medsOf(r).length > 0 || (typeof r.medicines === 'string' && r.medicines.trim() && r.medicines.trim() !== 'None');
    let docs = snap.docs.filter(d => d.data().diagnosis || hasMeds(d.data()));
    if (args.date) docs = docs.filter(d => recordDateStr(d.data(), 'appointmentDate', 'date', 'completedAt') === args.date);
    docs.sort((a, b) => ((b.data().completedAt && b.data().completedAt.seconds) || 0) - ((a.data().completedAt && a.data().completedAt.seconds) || 0));
    if (!docs.length) return { found: false, note: args.date ? 'No completed visit found on that date.' : 'No completed prescriptions on file yet.' };
    const r = docs[0].data();
    const timing = m => [m.morning ? 'morning' : '', m.afternoon ? 'afternoon' : '', m.night ? 'night' : ''].filter(Boolean).join(' + ');
    const medicines = medsOf(r).map(m => ({
      name: [m.medicineName || m.name, m.strength].filter(Boolean).join(' '),
      type: m.medicineType || undefined,
      dose: m.dose || undefined,
      whenToTake: timing(m) || undefined,
      withFood: m.foodTiming || undefined,
      duration: m.duration || undefined
    }));
    return {
      found: true,
      date: recordDateStr(r, 'appointmentDate', 'date', 'completedAt'),
      doctorName: r.doctorName || '', diagnosis: r.diagnosis || '',
      medicines: medicines.length ? medicines : (typeof r.medicines === 'string' && r.medicines.trim() !== 'None' ? r.medicines : []),
      link: buildPrescriptionLinkServer(docs[0].id, hospitalId)
    };
  }
  if (name === 'get_bill') {
    const snap = await db.collection(base + '/bills').where('patientId', '==', patient.patientId).get();
    let docs = snap.docs;
    if (args.date) docs = docs.filter(d => recordDateStr(d.data(), 'date', 'createdAt') === args.date);
    docs.sort((a, b) => ((b.data().createdAt && b.data().createdAt.seconds) || 0) - ((a.data().createdAt && a.data().createdAt.seconds) || 0));
    if (!docs.length) return { found: false, note: args.date ? 'No bill found on that date.' : 'No bills on file yet.' };
    const r = docs[0].data();
    return {
      found: true,
      date: recordDateStr(r, 'date', 'createdAt'),
      amount: r.total || 0, purpose: r.purpose || r.billType || '', paid: !!r.paid,
      link: buildBillLinkServer(docs[0].id, hospitalId)
    };
  }
  if (name === 'escalate_to_admin') {
    // Structured fields (not just a text message) so the admin's Requests panel can render a
    // real actionable card — a tappable phone number, the patient's own record, a "Send
    // Prescription" button — instead of a plain notification line buried among routine ones.
    await db.collection(base + '/escalations').add({
      patientId: patient.patientId || '', patientName: patient.name || '', patientPhone: patient.phone || '',
      reason: args.reason || '', urgent: !!args.urgent, status: 'open',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { ok: true };
  }
  if (name === 'submit_feedback') {
    await db.collection(base + '/feedback').add({
      fromRole: 'patient', fromId: patient.patientId || '', fromName: patient.name || '',
      category: 'General', message: args.message || '',
      rating: (args.rating && Number(args.rating) >= 1 && Number(args.rating) <= 5) ? Number(args.rating) : null,
      status: 'new', featured: false, source: 'whatsapp',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { ok: true };
  }
  if (name === 'list_medicine_prices') {
    const q = String(args.query || '').toLowerCase().trim();
    const snap = await db.collection(base + '/medicines').get();
    const all = snap.docs.map(d => d.data()).filter(m => (m.name || '').trim());
    // Every word the patient typed has to appear in the name or category ("paracetamol 500"
    // finds "Paracetamol 500mg"); no search term at all means "show me what you have".
    const words = q.split(/\s+/).filter(Boolean);
    const hay = m => ((m.name || '') + ' ' + (m.category || '')).toLowerCase();
    const matched = words.length ? all.filter(m => words.every(w => hay(m).includes(w))) : all;
    matched.sort((a, b) => ((b.stock || 0) > 0) - ((a.stock || 0) > 0) || String(a.name).localeCompare(String(b.name)));
    const LIMIT = words.length ? 15 : 30;
    return {
      totalMatches: matched.length,
      showing: Math.min(matched.length, LIMIT),
      medicines: matched.slice(0, LIMIT).map(m => ({
        name: m.name, category: m.category || undefined, price: m.sellPrice || 0, unit: m.unit || undefined,
        inStock: (m.stock || 0) > 0, stock: m.stock || 0
      })),
      note: !matched.length ? (words.length ? 'Nothing in the catalog matches that name — say so, and offer to check a different spelling.' : 'The pharmacy catalog is empty.')
        : matched.length > LIMIT ? 'There are more than shown — tell the patient how many in total and ask them to name a medicine to narrow it down.' : undefined
    };
  }
  if (name === 'order_medicine') {
    const items = Array.isArray(args.items) ? args.items : [];
    if (!items.length) return { error: 'No items given.' };
    if (args.fulfillment === 'delivery' && !(args.deliveryAddress || '').trim()) {
      return { error: 'A delivery address is required for home delivery — ask the patient for it.' };
    }
    const hospSnapForHours = await db.collection('hospitals').doc(hospitalId).get();
    const hospDataForHours = hospSnapForHours.exists ? hospSnapForHours.data() : {};
    if (!isPharmacyOpenNow(hospDataForHours)) {
      return { error: 'The pharmacy is closed right now (hours: ' + (hospDataForHours.pharmacyOpenTime || '09:00') + '–' + (hospDataForHours.pharmacyCloseTime || '21:00') + '). Tell the patient they are welcome to visit the pharmacy counter in person, or place this order once it reopens.' };
    }
    const medsSnap = await db.collection(base + '/medicines').get();
    const catalog = medsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const resolved = [], unresolved = [];
    for (const it of items) {
      const nameQ = String(it.name || '').toLowerCase().trim();
      const named = catalog.filter(m => (m.name || '').trim());
      const med = named.find(m => m.name.toLowerCase().trim() === nameQ)
        || named.find(m => m.name.toLowerCase().includes(nameQ) || nameQ.includes(m.name.toLowerCase().trim()));
      if (!med) { unresolved.push(it.name); continue; }
      const qty = Math.max(1, Math.min(Number(it.qty) || 1, med.stock || 0));
      if (qty < 1 || (med.stock || 0) < 1) { unresolved.push(it.name + ' (out of stock)'); continue; }
      resolved.push({ medicineId: med.id, name: med.name, qty, sellPrice: med.sellPrice || 0, subtotal: qty * (med.sellPrice || 0) });
    }
    if (!resolved.length) return { error: 'None of those medicines could be matched or are in stock: ' + unresolved.join(', ') };
    const deliveryCharge = args.fulfillment === 'delivery' ? (hospDataForHours.pharmacyDeliveryCharge || 0) : 0;
    const subtotal = resolved.reduce((s, r) => s + r.subtotal, 0);
    // Same GST rule the app's own ordering flow uses (Settings gstPercent + the Customization
    // switch, default on) — a WhatsApp order was quoting tax-free before, out of step with every
    // other sale the Medical Store makes.
    const gstOn = (hospDataForHours.customizations && hospDataForHours.customizations.medStoreShowGST) !== false;
    const gstPercent = gstOn ? (hospDataForHours.gstPercent || 0) : 0;
    const gstAmount = Math.round(subtotal * gstPercent) / 100;
    const total = Math.round((subtotal + gstAmount + deliveryCharge) * 100) / 100;
    await db.collection(base + '/pharmacyOrders').add({
      patientId: patient.patientId || '', patientName: patient.name || '', orderedBy: 'whatsapp',
      medicines: resolved, subtotal, gstPercent, gstAmount, deliveryCharge, total,
      fulfillment: args.fulfillment === 'delivery' ? 'delivery' : 'pickup',
      deliveryAddress: args.fulfillment === 'delivery' ? args.deliveryAddress : '',
      status: 'pending', paymentStatus: 'cod',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return {
      ok: true, subtotal, gstAmount, deliveryCharge, total,
      unmatchedItems: unresolved.length ? unresolved : undefined,
      storeLink: (process.env.APP_URL || 'https://mediflow-naitik.vercel.app') + '/?go=patMedStore',
      note: 'Order placed. Payment is cash on ' + (args.fulfillment === 'delivery' ? 'delivery' : 'pickup') + '.'
    };
  }
  if (name === 'get_order_status') {
    const snap = await db.collection(base + '/pharmacyOrders')
      .where('patientId', '==', patient.patientId || '').where('orderedBy', 'in', ['patient', 'whatsapp']).get();
    const active = snap.docs.filter(d => d.data().status !== 'cancelled')
      .sort((a, b) => ((b.data().createdAt && b.data().createdAt.seconds) || 0) - ((a.data().createdAt && a.data().createdAt.seconds) || 0));
    if (!active.length) return { found: false, note: 'No medicine orders on file for this patient.' };
    return {
      found: true,
      orders: active.slice(0, 5).map(d => {
        const o = d.data();
        return {
          orderNumber: o.orderNumber || 'not yet accepted by the pharmacy',
          items: (o.medicines || []).map(m => (m.name || m.medicineName || 'medicine') + ' x' + (m.qty || m.estimatedQty || 1)).join(', '),
          total: o.total || 0,
          fulfillment: o.fulfillment,
          status: o.status === 'fulfilled' ? (o.fulfillment === 'delivery' ? 'delivered' : 'picked up') : (o.deliveryStatus || 'placed, awaiting pharmacy acceptance'),
          deliveryCode: o.deliveryStatus === 'code_sent' ? o.deliveryCode : undefined,
          deliveryPersonName: o.deliveryPersonName || undefined,
          deliveryPersonPhone: o.deliveryPersonPhone || undefined
        };
      })
    };
  }
  return { error: 'unknown tool' };
}

// Matches an inbound WhatsApp number to a MediFlow patient record by comparing the last 10
// digits (WhatsApp sends E.164-ish numbers, MediFlow's own `phone` field is typically stored
// as a plain 10-digit local number). Fetches the whole patients collection — fine for a single
// hospital's typical patient count, but would need a dedicated phone-lookup index at real scale.
async function findPatientByPhone(db, hospitalId, waPhone) {
  const last10 = String(waPhone).replace(/\D/g, '').slice(-10);
  if (last10.length !== 10) return null;
  const snap = await db.collection('hospitals/' + hospitalId + '/patients').get();
  const match = snap.docs.find(d => String(d.data().phone || '').replace(/\D/g, '').slice(-10) === last10);
  return match ? { docId: match.id, ...match.data() } : null;
}

// Downloads a WhatsApp voice note / audio message's raw bytes. WhatsApp media is fetched in two
// hops: first resolve the media id to a short-lived download URL, then download the actual bytes
// — both calls need the same bearer token.
async function fetchWhatsAppMedia(mediaId) {
  const token = await getWaAccessToken();
  const metaResp = await fetch('https://graph.facebook.com/v21.0/' + mediaId, { headers: { Authorization: 'Bearer ' + token } });
  if (!metaResp.ok) throw new Error('Could not fetch media metadata (' + metaResp.status + ')');
  const meta = await metaResp.json();
  const fileResp = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + token } });
  if (!fileResp.ok) throw new Error('Could not download media file (' + fileResp.status + ')');
  const buf = Buffer.from(await fileResp.arrayBuffer());
  return { buffer: buf, mimeType: meta.mime_type || 'audio/ogg' };
}

// Groq's chat models are text-only — unlike Gemini, they can't listen to audio inline — so a
// voice note gets transcribed via Groq's own Whisper endpoint first, then the transcript flows
// into the normal text conversation below exactly like a typed message would.
async function transcribeAudioWithGroq(apiKey, audioBuffer, mimeType) {
  const ext = (mimeType || '').includes('mp4') ? 'mp4' : (mimeType || '').includes('mpeg') ? 'mp3' : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/ogg' }), 'voice.' + ext);
  form.append('model', 'whisper-large-v3-turbo');
  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey },
    body: form
  });
  if (!resp.ok) throw new Error('Transcription failed: ' + resp.status + ' ' + await resp.text());
  const data = await resp.json();
  return (data.text || '').trim();
}

// Converts our Gemini-style flat tool defs ({name, description, parameters:{type:'OBJECT',...}})
// into the OpenAI/Groq tool-calling schema ({type:'function', function:{name, description,
// parameters}}), lowercasing the JSON Schema type keywords along the way (OBJECT -> object,
// STRING -> string, etc.) — keeps WA_TOOLS/ADMIN_WA_TOOLS below readable without hand-maintaining
// two near-duplicate schemas per tool.
function lowerSchemaTypes(schema) {
  if (Array.isArray(schema)) return schema.map(lowerSchemaTypes);
  if (schema && typeof schema === 'object') {
    const out = {};
    for (const k in schema) out[k] = (k === 'type' && typeof schema[k] === 'string') ? schema[k].toLowerCase() : lowerSchemaTypes(schema[k]);
    return out;
  }
  return schema;
}
function toOpenAiTools(toolDefs) {
  return toolDefs.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: lowerSchemaTypes(t.parameters) } }));
}

async function runWhatsAppAgent(db, hospitalId, hospitalName, patient, userText, apiKey, history) {
  const hospLabel = hospitalName || 'the hospital';
  const systemPrompt = 'You are ' + hospLabel + '\'s 24x7 WhatsApp assistant. Always speak as ' + hospLabel + ' — never mention "MediFlow" or any platform/software name, the patient should only ever see this as ' + hospLabel + '\'s own service. Reply in the same language the patient writes in (English/Hindi/Hinglish), keep replies short (2-5 lines, WhatsApp style) — EXCEPT when showing a list (medicines, doctors, appointments, orders): then show every item returned, one per line, never cut a list short to stay within 5 lines. Format for WhatsApp: *single asterisks* for bold, plain "-" or numbered lines for lists; never use **double asterisks**, # headings or tables.\n' +
    'Patient: ' + patient.name + ' (ID ' + patient.patientId + '). Today\'s date: ' + new Date().toISOString().slice(0, 10) + '.\n\n' +
    'Scope: book appointments, cancel appointments (rescheduling = cancel + book new), answer doctor/department/timing questions, tell the patient their own upcoming appointments, send their own prescription or bill on request, and order medicines from the pharmacy.\n\n' +
    'STRICT RULES:\n' +
    '- Never diagnose or give medical/medication advice. For any clinical question say it needs to be discussed with a doctor and offer to help book one.\n' +
    '- If the message sounds like a medical emergency (chest pain, breathing difficulty, severe bleeding, unconsciousness), tell them to go to the nearest emergency room or call an ambulance immediately, AND call escalate_to_admin with urgent=true.\n' +
    '- Before booking, confirm doctor + date + slot AND whether they want an online (video call) or offline (in-person) visit — never guess or assume any of these.\n' +
    '- If get_available_slots reports doctorPresentToday as false, do NOT try to book that date — tell the patient the doctor hasn\'t checked in as present yet today, and suggest trying again later today or picking a future date instead.\n' +
    '- After a successful book_appointment, tell the patient their token number and mention this appointment now also shows up in their patient portal app — it\'s the same booking, not a separate one.\n' +
    '- If the patient asks for their prescription or bill, call get_prescription / get_bill. If they mention a date ("the one from last Tuesday", "my 5th August bill"), convert it to YYYY-MM-DD yourself (today\'s date is given above) and pass it as the date argument; otherwise leave date empty to get the most recent one. Always include the returned link EXACTLY as given in your reply — never shorten, retype or omit it. If found is false, tell them no matching record was found and offer escalate_to_admin instead of guessing.\n' +
    '- The patient may be replying to an automatic "your appointment is completed" message that asked them to reply YES for their prescription/bill and to share feedback. If they reply "yes" (or similar) in that context, treat it as asking for both — call get_prescription AND get_bill and share both links. If their reply contains actual feedback/opinion/complaint about the visit (praise, a complaint, a star rating like "5 stars" or "4/5"), call submit_feedback with that text (and the rating number if one was given) and thank them briefly — do not call escalate_to_admin just for ordinary feedback. That same completion message also means they may want to order the medicines from their prescription — if they mention wanting their medicines, walk them through order_medicine.\n' +
    '- If the patient asks to see / show / list "my medicines" or "my tablets", call get_prescription and list EVERY medicine returned, one per line, as: name — dose, when to take, with/after food, for how long (leave out any part that is missing), then the prescription link exactly as given. If they ask what medicines the store / pharmacy has or what is in stock, call list_medicine_prices with no query (or with the name/category they mentioned) and list every item returned with its price (₹) and "in stock" or "out of stock"; if totalMatches is more than showing, say how many there are in total and ask which one they want. Never invent a medicine, price or dose that a tool did not return.\n' +
    '- To order medicine: use list_medicine_prices to confirm each medicine is in stock and get its price, ask whether they want store pickup or home delivery (get their address for delivery), read back the full order + total (mention a delivery charge applies for delivery, if any) and get an explicit yes before calling order_medicine. Payment is cash on pickup/delivery only — never claim you can take payment over WhatsApp.\n' +
    '- Whenever the patient wants to order, browse or reorder medicines, or asks to see their order details, ALSO give them this link exactly as written so they can open the Medical Store section of their patient portal directly: ' + (process.env.APP_URL || 'https://mediflow-naitik.vercel.app') + '/?go=patMedStore (they log in once, then land on the Medical Store page). After order_medicine succeeds, send the storeLink it returns too.\n' +
    '- If the patient asks about an existing medicine order ("where is my order", "what\'s my code again", "has it shipped"), call get_order_status and answer from that — never guess a status. If a delivery person and phone number are given, share both so the patient can reach them directly.\n' +
    '- Anything you can\'t resolve yourself (complaints, other billing disputes, clinical questions) — call escalate_to_admin and tell the patient a team member will reach out.';

  // Without this, every inbound WhatsApp message started a brand-new conversation with zero
  // memory of anything said before it — the model would ask "which date?" and then, on the
  // patient's very next message answering that question, have no idea a question was ever asked.
  // `history` (recent turns from this patient's own chat log) is prepended so the model actually
  // remembers what doctor/date/slot has already been discussed across separate messages.
  let messages = [{ role: 'system', content: systemPrompt }, ...(history || []), { role: 'user', content: userText }];
  for (let i = 0; i < 6; i++) {
    let resp;
    try {
      resp = await callGroq(apiKey, { messages, tools: toOpenAiTools(WA_TOOLS), temperature: 0.2, max_tokens: 2048 });
    } catch(e) { console.error('Groq agent request failed:', e.message); return 'Sorry, I\'m having trouble right now — please try again shortly or contact the front desk.'; }
    if (!resp.ok) { console.error('Groq agent error:', resp.status, await resp.text()); return 'Sorry, I\'m having trouble right now — please try again shortly or contact the front desk.'; }
    const data = await resp.json();
    const message = data.choices && data.choices[0] && data.choices[0].message;
    const toolCalls = message && message.tool_calls;
    if (!toolCalls || !toolCalls.length) {
      return (message && message.content) || 'Sorry, I couldn\'t process that — please try again.';
    }
    messages.push({ role: 'assistant', content: message.content || null, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch(e) {}
      let result;
      try { result = await execWaTool(db, hospitalId, patient, tc.function.name, args); }
      catch(e) { result = { error: e.message }; }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return 'Sorry, that took too many steps — please contact the front desk for help.';
}

// ============ ADMIN WHATSAPP QUERY AGENT ============
// Separate from the patient-facing booking assistant above — when the inbound WhatsApp message
// comes from the hospital's OWN admin (their personal number, saved in Settings), it gets routed
// here instead: read-only access to today's real numbers, no booking/patient tools at all.
const ADMIN_WA_TOOLS = [
  {
    name: 'get_hospital_stats',
    description: "Get today's live operational numbers for the hospital: appointments, revenue, staff attendance, pending items. Always use this instead of guessing when the admin asks about counts, money, or today's activity.",
    parameters: { type: 'OBJECT', properties: {}, required: [] }
  },
  {
    name: 'find_patient_appointments',
    description: "Look up a patient's upcoming (pending) appointments by their name or Patient ID. Use this BEFORE cancel_appointment so you have the real appointmentId to cancel — never guess or invent one.",
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Patient name or Patient ID' } }, required: ['query'] }
  },
  {
    name: 'cancel_appointment',
    description: "Cancels a specific appointment by its appointmentId (get this from find_patient_appointments first). This is a real, irreversible change — confirm the patient name and appointment time with the admin in the conversation before calling this.",
    parameters: { type: 'OBJECT', properties: { appointmentId: { type: 'STRING' } }, required: ['appointmentId'] }
  },
  {
    name: 'set_doctor_attendance',
    description: "Marks a doctor present or absent for TODAY only (matches what the in-app Attendance page shows). Use this when the admin says something like 'mark Dr. Sharma present' or 'Dr. Verma is off today'.",
    parameters: { type: 'OBJECT', properties: { doctorName: { type: 'STRING' }, present: { type: 'BOOLEAN' } }, required: ['doctorName', 'present'] }
  }
];

// Mirrors the client-side isPharmacyOpenNow() in index.html — server runs in UTC, so "now" is
// shifted to IST first (the app's whole userbase, and its pharmacyOpenTime/pharmacyCloseTime
// settings, are IST) before comparing against the configured hours.
function isPharmacyOpenNow(hosp) {
  if (!hosp || hosp.pharmacy24Hours !== false) return true;
  const openTime = hosp.pharmacyOpenTime || '09:00';
  const closeTime = hosp.pharmacyCloseTime || '21:00';
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const nowMin = istNow.getUTCHours() * 60 + istNow.getUTCMinutes();
  const [oh, om] = openTime.split(':').map(Number);
  const [ch, cm] = closeTime.split(':').map(Number);
  const openMin = oh * 60 + om, closeMin = ch * 60 + cm;
  if (closeMin <= openMin) return nowMin >= openMin || nowMin < closeMin;
  return nowMin >= openMin && nowMin < closeMin;
}

async function getHospitalStatsAdmin(db, hospitalId) {
  const today = new Date().toISOString().slice(0, 10);
  // "Today's appointments" means appointments SCHEDULED for today, not appointments booked/created
  // today — most bookings happen a day or more in advance, so filtering on createdAt (the old
  // behaviour) reported near-zero appointments even on a fully booked day. appointmentDate is the
  // same YYYY-MM-DD field the in-app dashboard and doctor WhatsApp queries already key off.
  const [apptsSnap, consultsSnap, patsSnap, docsSnap, billsTodaySnap, attendSnap, unpaidBillsSnap, hcApprovalsSnap, insApprovalsSnap, feedbackSnap] = await Promise.all([
    db.collection('hospitals/' + hospitalId + '/appointments').where('appointmentDate', '==', today).get().catch(() => ({ docs: [] })),
    db.collection('hospitals/' + hospitalId + '/consultations').where('date', '==', today).get().catch(() => ({ docs: [] })),
    db.collection('hospitals/' + hospitalId + '/patients').get().catch(() => ({ size: 0 })),
    db.collection('hospitals/' + hospitalId + '/doctors').get().catch(() => ({ size: 0 })),
    db.collection('hospitals/' + hospitalId + '/bills').where('date', '==', today).get().catch(() => ({ docs: [] })),
    db.collection('hospitals/' + hospitalId + '/attendance').where('date', '==', today).get().catch(() => ({ docs: [] })),
    // Pending payment approvals actually live across three separate collections — there is no
    // single "paymentApprovals" collection (the old query here pointed at one nothing ever
    // writes to, so this always silently reported zero even with a full approvals queue) — this
    // now matches exactly what the in-app Payment Approvals page (loadAdminPaymentApprovals) reads.
    db.collection('hospitals/' + hospitalId + '/bills').where('paid', '==', false).get().catch(() => ({ docs: [] })),
    db.collection('hospitals/' + hospitalId + '/healthCardTopupRequests').where('status', '==', 'pending').get().catch(() => ({ size: 0 })),
    db.collection('hospitals/' + hospitalId + '/insurancePremiumRequests').where('status', '==', 'pending').get().catch(() => ({ size: 0 })),
    db.collection('hospitals/' + hospitalId + '/feedback').where('status', '!=', 'reviewed').get().catch(() => ({ size: 0 }))
  ]);
  const appts = apptsSnap.docs || [];
  const consults = consultsSnap.docs || [];
  const bills = billsTodaySnap.docs || [];
  const revenueToday = bills.filter(d => d.data().paid).reduce((s, d) => s + (d.data().total || 0), 0);
  const consultDone = c => c.data().status === 'done';
  const pendingBillApprovals = (unpaidBillsSnap.docs || []).filter(d => d.data().patientClaimedPaid && !d.data().rejected).length;
  return {
    date: today,
    appointmentsToday: appts.length + consults.length,
    completedToday: appts.filter(d => d.data().status === 'done').length + consults.filter(consultDone).length,
    pendingToday: appts.filter(d => d.data().status !== 'done').length + consults.filter(c => !consultDone(c)).length,
    revenueTodayInr: revenueToday,
    billsToday: bills.length,
    totalPatients: patsSnap.size,
    totalDoctors: docsSnap.size,
    staffPresentToday: (attendSnap.docs || []).length,
    pendingPaymentApprovals: pendingBillApprovals + hcApprovalsSnap.size + insApprovalsSnap.size,
    unreadFeedback: feedbackSnap.size !== undefined ? feedbackSnap.size : (feedbackSnap.docs || []).length
  };
}

async function findPatientAppointmentsAdmin(db, hospitalId, query) {
  const base = 'hospitals/' + hospitalId;
  const q = String(query || '').trim();
  if (!q) return { appointments: [], note: 'No search term given.' };
  let patientIds = [];
  const byIdSnap = await db.collection(base + '/patients').where('patientId', '==', q.toUpperCase()).limit(1).get();
  if (!byIdSnap.empty) {
    patientIds = [byIdSnap.docs[0].data().patientId];
  } else {
    const allPats = await db.collection(base + '/patients').get();
    patientIds = allPats.docs.filter(d => (d.data().name || '').toLowerCase().includes(q.toLowerCase())).map(d => d.data().patientId).slice(0, 10);
  }
  if (!patientIds.length) return { appointments: [], note: 'No matching patient found for "' + q + '".' };
  const apptsSnap = await db.collection(base + '/appointments').where('patientId', 'in', patientIds).where('status', '==', 'pending').get();
  return {
    appointments: apptsSnap.docs.map(d => ({
      appointmentId: d.id, patientName: d.data().patientName, doctorName: d.data().doctorName,
      date: d.data().appointmentDate, time: d.data().appointmentTime, token: d.data().token
    }))
  };
}

async function cancelAppointmentAdmin(db, hospitalId, appointmentId) {
  if (!appointmentId) return { error: 'No appointmentId given — call find_patient_appointments first.' };
  const ref = db.collection('hospitals/' + hospitalId + '/appointments').doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) return { error: 'That appointment no longer exists.' };
  if (snap.data().status === 'cancelled') return { ok: true, note: 'Already cancelled.', patientName: snap.data().patientName };
  await ref.update({ status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp(), cancelledBy: 'whatsapp-admin' });
  return { ok: true, patientName: snap.data().patientName, doctorName: snap.data().doctorName };
}

async function setDoctorAttendanceAdmin(db, hospitalId, doctorName, present) {
  const base = 'hospitals/' + hospitalId;
  const docsSnap = await db.collection(base + '/doctors').get();
  const match = docsSnap.docs.find(d => (d.data().name || '').toLowerCase().includes(String(doctorName || '').toLowerCase()));
  if (!match) return { error: 'No doctor found matching "' + doctorName + '".' };
  const today = new Date().toISOString().slice(0, 10);
  const attCol = db.collection(base + '/attendance');
  const existing = await attCol.where('date', '==', today).where('doctorId', '==', match.id).limit(1).get();
  if (present) {
    if (existing.empty) {
      await attCol.add({ doctorId: match.id, doctorName: match.data().name, date: today, checkIn: new Date().toLocaleTimeString() });
    }
    return { ok: true, doctorName: match.data().name, status: 'present' };
  }
  if (!existing.empty) await Promise.all(existing.docs.map(d => d.ref.delete()));
  return { ok: true, doctorName: match.data().name, status: 'absent' };
}

async function execAdminWaTool(db, hospitalId, name, args) {
  if (name === 'get_hospital_stats') return await getHospitalStatsAdmin(db, hospitalId);
  if (name === 'find_patient_appointments') return await findPatientAppointmentsAdmin(db, hospitalId, args.query);
  if (name === 'cancel_appointment') return await cancelAppointmentAdmin(db, hospitalId, args.appointmentId);
  if (name === 'set_doctor_attendance') return await setDoctorAttendanceAdmin(db, hospitalId, args.doctorName, args.present);
  return { error: 'unknown tool' };
}

async function runAdminWhatsAppAgent(db, hospitalId, hospitalName, userText, apiKey, history) {
  const systemPrompt = 'You are ' + (hospitalName || 'the hospital') + '\'s internal AI assistant, talking directly to the hospital ADMIN on their own personal WhatsApp number — this is an internal ops channel, not patient-facing. ' +
    'Answer questions about today\'s appointments, revenue, staff attendance, pending payment approvals, and unread feedback using the get_hospital_stats tool — never guess or make up a number, always call the tool first.\n' +
    'You can also take real actions on the admin\'s behalf: cancel an appointment (look it up with find_patient_appointments first, then confirm the patient name/time with the admin before calling cancel_appointment — it\'s irreversible), and mark a doctor present/absent for today with set_doctor_attendance.\n' +
    'Keep replies short and scannable (WhatsApp style, use line breaks/emoji sparingly). If asked something outside these operational stats/actions (e.g. clinical advice, unrelated topics), say this channel is only for hospital operations.';
  let messages = [{ role: 'system', content: systemPrompt }, ...(history || []), { role: 'user', content: userText }];
  for (let i = 0; i < 5; i++) {
    let resp;
    try {
      resp = await callGroq(apiKey, { messages, tools: toOpenAiTools(ADMIN_WA_TOOLS), temperature: 0.2, max_tokens: 1024 });
    } catch(e) { return 'Sorry, having trouble reaching the AI right now — try again shortly.'; }
    if (!resp.ok) return 'Sorry, having trouble reaching the AI right now — try again shortly.';
    const data = await resp.json();
    const message = data.choices && data.choices[0] && data.choices[0].message;
    const toolCalls = message && message.tool_calls;
    if (!toolCalls || !toolCalls.length) {
      return (message && message.content) || 'Sorry, could not process that.';
    }
    messages.push({ role: 'assistant', content: message.content || null, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch(e) {}
      let result;
      try { result = await execAdminWaTool(db, hospitalId, tc.function.name, args); } catch(e) { result = { error: e.message }; }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return 'Sorry, that took too many steps — try asking again more specifically.';
}

// Loads the last N turns of a WhatsApp chat thread as {role, content} messages the model can use
// as conversation history — without this, every inbound message started a fresh conversation with
// no memory of what was already discussed (see runWhatsAppAgent above for the full story).
async function loadWaHistory(chatRef, limit) {
  try {
    const snap = await chatRef.collection('messages').orderBy('at', 'asc').limitToLast(limit || 16).get();
    return snap.docs.map(d => {
      const m = d.data();
      return { role: m.direction === 'out' ? 'assistant' : 'user', content: m.text || '' };
    });
  } catch(e) { console.warn('loadWaHistory failed:', e.message); return []; }
}

// ============ DOCTOR WHATSAPP QUERY AGENT ============
// A third scope alongside the patient-facing booking assistant and the admin ops-query agent —
// a doctor's own personal number (set in their AI Preferences), scoped to only THEIR OWN
// appointments/queue/attendance, never another doctor's or the hospital's finances.
const DOCTOR_WA_TOOLS = [
  {
    name: 'get_my_today_appointments',
    description: "Lists THIS doctor's own appointments for today — patient name, time, token, status. Always call this instead of guessing when asked about today's schedule/queue.",
    parameters: { type: 'OBJECT', properties: {}, required: [] }
  },
  {
    name: 'find_my_appointments',
    description: "Search THIS doctor's own upcoming (pending) appointments by patient name or Patient ID. Use this BEFORE cancel_my_appointment so you have the real appointmentId — never guess one.",
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: 'Patient name or Patient ID' } }, required: ['query'] }
  },
  {
    name: 'cancel_my_appointment',
    description: "Cancels one of THIS doctor's own appointments by its appointmentId (get it from find_my_appointments first). Irreversible — confirm the patient name/time with the doctor before calling this.",
    parameters: { type: 'OBJECT', properties: { appointmentId: { type: 'STRING' } }, required: ['appointmentId'] }
  },
  {
    name: 'set_my_attendance',
    description: "Marks THIS doctor present or absent for TODAY only. Use when they say something like 'mark me present' or 'I'm off today'.",
    parameters: { type: 'OBJECT', properties: { present: { type: 'BOOLEAN' } }, required: ['present'] }
  }
];

// Reads from appointments/consultations directly (the authoritative records) rather than the
// queue collection — queue entries can drift or, for online video consultations, never get
// created at all, which meant a doctor asking about "today" over WhatsApp could get a list
// missing some or all of their online consults for the day.
async function getMyTodayAppointmentsDoctor(db, hospitalId, doctorId) {
  const today = new Date().toISOString().slice(0, 10);
  const base = 'hospitals/' + hospitalId;
  const [apptSnap, consultSnap] = await Promise.all([
    db.collection(base + '/appointments').where('doctorId', '==', doctorId).where('appointmentDate', '==', today).get(),
    db.collection(base + '/consultations').where('doctorId', '==', doctorId).where('date', '==', today).get().catch(() => ({ docs: [] }))
  ]);
  const offline = apptSnap.docs.filter(d => d.data().status !== 'cancelled').map(d => ({
    patientName: d.data().patientName, time: d.data().appointmentTime || '', token: d.data().token || '', status: d.data().status, type: 'offline'
  }));
  const online = consultSnap.docs.filter(d => d.data().status !== 'cancelled').map(d => ({
    patientName: d.data().patientName, time: '', token: '', status: d.data().status, type: 'online (video)'
  }));
  return { date: today, appointments: [...offline, ...online] };
}

async function findMyAppointmentsDoctor(db, hospitalId, doctorId, query) {
  const base = 'hospitals/' + hospitalId;
  const q = String(query || '').trim();
  if (!q) return { appointments: [], note: 'No search term given.' };
  let patientIds = [];
  const byIdSnap = await db.collection(base + '/patients').where('patientId', '==', q.toUpperCase()).limit(1).get();
  if (!byIdSnap.empty) {
    patientIds = [byIdSnap.docs[0].data().patientId];
  } else {
    const allPats = await db.collection(base + '/patients').get();
    patientIds = allPats.docs.filter(d => (d.data().name || '').toLowerCase().includes(q.toLowerCase())).map(d => d.data().patientId).slice(0, 10);
  }
  if (!patientIds.length) return { appointments: [], note: 'No matching patient found for "' + q + '".' };
  const apptsSnap = await db.collection(base + '/appointments')
    .where('doctorId', '==', doctorId).where('patientId', 'in', patientIds).where('status', '==', 'pending').get();
  return {
    appointments: apptsSnap.docs.map(d => ({
      appointmentId: d.id, patientName: d.data().patientName,
      date: d.data().appointmentDate, time: d.data().appointmentTime, token: d.data().token
    }))
  };
}

async function cancelMyAppointmentDoctor(db, hospitalId, doctorId, appointmentId) {
  if (!appointmentId) return { error: 'No appointmentId given — call find_my_appointments first.' };
  const ref = db.collection('hospitals/' + hospitalId + '/appointments').doc(appointmentId);
  const snap = await ref.get();
  if (!snap.exists) return { error: 'That appointment no longer exists.' };
  if (snap.data().doctorId !== doctorId) return { error: 'That appointment belongs to a different doctor — not allowed to cancel it from here.' };
  if (snap.data().status === 'cancelled') return { ok: true, note: 'Already cancelled.', patientName: snap.data().patientName };
  await ref.update({ status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp(), cancelledBy: 'whatsapp-doctor' });
  return { ok: true, patientName: snap.data().patientName };
}

async function setMyAttendanceDoctor(db, hospitalId, doctorId, doctorName, present) {
  const today = new Date().toISOString().slice(0, 10);
  const attCol = db.collection('hospitals/' + hospitalId + '/attendance');
  const existing = await attCol.where('date', '==', today).where('doctorId', '==', doctorId).limit(1).get();
  if (present) {
    if (existing.empty) await attCol.add({ doctorId, doctorName, date: today, checkIn: new Date().toLocaleTimeString() });
    return { ok: true, status: 'present' };
  }
  if (!existing.empty) await Promise.all(existing.docs.map(d => d.ref.delete()));
  return { ok: true, status: 'absent' };
}

async function execDoctorWaTool(db, hospitalId, doctor, name, args) {
  if (name === 'get_my_today_appointments') return await getMyTodayAppointmentsDoctor(db, hospitalId, doctor.id);
  if (name === 'find_my_appointments') return await findMyAppointmentsDoctor(db, hospitalId, doctor.id, args.query);
  if (name === 'cancel_my_appointment') return await cancelMyAppointmentDoctor(db, hospitalId, doctor.id, args.appointmentId);
  if (name === 'set_my_attendance') return await setMyAttendanceDoctor(db, hospitalId, doctor.id, doctor.name, args.present);
  return { error: 'unknown tool' };
}

async function runDoctorWhatsAppAgent(db, hospitalId, hospitalName, doctor, userText, apiKey, history) {
  const systemPrompt = 'You are ' + (hospitalName || 'the hospital') + '\'s internal AI assistant, talking directly to Dr. ' + doctor.name + ' on their own personal WhatsApp number — an internal ops channel, not patient-facing. ' +
    "Answer questions about THIS doctor's own today's schedule using get_my_today_appointments — never guess. " +
    'You can also cancel one of their own appointments (look it up with find_my_appointments first, confirm patient name/time before calling cancel_my_appointment — irreversible), and mark them present/absent today with set_my_attendance.\n' +
    'Keep replies short and scannable (WhatsApp style). Never diagnose or give clinical advice about their patients over this channel — this is for schedule/ops only.';
  let messages = [{ role: 'system', content: systemPrompt }, ...(history || []), { role: 'user', content: userText }];
  for (let i = 0; i < 5; i++) {
    let resp;
    try {
      resp = await callGroq(apiKey, { messages, tools: toOpenAiTools(DOCTOR_WA_TOOLS), temperature: 0.2, max_tokens: 1024 });
    } catch(e) { return 'Sorry, having trouble reaching the AI right now — try again shortly.'; }
    if (!resp.ok) return 'Sorry, having trouble reaching the AI right now — try again shortly.';
    const data = await resp.json();
    const message = data.choices && data.choices[0] && data.choices[0].message;
    const toolCalls = message && message.tool_calls;
    if (!toolCalls || !toolCalls.length) {
      return (message && message.content) || 'Sorry, could not process that.';
    }
    messages.push({ role: 'assistant', content: message.content || null, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch(e) {}
      let result;
      try { result = await execDoctorWaTool(db, hospitalId, doctor, tc.function.name, args); } catch(e) { result = { error: e.message }; }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  return 'Sorry, that took too many steps — try asking again more specifically.';
}

// Scans this hospital's doctors for one whose own personal WhatsApp number (set in their AI
// Preferences) matches the inbound sender — same last-10-digit comparison used for admin/patient
// number matching elsewhere, since WhatsApp sends E.164-ish numbers but the stored field is
// typically a plain 10-digit local number.
async function findDoctorByWhatsAppNumber(db, hospitalId, waPhone) {
  const last10 = String(waPhone).replace(/\D/g, '').slice(-10);
  if (last10.length !== 10) return null;
  const snap = await db.collection('hospitals/' + hospitalId + '/doctors').get();
  const match = snap.docs.find(d => String(d.data().doctorWhatsAppNumber || '').replace(/\D/g, '').slice(-10) === last10);
  return match ? { id: match.id, ...match.data() } : null;
}

// Every hospital gets its own WhatsApp number under the SAME Meta WhatsApp Business Account, so
// there's one shared access token/verify token but each hospital's number routes to its own
// Firestore data — looked up here by the `phone_number_id` Meta always includes in the webhook.
async function findHospitalIdByWhatsAppNumber(db, phoneNumberId) {
  const snap = await db.collection('hospitals').where('whatsappPhoneNumberId', '==', phoneNumberId).limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

async function handleWhatsAppMessage(body) {
  const value = body && body.entry && body.entry[0] && body.entry[0].changes && body.entry[0].changes[0] && body.entry[0].changes[0].value;
  const msg = value && value.messages && value.messages[0];
  if (!msg) return; // delivery/read status callbacks etc. — nothing to do

  const from = msg.from;
  const phoneNumberId = value.metadata && value.metadata.phone_number_id;

  // Meta redelivers a webhook it thinks failed (e.g. we took too long to acknowledge the first
  // time) — without this, that redelivery runs the whole AI agent again and sends a second (often
  // differently-worded) reply to the same "hi". Each inbound message has a unique WAMID, so a
  // Firestore doc keyed on it, created with .create() (fails if it already exists — atomic
  // test-and-set even across two near-simultaneous serverless invocations), is enough to catch and
  // silently drop true duplicates before any Gemini call happens.
  if (msg.id) {
    const dedupDb = getAdminDb();
    if (dedupDb) {
      try {
        await dedupDb.collection('waProcessedMessages').doc(msg.id).create({ processedAt: admin.firestore.FieldValue.serverTimestamp() });
      } catch(e) {
        console.log('Duplicate WhatsApp webhook delivery for message', msg.id, '— skipping.');
        return;
      }
    }
  }

  const groqKey = process.env.GROQ_API_KEY;
  let userText = null;
  if (msg.type === 'text') userText = msg.text.body;
  else if (msg.type === 'interactive' && msg.interactive.type === 'button_reply') userText = msg.interactive.button_reply.title;
  else if (msg.type === 'interactive' && msg.interactive.type === 'list_reply') userText = msg.interactive.list_reply.title;
  else if (msg.type === 'button') userText = msg.button.text;
  else if (msg.type === 'audio' && msg.audio && msg.audio.id) {
    // Voice notes and regular audio messages both arrive as type "audio" — Groq's chat model
    // can't listen to audio directly (unlike Gemini before it), so it's transcribed via Groq's
    // own Whisper endpoint first, then handled exactly like a typed message from here on.
    try {
      if (!groqKey) throw new Error('GROQ_API_KEY not set');
      const media = await fetchWhatsAppMedia(msg.audio.id);
      userText = await transcribeAudioWithGroq(groqKey, media.buffer, media.mimeType);
      if (!userText) throw new Error('empty transcription');
    } catch(e) {
      console.error('Could not transcribe WhatsApp voice note:', e.message);
      await sendWhatsAppText(from, 'Sorry, I couldn\'t listen to that voice message — could you try typing instead?', phoneNumberId);
      return;
    }
  }
  if (!userText) { await sendWhatsAppText(from, 'Sorry, I can only read text or voice messages right now.', phoneNumberId); return; }

  const db = getAdminDb();
  if (!groqKey || !db) {
    console.warn('WhatsApp assistant not fully configured — need GROQ_API_KEY and FIREBASE_SERVICE_ACCOUNT set.');
    return;
  }
  if (!phoneNumberId) { console.warn('WhatsApp webhook payload had no phone_number_id — cannot route to a hospital.'); return; }

  const hospitalId = await findHospitalIdByWhatsAppNumber(db, phoneNumberId);
  if (!hospitalId) {
    console.warn('No hospital is linked to WhatsApp number', phoneNumberId, '— set it in Manage Hospitals.');
    await sendWhatsAppText(from, 'This number isn\'t linked to a hospital yet. Please contact support.', phoneNumberId);
    return;
  }
  const hospSnap = await db.collection('hospitals').doc(hospitalId).get();
  const hospitalName = (hospSnap.exists && hospSnap.data().name) || 'the hospital';
  const hospData = hospSnap.exists ? hospSnap.data() : {};

  // The admin's own personal number (set in Settings) gets routed to the read-only ops-query
  // agent instead of the patient booking assistant — same phone number, different scope. Logged
  // to its own fixed thread (doc id 'ADMIN' can't collide with a real patientId, which is always
  // lowercase-prefix-dash-digits like "DEF-0001"). NOTE: this used to be '__admin__' — Firestore
  // silently rejects any document ID matching __*__ as "reserved", which meant every single
  // message to an admin's personal number threw before it could even be logged, let alone
  // replied to — the actual root cause of "messages to admin aren't working".
  const adminNumber = hospData.adminWhatsAppNumber;
  if (adminNumber && String(adminNumber).replace(/\D/g, '').slice(-10) === String(from).replace(/\D/g, '').slice(-10)) {
    const adminChatRef = db.collection('hospitals/' + hospitalId + '/waChats').doc('ADMIN');
    const adminHistory = await loadWaHistory(adminChatRef, 16);
    await adminChatRef.collection('messages').add({ direction: 'in', text: userText, at: admin.firestore.FieldValue.serverTimestamp() });
    const adminReply = await runAdminWhatsAppAgent(db, hospitalId, hospitalName, userText, groqKey, adminHistory);
    const adminSendResult = await sendWhatsAppText(from, adminReply, phoneNumberId);
    await adminChatRef.collection('messages').add({ direction: 'out', text: adminReply, wamid: adminSendResult.id || null, read: false, at: admin.firestore.FieldValue.serverTimestamp() });
    return;
  }

  // Same idea, per doctor — their own personal number (set in AI Preferences) routes to a
  // schedule/ops agent scoped to only THEIR OWN appointments, never another doctor's or the
  // hospital's finances. Checked before the patient lookup below.
  const doctor = await findDoctorByWhatsAppNumber(db, hospitalId, from);
  if (doctor) {
    const doctorChatRef = db.collection('hospitals/' + hospitalId + '/waChats').doc('DOCTOR_' + doctor.id);
    const doctorHistory = await loadWaHistory(doctorChatRef, 16);
    await doctorChatRef.collection('messages').add({ direction: 'in', text: userText, at: admin.firestore.FieldValue.serverTimestamp() });
    const doctorReply = await runDoctorWhatsAppAgent(db, hospitalId, hospitalName, doctor, userText, groqKey, doctorHistory);
    const doctorSendResult = await sendWhatsAppText(from, doctorReply, phoneNumberId);
    await doctorChatRef.collection('messages').add({ direction: 'out', text: doctorReply, wamid: doctorSendResult.id || null, read: false, at: admin.firestore.FieldValue.serverTimestamp() });
    return;
  }

  const patient = await findPatientByPhone(db, hospitalId, from);
  if (!patient) {
    await sendWhatsAppText(from, 'We couldn\'t find your account with this number. Please register at ' + hospitalName + ' first, or contact the front desk to link your number.', phoneNumberId);
    return;
  }

  // Load conversation history BEFORE logging this turn, so it doesn't include the message we're
  // about to answer — that's passed separately as the current turn (see runWhatsAppAgent).
  const chatRef = db.collection('hospitals/' + hospitalId + '/waChats').doc(patient.patientId);
  const history = await loadWaHistory(chatRef, 16);

  // Every inbound message is logged to a per-patient chat thread regardless of who (or what)
  // answers it — this is what powers the admin's live-chat view in WhatsApp Messages. Voice notes
  // log their transcript prefixed so it's clear in the chat view it was spoken, not typed.
  const inboundText = (msg.type === 'audio' ? '🎤 ' : '') + userText;
  await chatRef.set({ patientName: patient.name, patientId: patient.patientId, phone: from, lastMessageAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  await chatRef.collection('messages').add({ direction: 'in', text: inboundText, at: admin.firestore.FieldValue.serverTimestamp() });

  // Front desk staff can take a conversation over in the live-chat view (sets mode:'human') —
  // while that's set, the AI stays quiet on this thread so it doesn't talk over a human reply.
  const chatSnap = await chatRef.get();
  if (chatSnap.exists && chatSnap.data().mode === 'human') return;

  const reply = await runWhatsAppAgent(db, hospitalId, hospitalName, patient, userText, groqKey, history);
  const sendResult = await sendWhatsAppText(from, reply, phoneNumberId);
  await chatRef.collection('messages').add({ direction: 'out', text: reply, wamid: sendResult.id || null, read: false, at: admin.firestore.FieldValue.serverTimestamp() });
}

// Meta's read-receipt callbacks — a `statuses` array (sent/delivered/read) instead of a `messages`
// array, for messages THIS number sent out. Only `read` matters here: it flips the matching
// outbound message doc (found by the wamid Meta gave us when we sent it) so the admin's Live Chat
// can drop the "sent but not read" red dot the moment the patient actually reads it.
async function handleWhatsAppStatusUpdate(value) {
  const statuses = value && value.statuses;
  if (!Array.isArray(statuses) || !statuses.length) return;
  const db = getAdminDb();
  if (!db) return;
  const phoneNumberId = value.metadata && value.metadata.phone_number_id;
  if (!phoneNumberId) return;
  const hospitalId = await findHospitalIdByWhatsAppNumber(db, phoneNumberId);
  if (!hospitalId) return;

  for (const status of statuses) {
    if (status.status === 'failed') {
      const err = (status.errors && status.errors[0]) || {};
      console.error('WhatsApp DELIVERY FAILED to ' + status.recipient_id + ': code ' + err.code + ' — ' + (err.title || err.message || '') + (err.error_data && err.error_data.details ? ' (' + err.error_data.details + ')' : ''));
      try {
        await db.collection('hospitals/' + hospitalId + '/whatsappFailures').add({
          to: status.recipient_id || '', wamid: status.id || '', code: err.code || null, reason: err.title || err.message || '',
          details: (err.error_data && err.error_data.details) || '', at: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch(e) {}
      continue;
    }
    if (status.status !== 'read' || !status.id) continue;
    try {
      const recipient = status.recipient_id; // the phone that read it — patient, doctor, or admin's own personal number
      const patient = await findPatientByPhone(db, hospitalId, recipient);
      const doctor = !patient ? await findDoctorByWhatsAppNumber(db, hospitalId, recipient) : null;
      let chatDocId = null;
      if (patient) chatDocId = patient.patientId;
      else if (doctor) chatDocId = 'DOCTOR_' + doctor.id;
      else {
        const hospSnap = await db.collection('hospitals').doc(hospitalId).get();
        const adminNumber = hospSnap.exists && hospSnap.data().adminWhatsAppNumber;
        if (adminNumber && String(adminNumber).replace(/\D/g, '').slice(-10) === String(recipient).replace(/\D/g, '').slice(-10)) chatDocId = 'ADMIN';
      }
      if (!chatDocId) continue;
      const msgSnap = await db.collection('hospitals/' + hospitalId + '/waChats/' + chatDocId + '/messages')
        .where('wamid', '==', status.id).limit(1).get();
      if (!msgSnap.empty) await msgSnap.docs[0].ref.update({ read: true, readAt: admin.firestore.FieldValue.serverTimestamp() });
    } catch(e) { console.warn('Could not apply WhatsApp read receipt:', e.message); }
  }
}

app.post('/api/whatsapp-webhook', async (req, res) => {
  // NOT fire-and-forget: Vercel serverless functions aren't guaranteed to keep running once a
  // response is sent, so replying before the agent finishes risks the reply never actually being
  // sent at all on a slow (multi-step booking) conversation. The dedup guard inside
  // handleWhatsAppMessage (keyed on WhatsApp's own message id) is what actually stops duplicate
  // replies now, regardless of why Meta decided to redeliver.
  try {
    await handleWhatsAppMessage(req.body);
    const value = req.body && req.body.entry && req.body.entry[0] && req.body.entry[0].changes && req.body.entry[0].changes[0] && req.body.entry[0].changes[0].value;
    await handleWhatsAppStatusUpdate(value);
  }
  catch(e) { console.error('whatsapp webhook error:', e); }
  res.status(200).json({ status: 'processed' });
});

// Admin-triggered WhatsApp send — one chosen patient, or every patient in the hospital.
// Requires the caller's Firebase ID token so a random visitor can't send messages (and rack up
// WhatsApp costs) on someone else's hospital number. Note: WhatsApp only allows free-form text to
// a patient who messaged within the last 24 hours — older/first-time contacts need an
// approved message template instead, so some sends here will legitimately fail; those count
// toward `failed`, not `sent`, and the UI should say so.
app.post('/api/whatsapp-send-bulk', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet — FIREBASE_SERVICE_ACCOUNT is missing.' });
    const { idToken, hospitalId, message, patientIds } = req.body || {};
    if (!idToken || !hospitalId || !message || !String(message).trim()) {
      return res.status(400).json({ error: 'Missing idToken, hospitalId, or message.' });
    }

    let decoded;
    try { decoded = await admin.auth().verifyIdToken(idToken); }
    catch(e) { return res.status(401).json({ error: 'Session expired — please log in again.' }); }

    // The platform super-admin (Manage Hospitals) can send for ANY hospital — e.g. the
    // auto-welcome message when first linking a hospital's WhatsApp number. Every other caller
    // must be that specific hospital's own admin.
    const isSuperAdmin = decoded.email === 'bhandekarnaitik87@gmail.com';
    if (!isSuperAdmin) {
      const adminSnap = await db.collection('admins').doc(decoded.uid).get();
      if (!adminSnap.exists || adminSnap.data().hospitalId !== hospitalId) {
        return res.status(403).json({ error: 'Not authorized to send messages for this hospital.' });
      }
    }

    const hospSnap = await db.collection('hospitals').doc(hospitalId).get();
    const phoneNumberId = hospSnap.exists && hospSnap.data().whatsappPhoneNumberId;
    if (!phoneNumberId) return res.status(400).json({ error: 'This hospital has no WhatsApp number linked yet — set it in Manage Hospitals.' });

    let patients;
    if (Array.isArray(patientIds) && patientIds.length) {
      const snaps = await Promise.all(patientIds.map(pid =>
        db.collection('hospitals/' + hospitalId + '/patients').where('patientId', '==', pid).limit(1).get()
      ));
      patients = snaps.flatMap(s => s.docs).map(d => d.data());
    } else {
      const snap = await db.collection('hospitals/' + hospitalId + '/patients').get();
      patients = snap.docs.map(d => d.data());
    }
    patients = patients.filter(p => p.phone);
    // Serverless functions have a hard time limit — cap the batch so one broadcast can't run
    // past it and leave the rest of the list unsent with no record of where it stopped.
    patients = patients.slice(0, 300);

    let sentCount = 0, failedCount = 0;
    const failures = [];
    for (const p of patients) {
      const digits = String(p.phone).replace(/\D/g, '');
      const to = digits.length === 10 ? '91' + digits : digits;
      // Inside the 24h window this sends the text; outside it, WhatsApp only accepts an approved template,
      // so fall back to the generic MediFlow update template (sendWhatsAppSmart handles both).
      const r = await sendWhatsAppSmart(db, hospitalId, hospSnap.data(), to, message, phoneNumberId, { name: 'mediflow_update', params: [p.name || 'there', hospSnap.data().name || 'your hospital', message] });
      if (r.ok) sentCount++; else { failedCount++; if (failures.length < 5) failures.push({ name: p.name || '', reason: String(r.reason || r.error || 'unknown').slice(0, 200) }); }
    }
    res.json({ ok: true, sent: sentCount, failed: failedCount, total: patients.length, failures });
  } catch(e) {
    console.error('whatsapp-send-bulk error:', e);
    res.status(500).json({ error: e.message });
  }
});

// True only if `to` is actually a patient, doctor, or the linked admin number of THIS specific
// hospital — the guard that keeps hospitals' WhatsApp sends properly separate (see below).
async function recipientBelongsToHospital(db, hospitalId, to, hospData) {
  if (await findPatientByPhone(db, hospitalId, to)) return true;
  if (await findDoctorByWhatsAppNumber(db, hospitalId, to)) return true;
  const adminNumber = hospData && hospData.adminWhatsAppNumber;
  if (adminNumber && String(adminNumber).replace(/\D/g, '').slice(-10) === String(to).replace(/\D/g, '').slice(-10)) return true;
  // External pathologists (Lab Tests → routed reports) aren't patients, doctors, or the admin —
  // this used to silently 403 every "here's your report link" send to one, with nothing in the
  // app telling the admin WHY the pathologist never got it.
  try {
    const last10 = String(to).replace(/\D/g, '').slice(-10);
    const pathSnap = await db.collection('hospitals/' + hospitalId + '/pathologists').get();
    if (pathSnap.docs.some(d => String(d.data().phone || '').replace(/\D/g, '').slice(-10) === last10)) return true;
  } catch(e) {}
  return false;
}

// Keeps an in-app copy of each WhatsApp alert for the person it was sent to (patient, doctor or
// the hospital admin), stored per-recipient so one person's alert is never listed for another.
// Written whether or not the WhatsApp send itself succeeded, so the alert still reaches the app
// when WhatsApp can't deliver it.
async function mirrorWhatsAppToInApp(db, hospitalId, hospData, to, text) {
  try {
    const last10 = String(to).replace(/\D/g, '').slice(-10);
    let recipientType = null, recipientKey = null;
    const pat = await findPatientByPhone(db, hospitalId, to);
    if (pat) { recipientType = 'patient'; recipientKey = pat.docId; }
    else {
      const doc = await findDoctorByWhatsAppNumber(db, hospitalId, to);
      if (doc) { recipientType = 'doctor'; recipientKey = doc.id; }
      else if (hospData && String(hospData.adminWhatsAppNumber || '').replace(/\D/g, '').slice(-10) === last10) { recipientType = 'admin'; recipientKey = 'admin'; }
    }
    if (!recipientType) return;
    const body = String(text || '').trim();
    if (!body) return;
    await db.collection('hospitals/' + hospitalId + '/userNotifications').add({
      recipientType, recipientKey,
      title: 'MediFlow update',
      description: body.slice(0, 1000),
      source: 'whatsapp', read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch(e) { console.warn('mirrorWhatsAppToInApp failed:', e.message); }
}

// Sends ONE message to ONE patient — used by the existing prescription/bill "Send via WhatsApp"
// buttons so they go out automatically now that a real Cloud API number exists, instead of just
// opening wa.me for a manual tap. No Firebase ID token required here (unlike the bulk broadcast
// endpoint): doctors sign in via a custom Firestore password, not Firebase Auth, so they'd have no
// ID token to send. Without that per-request auth, the next best guard against hospital A's number
// ever being used to message someone (accidentally, via a bug, or a malicious request straight to
// this API) who isn't actually hospital A's own contact — which is exactly what would break the
// "each hospital's WhatsApp is completely separate" guarantee — is confirming the recipient really
// is on file for THIS specific hospital before anything goes out.
app.post('/api/whatsapp-send-single', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    const { hospitalId, to, message, template, kind } = req.body || {};
    if (!hospitalId || !to || !message) return res.status(400).json({ error: 'Missing hospitalId, to, or message.' });
    const hospSnap = await db.collection('hospitals').doc(hospitalId).get();
    if (!hospSnap.exists) return res.status(404).json({ error: 'Hospital not found.' });
    const hospData = hospSnap.data();
    // A hospital with no WhatsApp number can still get SMS, so this is only an error when
    // neither channel is available.
    if (!hospData.whatsappPhoneNumberId && !(await smsReady())) return res.status(400).json({ error: 'No WhatsApp number linked for this hospital.' });
    if (!(await recipientBelongsToHospital(db, hospitalId, to, hospData))) {
      return res.status(403).json({ error: 'This number is not on file for this hospital — refusing to send.' });
    }
    const r = await deliverNotice(db, hospitalId, hospData, to, message, kind, template);
    await mirrorWhatsAppToInApp(db, hospitalId, hospData, to, message);
    res.json({ ok: true, sent: r.sent, sms: r.sms, whatsapp: r.whatsapp, kind: r.kind, via: r.via, error: r.sent ? undefined : r.error });
  } catch(e) {
    console.error('whatsapp-send-single error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Same guard rails as whatsapp-send-single, for an image message — used to send a patient their
// order QR code/barcode when the medical store accepts their medicine order.
app.post('/api/whatsapp-send-image', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    const { hospitalId, to, imageUrl, caption, template } = req.body || {};
    if (!hospitalId || !to || !imageUrl) return res.status(400).json({ error: 'Missing hospitalId, to, or imageUrl.' });
    const hospSnap = await db.collection('hospitals').doc(hospitalId).get();
    if (!hospSnap.exists) return res.status(404).json({ error: 'Hospital not found.' });
    const hospData = hospSnap.data();
    const phoneNumberId = hospData.whatsappPhoneNumberId;
    if (!phoneNumberId && !(await smsReady())) return res.status(400).json({ error: 'No WhatsApp number linked for this hospital.' });
    if (!(await recipientBelongsToHospital(db, hospitalId, to, hospData))) {
      return res.status(403).json({ error: 'This number is not on file for this hospital — refusing to send.' });
    }
    const text = caption || 'Your order has been received.';
    let waOk = null, smsOk = null;
    if (phoneNumberId) {
      // Images can't go out of window either — then just send the caption (it carries the order code).
      const inWindow = await hasOpenWhatsAppWindow(db, hospitalId, to, hospData);
      const r = inWindow ? await sendWhatsAppImage(to, imageUrl, caption, phoneNumberId) : await sendWhatsAppSmart(db, hospitalId, hospData, to, text, phoneNumberId, template);
      waOk = r.ok;
    }
    // The order code has to reach the patient even if WhatsApp can't, so the text goes by SMS too.
    if ((await smsReady())) smsOk = (await sendSms(to, smsSafeText(text) + (hospData.name ? '\n- ' + hospData.name : ''))).ok;
    await mirrorWhatsAppToInApp(db, hospitalId, hospData, to, text);
    res.json({ ok: true, sent: !!(waOk || smsOk), whatsapp: waOk, sms: smsOk });
  } catch(e) {
    console.error('whatsapp-send-image error:', e);
    res.status(500).json({ error: e.message });
  }
});

// AI-drafts a WhatsApp message body for the admin to review/edit before sending — never sends
// anything itself, just returns text for the compose box.
app.post('/api/whatsapp-draft-message', async (req, res) => {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'AI drafting is not configured yet. Ask the platform admin to add a GROQ_API_KEY.' });
    const { hospitalName, patientName, topic, extra } = req.body || {};
    if (!topic || !String(topic).trim()) return res.status(400).json({ error: 'Choose or type a topic first.' });

    const systemPrompt = 'You write short, warm WhatsApp messages on behalf of a hospital to its patients. Keep it under 5 lines, friendly and professional. Never give medical advice, diagnosis, or medication instructions. Output ONLY the message text itself — no quotes, no preamble, no explanation.';
    const userMsg = 'Hospital name: ' + (hospitalName || 'the hospital') +
      (patientName ? ('\nPatient name: ' + patientName + ' (address them by name)') : '\n(No specific patient — this goes to many patients at once, so keep it general and do not address anyone by name.)') +
      '\nTopic: ' + topic + (extra ? ('\nAdditional detail to include: ' + extra) : '');

    const aiResp = await callGroq(apiKey, {
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
      temperature: 0.5, max_tokens: 1024
    });
    if (!aiResp.ok) { console.error('Groq draft error:', aiResp.status, await aiResp.text()); return res.status(502).json({ error: 'AI service error. Try again later.' }); }
    const data = await aiResp.json();
    const text = extractGroqText(data).trim();
    res.json({ message: text || 'Could not generate a message — please write one manually.' });
  } catch(e) {
    console.error('whatsapp-draft-message error:', e);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// ============ RAZORPAY — AUTOMATIC UPI PAYMENT CONFIRMATION ============
// Each hospital connects its OWN Razorpay account (their money goes straight to their own bank
// account, never pooled through a MediFlow-owned account) — the keys live on that hospital's own
// Firestore doc (`razorpayKeyId`/`razorpayKeySecret`, set from Settings), read here via the
// Admin SDK so the secret key never reaches the browser. This replaces the old "patient
// self-reports paid, admin manually confirms" flow with a real, gateway-verified confirmation.
const crypto = require('crypto');

// Creates a single-use UPI QR code for one bill. The bill doc must already exist (created by the
// caller before showing the QR) — this only returns an image URL for display; Razorpay tells us
// it's paid via the webhook below, not via this response.
app.post('/api/razorpay-create-qr', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    const { hospitalId, billId, amount, note } = req.body || {};
    if (!hospitalId || !billId || !amount) return res.status(400).json({ error: 'Missing hospitalId, billId, or amount.' });

    const hospSnap = await db.collection('hospitals').doc(hospitalId).get();
    const h = hospSnap.exists ? hospSnap.data() : {};
    if (!h.razorpayKeyId || !h.razorpayKeySecret) return res.status(400).json({ error: 'no_razorpay' });

    const auth64 = Buffer.from(h.razorpayKeyId + ':' + h.razorpayKeySecret).toString('base64');
    const rpResp = await fetch('https://api.razorpay.com/v1/payments/qr_codes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Authorization': 'Basic ' + auth64 },
      body: JSON.stringify({
        type: 'upi_qr',
        name: (h.name || 'Hospital').slice(0, 30),
        usage: 'single_use',
        fixed_amount: true,
        payment_amount: Math.round(Number(amount) * 100),
        description: (note || 'Payment').slice(0, 40),
        notes: { hospitalId, billId }
      })
    });
    const data = await rpResp.json();
    if (!rpResp.ok) { console.error('Razorpay QR create error:', rpResp.status, JSON.stringify(data)); return res.status(502).json({ error: data.error?.description || 'Could not create QR code.' }); }
    res.json({ ok: true, qrImageUrl: data.image_url, qrCodeId: data.id });
  } catch(e) {
    console.error('razorpay-create-qr error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Razorpay's webhook — since each hospital has its own Razorpay account (own webhook secret), we
// read the (unverified) hospitalId out of the payload first to look up which secret to check the
// signature against, then verify before trusting anything else in it.
app.post('/api/razorpay-webhook', async (req, res) => {
  // Always 200 quickly — Razorpay retries aggressively on non-2xx, and we don't want a bug on
  // our end to trigger a retry storm against their servers.
  res.status(200).json({ ok: true });
  try {
    const db = getAdminDb();
    if (!db) return;
    const payload = req.body || {};
    const entity = payload.payload?.qr_code?.entity || payload.payload?.payment?.entity;
    const hospitalId = entity?.notes?.hospitalId;
    const billId = entity?.notes?.billId;
    if (!hospitalId || !billId) { console.warn('Razorpay webhook missing hospitalId/billId in notes'); return; }

    const hospSnap = await db.collection('hospitals').doc(hospitalId).get();
    const secret = hospSnap.exists && hospSnap.data().razorpayWebhookSecret;
    if (!secret) { console.warn('No razorpayWebhookSecret set for hospital', hospitalId); return; }

    const signature = req.headers['x-razorpay-signature'];
    const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
    if (signature !== expected) { console.error('Razorpay webhook signature mismatch for hospital', hospitalId); return; }

    if (payload.event === 'qr_code.credited' || payload.event === 'payment.captured') {
      const amountPaid = (entity.payment_amount || entity.amount || 0) / 100;
      await db.collection('hospitals/' + hospitalId + '/bills').doc(billId).set({
        paid: true, paymentMethod: 'upi', confirmedBy: 'razorpay-auto',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        patientClaimedPaid: false
      }, { merge: true });
      console.log('Razorpay auto-confirmed bill', billId, 'for hospital', hospitalId, '₹' + amountPaid);
    }
  } catch(e) {
    console.error('razorpay-webhook error:', e);
  }
});

// Read-only, no secrets in the response — just whether the WhatsApp Cloud API token this whole
// integration depends on is actually still valid right now. Meta's short-lived test tokens
// (the ones handed out by default in the App Dashboard, as opposed to a permanent System User
// token) expire after 24 hours, which silently breaks every WhatsApp send/reply with no obvious
// symptom in this app's own logs beyond "the message never arrived" — exactly the kind of bug
// that's invisible to code review and only shows up by actually asking Meta.
// Super-admin pastes a fresh token here after Meta's short-lived one expires — validated against
// Meta itself (so a typo or already-dead token is rejected immediately, not silently stored) and
// its REAL expiry read back from debug_token rather than trusted from the caller.
// Each token's own countdown starts the moment META generates it, not when it's pasted here or
// activated — so queuing several tokens generated all at once doesn't stretch coverage, they'd
// all die around the same time. What this DOES support: paste a token whenever you have a spare
// minute (generate a fresh one every ~70-80min and add it) and the queue absorbs it — if there's
// already a live token, the new one waits in line instead of overwriting it; the maintenance poll
// below promotes the next queued token automatically the moment the active one is about to die.

// WhatsApp tokens are valid from the moment Meta creates them until their own expiry — they do NOT
// start counting when pasted here. So the best one to use at any moment is simply the one that lasts
// longest; every other still-valid token is kept as a backup. Pasting an older (earlier-expiring)
// token therefore never "fails" — it just doesn't add time.
const WA_EXP = t => (t.neverExpires ? Infinity : (t.expiresAt || 0));
function planWaTokens(d, extra) {
  const now = Date.now();
  const seen = new Set(), all = [];
  const add = t => { if (t && t.token && !seen.has(t.token)) { seen.add(t.token); all.push(t); } };
  if (d.accessToken) add({ token: d.accessToken, expiresAt: d.expiresAt || null, neverExpires: !!d.neverExpires, expiryEstimated: !!d.expiryEstimated, addedAt: d.addedAt || null });
  (Array.isArray(d.tokenQueue) ? d.tokenQueue : []).forEach(q => add({ token: q.token, expiresAt: q.expiresAt || null, neverExpires: !!q.neverExpires, expiryEstimated: !!q.expiryEstimated, addedAt: q.addedAt || null }));
  if (extra) add(extra);
  const live = all.filter(t => WA_EXP(t) > now).sort((a, b) => WA_EXP(b) - WA_EXP(a));
  return { active: live[0] || null, backups: live.slice(1), total: all.length };
}
function waPlanPatch(plan) {
  return { accessToken: plan.active.token, expiresAt: plan.active.expiresAt, neverExpires: !!plan.active.neverExpires, expiryEstimated: !!plan.active.expiryEstimated,
    tokenQueue: plan.backups.map(t => ({ token: t.token, expiresAt: t.expiresAt, neverExpires: !!t.neverExpires, expiryEstimated: !!t.expiryEstimated, addedAt: t.addedAt || Date.now() })) };
}
// Meta's own words for why a token was refused, so the owner sees the real reason.
function metaTokenError(data, fallback) {
  const e = data && (data.error || (data.data && data.data.error));
  const msg = e && (e.message || e.error_user_msg);
  return msg ? String(msg).replace(/Error validating access token:?\s*/i, '') : fallback;
}

app.post('/api/whatsapp-set-token', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    const { idToken, accessToken, warningPhone, warningFromPhoneNumberId } = req.body || {};
    if (!idToken || !accessToken) return res.status(400).json({ error: 'Paste a token first.' });
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(idToken); }
    catch(e) { return res.status(401).json({ error: 'Session expired — please log in again.' }); }
    if (decoded.email !== PLATFORM_SUPER_ADMIN_EMAIL) return res.status(403).json({ error: 'Only the platform owner can update the WhatsApp API token.' });

    // Pasted tokens often carry quotes, a "Bearer " prefix, spaces or a line break — none belong in the token.
    const token = String(accessToken).replace(/^\s*(?:Bearer\s+)?/i, '').replace(/["'\s]/g, '');
    if (token.length < 40) return res.status(400).json({ error: 'That does not look like a full token — it is far too short. Copy the whole token from Meta.' });

    let expiresAtMs = null, neverExpires = false, estimated = false;
    try {
      const dbgResp = await fetch('https://graph.facebook.com/v21.0/debug_token?input_token=' + encodeURIComponent(token) + '&access_token=' + encodeURIComponent(token));
      const dbgData = await dbgResp.json().catch(() => ({}));
      if (dbgResp.ok && dbgData.data) {
        if (dbgData.data.is_valid === false) return res.status(400).json({ error: 'Meta says this token is not valid: ' + metaTokenError(dbgData.data, 'it has expired or was revoked') + '.' });
        const sec = dbgData.data.expires_at || 0; // 0 = never expires (a real System User token)
        neverExpires = !sec; expiresAtMs = sec ? sec * 1000 : null;
      } else {
        // debug_token itself can refuse some tokens — fall back to simply asking Meta whether the token works.
        const me = await fetch('https://graph.facebook.com/v21.0/me?access_token=' + encodeURIComponent(token));
        const meData = await me.json().catch(() => ({}));
        if (!me.ok) return res.status(400).json({ error: 'Meta rejected this token: ' + metaTokenError(meData, 'it could not be verified') + '.' });
        expiresAtMs = Date.now() + 55 * 60 * 1000; estimated = true;   // works, but Meta did not report an expiry — assume about an hour
      }
    } catch (e) { return res.status(502).json({ error: 'Could not reach Meta to check the token (' + e.message + '). Please try again.' }); }
    if (!neverExpires && expiresAtMs <= Date.now()) return res.status(400).json({ error: 'This token has already expired — generate a fresh one in Meta.' });

    const ref = db.collection('platformConfig').doc('whatsapp');
    const snap = await ref.get();
    const cur = snap.exists ? snap.data() : {};
    const before = planWaTokens(cur);
    if (before.active && before.active.token === token || before.backups.some(t => t.token === token)) {
      return res.json({ ok: true, duplicate: true, activated: before.active.token === token, note: 'That token was already added.' });
    }
    const newTok = { token, expiresAt: expiresAtMs, neverExpires, expiryEstimated: estimated, addedAt: Date.now() };
    const plan = planWaTokens(cur, newTok);
    const activated = plan.active.token === token;
    const patch = Object.assign(waPlanPatch(plan), {
      warningPhone: warningPhone !== undefined ? (warningPhone ? String(warningPhone).trim() : null) : (cur.warningPhone || null),
      warningFromPhoneNumberId: warningFromPhoneNumberId !== undefined ? (warningFromPhoneNumberId ? String(warningFromPhoneNumberId).trim() : null) : (cur.warningFromPhoneNumberId || null),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: decoded.email
    });
    if (activated) patch.warnedForExpiresAt = null;
    await ref.set(patch, { merge: true });
    _waTokenCache = { token: plan.active.token, at: Date.now() };
    res.json({ ok: true, activated, backup: !activated, expiresAt: expiresAtMs, neverExpires, estimated, backups: plan.backups.length,
      coverageUntil: plan.active.neverExpires ? null : plan.active.expiresAt });
  } catch(e) {
    console.error('whatsapp-set-token error:', e);
    res.status(500).json({ error: e.message });
  }
});

// SMS health for the owner's Settings card: which providers have a key, and whether each one works.
// Nothing secret is returned.
app.get('/api/sms-status', async (req, res) => {
  const k = await loadSmsKeys();
  const out = { configured: !!(k.f2s || k.tb), fast2sms: { configured: !!k.f2s }, textbee: { configured: !!k.tb } };
  if (k.f2s) {
    try {
      const r = await fetch('https://www.fast2sms.com/dev/wallet', { headers: { authorization: k.f2s } });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.return !== false) { out.fast2sms.keyValid = true; if (d.wallet !== undefined) out.fast2sms.balance = d.wallet; }
      else { out.fast2sms.keyValid = false; out.fast2sms.error = smsErrText(d, r.status); }
    } catch (e) { out.fast2sms.error = e.message; }
  }
  if (k.tb) {
    try {
      const r = await fetch('https://api.textbee.dev/api/v1/gateway/devices', { headers: { 'x-api-key': k.tb } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { out.textbee.keyValid = false; out.textbee.error = smsErrText(d, r.status); }
      else { const devs = Array.isArray(d.data) ? d.data : []; out.textbee.keyValid = true; out.textbee.devices = devs.length; }
    } catch (e) { out.textbee.error = e.message; }
  }
  res.json(out);
});
app.post('/api/sms-test', async (req, res) => {
  try {
    const { idToken, to } = req.body || {};
    if (!idToken || !to) return res.status(400).json({ error: 'Missing idToken or phone number.' });
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(idToken); }
    catch(e) { return res.status(401).json({ error: 'Session expired — please log in again.' }); }
    if (decoded.email !== PLATFORM_SUPER_ADMIN_EMAIL) return res.status(403).json({ error: 'Only the platform owner can send a test SMS.' });
    const r = await sendSms(to, 'MediFlow test SMS - if you can read this, SMS sending works.');
    res.json({ ok: r.ok, provider: r.provider, error: r.ok ? undefined : r.error });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Owner pastes an SMS provider key in Settings; it is stored server-side (never sent back to any browser).
app.post('/api/sms-set-key', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    const { idToken, provider, apiKey } = req.body || {};
    if (!idToken || !['fast2sms', 'textbee'].includes(provider)) return res.status(400).json({ error: 'Missing details.' });
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(idToken); }
    catch(e) { return res.status(401).json({ error: 'Session expired — please log in again.' }); }
    if (decoded.email !== PLATFORM_SUPER_ADMIN_EMAIL) return res.status(403).json({ error: 'Only the platform owner can change SMS keys.' });
    const key = String(apiKey || '').replace(/["'\s]/g, '');
    const field = provider === 'fast2sms' ? 'fast2smsKey' : 'textbeeKey';
    if (!key) { await db.collection('platformConfig').doc('sms').set({ [field]: admin.firestore.FieldValue.delete() }, { merge: true }); _smsKeyCache.at = 0; return res.json({ ok: true, removed: true }); }
    if (provider === 'fast2sms') {
      const r = await fetch('https://www.fast2sms.com/dev/wallet', { headers: { authorization: key } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.return === false) return res.status(400).json({ error: 'Fast2SMS did not accept this key: ' + smsErrText(d, r.status) });
    }
    await db.collection('platformConfig').doc('sms').set({ [field]: key, updatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedBy: decoded.email }, { merge: true });
    _smsKeyCache.at = 0;
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Read-only status for the Settings page's countdown — no auth needed, nothing secret in the response.
// Also self-heals: expired tokens are dropped, and the longest-lasting valid token always becomes active.
app.get('/api/whatsapp-token-status', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.json({ configured: false });
    const snap = await db.collection('platformConfig').doc('whatsapp').get();
    if (!snap.exists || !snap.data().accessToken) return res.json({ configured: !!process.env.WA_ACCESS_TOKEN, source: process.env.WA_ACCESS_TOKEN ? 'env' : null });
    const d = snap.data();
    const plan = planWaTokens(d);
    if (plan.active) {
      const needsSave = plan.active.token !== d.accessToken || plan.backups.length !== (Array.isArray(d.tokenQueue) ? d.tokenQueue.length : 0);
      if (needsSave) { await snap.ref.update(Object.assign(waPlanPatch(plan), plan.active.token !== d.accessToken ? { warnedForExpiresAt: null } : {})); _waTokenCache = { token: plan.active.token, at: Date.now() }; }
    }
    const act = plan.active || { expiresAt: d.expiresAt || null, neverExpires: !!d.neverExpires, expiryEstimated: !!d.expiryEstimated };
    const schedule = [{ role: 'active', expiresAt: act.neverExpires ? null : act.expiresAt, neverExpires: !!act.neverExpires, estimated: !!act.expiryEstimated }]
      .concat(plan.backups.map(t => ({ role: 'backup', expiresAt: t.neverExpires ? null : t.expiresAt, neverExpires: !!t.neverExpires, estimated: !!t.expiryEstimated })));
    res.json({
      configured: true, source: 'firestore', expiresAt: act.neverExpires ? null : (act.expiresAt || null), neverExpires: !!act.neverExpires,
      updatedAt: d.updatedAt ? d.updatedAt.toMillis() : null, updatedBy: d.updatedBy || null,
      warningPhone: d.warningPhone || null, warningFromPhoneNumberId: d.warningFromPhoneNumberId || null,
      queueLength: plan.backups.length, schedule, totalCoverageUntil: act.neverExpires ? null : (act.expiresAt || null)
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Polled by the Settings page (while a super-admin has it open) roughly once a minute — Hobby-tier
// Vercel cron only runs daily, far too coarse for a token that can live as little as ~1 hour, so
// this piggybacks on the admin's own open tab instead. Two jobs: (1) once the active token is
// within a minute of dying (or already dead), promote the next queued token — silent when that
// succeeds, since nothing actually broke; (2) only if the queue is ALSO empty at that point does
// this send the urgent "add more tokens" warning, on WhatsApp and back to the polling tab.
// `warnedForExpiresAt` stops the same warning repeating every poll for the same dying token.
app.post('/api/whatsapp-check-expiry-warning', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.json({ warned: false });
    const ref = db.collection('platformConfig').doc('whatsapp');
    const snap = await ref.get();
    if (!snap.exists) return res.json({ warned: false });
    let d = snap.data();
    if (!d.accessToken) return res.json({ warned: false });

    // Always run on the longest-lasting valid token; if the stored active one is no longer the best
    // (it expired, or a later-expiring backup exists), switch to the best one.
    const plan = planWaTokens(d);
    let switched = false;
    if (plan.active && plan.active.token !== d.accessToken) {
      await ref.update(Object.assign(waPlanPatch(plan), { warnedForExpiresAt: null }));
      _waTokenCache = { token: plan.active.token, at: Date.now() };
      d = Object.assign({}, d, waPlanPatch(plan), { warnedForExpiresAt: null });
      switched = true;
    }
    if (d.neverExpires || !d.expiresAt) return res.json({ warned: false, switched });

    const stillDying = (d.expiresAt - Date.now()) <= 5 * 60 * 1000;
    const hasBackup = plan.backups.length > 0;
    if (!stillDying || hasBackup) return res.json({ warned: false, switched, queueLength: plan.backups.length });
    if (d.warnedForExpiresAt === d.expiresAt) return res.json({ warned: false, alreadyWarned: true, switched, msLeft: d.expiresAt - Date.now() });

    const msLeftNow = d.expiresAt - Date.now();
    const minsLeft = Math.max(0, Math.round(msLeftNow / 60000));
    const text = msLeftNow <= 0
      ? '🔴 MediFlow WhatsApp token has expired and there is no backup — WhatsApp sending is down. Paste a fresh token in Admin Settings.'
      : '⚠️ MediFlow WhatsApp token expires in about ' + minsLeft + ' minute' + (minsLeft === 1 ? '' : 's') + ' and there is no later token. Generate a fresh one in Meta and paste it in Admin Settings → WhatsApp API Token.';
    let sent = false;
    if (d.warningPhone && d.warningFromPhoneNumberId) {
      const r = await sendWhatsAppText(d.warningPhone, text, d.warningFromPhoneNumberId);
      sent = r.ok;
    }
    await ref.update({ warnedForExpiresAt: d.expiresAt });
    res.json({ warned: true, sentOnWhatsApp: sent, msLeft: msLeftNow, message: text, switched });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/whatsapp-diagnostics', async (req, res) => {
  const token = await getWaAccessToken();
  if (!token) return res.json({ tokenConfigured: false, note: 'WA_ACCESS_TOKEN is not set.' });
  try {
    const resp = await fetch('https://graph.facebook.com/v21.0/me?access_token=' + encodeURIComponent(token));
    const data = await resp.json();
    if (!resp.ok) {
      return res.json({
        tokenConfigured: true, tokenValid: false,
        errorCode: data.error && data.error.code, errorType: data.error && data.error.type,
        errorMessage: data.error && data.error.message,
        note: (data.error && data.error.code === 190) ? 'This token is invalid or expired — WhatsApp sends will fail until a fresh (ideally permanent System User) token is set.' : 'Meta rejected this token.'
      });
    }
    // Token is valid — also list the phone numbers actually reachable with it, since "token
    // works" and "a specific hospital's phoneNumberId can actually send" are two different
    // failure points. If a hospital's whatsappPhoneNumberId (set in Manage Hospitals) isn't in
    // this list, sends for that hospital will fail even though the token itself is fine.
    // /me is a system user or app node here (not a WhatsApp Business Account, which has no
    // /phone_numbers edge on itself as confirmed by testing) — debug_token instead reveals what
    // this token can actually act on: which WABA/phone-number IDs it's been granted, via
    // granular_scopes. That's the real answer to "can this token send for hospital X's number".
    let tokenScopes = null, tokenScopesError = null;
    try {
      const dbgResp = await fetch('https://graph.facebook.com/v21.0/debug_token?input_token=' + encodeURIComponent(token) + '&access_token=' + encodeURIComponent(token));
      const dbgData = await dbgResp.json();
      if (dbgResp.ok && dbgData.data) {
        tokenScopes = {
          appId: dbgData.data.app_id, type: dbgData.data.type,
          isValid: dbgData.data.is_valid, expiresAt: dbgData.data.expires_at,
          scopes: dbgData.data.scopes,
          granularScopes: (dbgData.data.granular_scopes || []).map(g => ({ scope: g.scope, targetIds: g.target_ids }))
        };
      } else tokenScopesError = dbgData.error || dbgData;
    } catch(e) { tokenScopesError = { message: e.message }; }
    res.json({ tokenConfigured: true, tokenValid: true, meId: data.id, meName: data.name || null, tokenScopes, tokenScopesError });
  } catch(e) {
    res.json({ tokenConfigured: true, tokenValid: null, note: 'Could not reach Meta to check: ' + e.message });
  }
});

// debug_token's granular_scopes not showing target_ids turned out to be an unreliable signal
// (still empty even on a freshly generated token) — so this instead attempts a REAL send against
// a real phoneNumberId + recipient and hands back Meta's raw response (not the app's own
// sendWhatsAppText, which swallows the error detail into a log line) — the only ground-truth
// answer to "does sending actually work right now", and exactly which error Meta gives if not.
app.get('/api/whatsapp-test-send', async (req, res) => {
  const { phoneNumberId, to } = req.query || {};
  if (!phoneNumberId || !to) return res.status(400).json({ error: 'Pass ?phoneNumberId=...&to=... in the URL.' });
  const token = await getWaAccessToken();
  if (!token) return res.json({ ok: false, note: 'WA_ACCESS_TOKEN not set.' });
  try {
    const resp = await fetch('https://graph.facebook.com/v21.0/' + phoneNumberId + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: String(to), type: 'text', text: { body: '✅ MediFlow WhatsApp test message — if you received this, sending is working.' } })
    });
    const data = await resp.json().catch(() => ({}));
    res.json({ ok: resp.ok, httpStatus: resp.status, response: data });
  } catch(e) {
    res.json({ ok: false, note: 'Request failed: ' + e.message });
  }
});

// ============ SOFTWARE UPDATES (version pinning) ============
// Most hospitals run whatever's live, automatically, same as always. A hospital on the plan
// without future updates instead gets pinned to a specific version (see hospitals/{id}.
// pinnedVersion) and pulls newer ones manually from their own Software Updates page. Since
// Firestore documents cap out around 1MiB and this whole file is well over that, each published
// version is split into chunk documents under platformVersions/{version}/chunks/{i} rather than
// stored as one field — the client reassembles them in order.
const PLATFORM_SUPER_ADMIN_EMAIL = 'bhandekarnaitik87@gmail.com';
const VERSION_CHUNK_CHARS = 850000; // comfortably under Firestore's ~1MiB per-document limit

app.post('/api/publish-platform-version', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet — FIREBASE_SERVICE_ACCOUNT is missing.' });
    const { idToken, changelog } = req.body || {};

    // No in-app "Publish" button anymore — publishing a version, with its own written changelog,
    // is something only the platform owner does directly (via this API, same as the daily cron
    // sweep authenticates), not a UI control any logged-in admin session could stumble into.
    const cronSecret = process.env.CRON_SECRET;
    const authedByCronSecret = cronSecret && req.headers.authorization === 'Bearer ' + cronSecret;
    if (!authedByCronSecret) {
      if (!idToken) return res.status(400).json({ error: 'Missing idToken.' });
      let decoded;
      try { decoded = await admin.auth().verifyIdToken(idToken); }
      catch(e) { console.error('publish-platform-version: idToken verification failed:', e.message); return res.status(401).json({ error: 'Session expired — please log in again.' }); }
      if (decoded.email !== PLATFORM_SUPER_ADMIN_EMAIL) return res.status(403).json({ error: 'Only the platform owner can publish a version.' });
    }

    // Reads the exact file this same server is serving live right now — never a stale or
    // hand-edited copy, always a true snapshot of what's actually deployed.
    let content;
    try { content = fs.readFileSync(indexFile, 'utf8'); }
    catch(e) { console.error('publish-platform-version: could not read index.html from disk:', e.message); return res.status(500).json({ error: 'Could not read the current app file on the server: ' + e.message }); }

    const latestSnap = await db.collection('platformVersions').doc('latest').get();
    const newVersion = (latestSnap.exists ? (latestSnap.data().version || 0) : 0) + 1;

    const chunks = [];
    for (let i = 0; i < content.length; i += VERSION_CHUNK_CHARS) chunks.push(content.slice(i, i + VERSION_CHUNK_CHARS));

    const versionRef = db.collection('platformVersions').doc(String(newVersion));
    const BATCH_SIZE = 20;
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = db.batch();
      for (let j = i; j < Math.min(i + BATCH_SIZE, chunks.length); j++) {
        batch.set(versionRef.collection('chunks').doc(String(j)), { index: j, data: chunks[j] });
      }
      await batch.commit();
    }

    const meta = { version: newVersion, totalChunks: chunks.length, sizeBytes: content.length, changelog: changelog || '', publishedAt: admin.firestore.FieldValue.serverTimestamp() };
    await versionRef.set(meta);
    await db.collection('platformVersions').doc('latest').set(meta);

    // Best-effort broadcast to every hospital — in-app (the same banner mechanism Manage
    // Hospitals' own "Message Hospital" already uses successfully) and, where an admin has linked
    // their own WhatsApp number, a WhatsApp text too. A failure here never fails the publish
    // itself — the version is already live and pullable either way.
    notifyAllHospitalsOfNewVersion(db, newVersion, changelog).catch(e => console.warn('Version-notify broadcast failed:', e.message));

    res.json({ ok: true, version: newVersion, totalChunks: chunks.length });
  } catch(e) {
    console.error('publish-platform-version error:', e);
    res.status(500).json({ error: e.message });
  }
});

async function notifyAllHospitalsOfNewVersion(db, version, changelog) {
  const title = '🚀 New MediFlow Update — v' + version;
  const body = (changelog && changelog.trim()) ? changelog.trim() : 'A new version of MediFlow is available.';
  const hospSnap = await db.collection('hospitals').get();
  for (const doc of hospSnap.docs) {
    const h = doc.data();
    const payload = { toHospitalId: doc.id, title, body, fromMediFlow: true, from: 'MediFlow Admin', read: false, createdAt: admin.firestore.FieldValue.serverTimestamp() };
    try { await db.collection('hospitals/' + doc.id + '/hospitalMessages').add(payload); } catch(e) {}
    try { await db.collection('hospitalMessages').add(payload); } catch(e) {}
    if (h.adminWhatsAppNumber && h.whatsappPhoneNumberId) {
      try { await sendWhatsAppText(h.adminWhatsAppNumber, title + '\n\n' + body, h.whatsappPhoneNumberId); } catch(e) {}
    }
  }
}

// ============ PASSWORD RESET BY CODE (patients & doctors) ============
// The code is made, checked and stored on the server only (as a hash, 10-minute life, 5 tries). It goes to the phone on
// file by SMS first, WhatsApp as backup. The new password is hashed on the server; the browser never writes passwords.
const RESET_TTL = 10 * 60 * 1000;
const resetKey = (role, id) => crypto.createHash('sha256').update('reset|' + role + '|' + String(id).toUpperCase()).digest('hex');
const resetCodeHash = (key, code) => crypto.createHash('sha256').update(key + ':' + code + ':' + (process.env.CRON_SECRET || 'mf')).digest('hex');
async function findResetAccount(db, role, id) {
  const code = String(id || '').trim().toUpperCase();
  if (!code) return null;
  const dirCol = role === 'doctor' ? 'doctorDirectory' : 'patientDirectory';
  const subCol = role === 'doctor' ? 'doctors' : 'patients';
  const idField = role === 'doctor' ? 'doctorId' : 'patientId';
  let hid = null;
  const dir = await db.collection(dirCol).doc(code).get();
  if (dir.exists) hid = String(dir.data().hospitalId || '').trim();
  const tryHosp = async h => {
    const s = await db.collection('hospitals/' + h + '/' + subCol).where(idField, '==', code).limit(1).get();
    return s.empty ? null : { hospitalId: h, docId: s.docs[0].id, data: s.docs[0].data() };
  };
  if (hid) { const r = await tryHosp(hid); if (r) return r; }
  return null;
}
app.post('/api/reset-request', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    const role = (req.body || {}).role === 'doctor' ? 'doctor' : 'patient';
    const id = String((req.body || {}).identifier || '').trim();
    // Always the same answer, so nobody can tell which IDs exist.
    const generic = { ok: true, message: 'If an account with that ID has a phone number on file, a code has been sent to it.' };
    if (!id) return res.status(400).json({ error: 'Enter your ID.' });
    const acct = await findResetAccount(db, role, id);
    if (!acct) return res.json(generic);
    const phone = String(acct.data.phone || acct.data.whatsappNumber || '').replace(/\D/g, '').slice(-10);
    if (phone.length !== 10) return res.json(generic);
    const key = resetKey(role, id);
    const ref = db.collection('passwordResets').doc(key);
    const prev = await ref.get();
    if (prev.exists && Date.now() - (prev.data().sentAt || 0) < 60000) return res.status(429).json({ error: 'Please wait a minute before asking for another code.' });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await ref.set({ hash: resetCodeHash(key, code), sentAt: Date.now(), expiresAt: Date.now() + RESET_TTL, tries: 0, role, hospitalId: acct.hospitalId, docId: acct.docId });
    const sent = await deliverNotice(db, acct.hospitalId, { name: acct.data.hospitalName || '' }, '91' + phone, 'Your MediFlow password reset code is ' + code + '. It is valid for 10 minutes. If you did not ask for this, ignore this message.', 'otp', null);
    if (!sent.sent) return res.json(generic);
    res.json({ ok: true, message: 'A 6-digit code was sent to the phone ending ' + phone.slice(-4) + '.', sentTo: '******' + phone.slice(-4) });
  } catch (e) { console.error('reset-request error:', e); res.status(500).json({ error: 'Something went wrong. Try again.' }); }
});
app.post('/api/reset-confirm', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    const b = req.body || {};
    const role = b.role === 'doctor' ? 'doctor' : 'patient';
    const id = String(b.identifier || '').trim();
    const code = String(b.code || '').replace(/\D/g, '');
    const newPassword = String(b.newPassword || '');
    if (!id || code.length !== 6) return res.status(400).json({ error: 'Enter the 6-digit code.' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'The new password must be at least 6 characters.' });
    const key = resetKey(role, id);
    const ref = db.collection('passwordResets').doc(key);
    const snap = await ref.get();
    if (!snap.exists) return res.status(400).json({ error: 'Ask for a new code.' });
    const d = snap.data();
    if (Date.now() > d.expiresAt) { await ref.delete(); return res.status(400).json({ error: 'That code has expired. Ask for a new one.' }); }
    if ((d.tries || 0) >= 5) { await ref.delete(); return res.status(429).json({ error: 'Too many wrong tries. Ask for a new code.' }); }
    if (resetCodeHash(key, code) !== d.hash) { await ref.update({ tries: (d.tries || 0) + 1 }); return res.status(400).json({ error: 'Wrong code.' }); }
    // Hash the new password the same way the app's login checks it (pbkdf2, 150k rounds).
    const salt = crypto.randomBytes(16);
    const hash = crypto.pbkdf2Sync(newPassword, salt, 150000, 32, 'sha256');
    const stored = 'pbkdf2$150000$' + salt.toString('base64') + '$' + hash.toString('base64');
    const field = role === 'doctor' ? 'loginPassword' : 'password';
    await db.collection('hospitals/' + d.hospitalId + '/' + (role === 'doctor' ? 'doctors' : 'patients')).doc(d.docId).update({ [field]: stored });
    await ref.delete();
    res.json({ ok: true });
  } catch (e) { console.error('reset-confirm error:', e); res.status(500).json({ error: 'Something went wrong. Try again.' }); }
});

// ============ DEVICE WI-FI SETUP (ESP32 scanner) ============
// Each device is registered once by a hospital admin and gets its own secret token (shown once; only a hash is stored).
// The device polls /api/device/poll over HTTPS, reports the Wi-Fi networks it can see, and applies the Wi-Fi the
// admin chose. The chosen password is kept only until the device confirms it has saved it, then deleted.
const devHash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
async function devAdmin(req, res, hospitalId) {
  const { idToken } = req.body || {};
  if (!idToken) { res.status(400).json({ error: 'Missing idToken.' }); return null; }
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch (e) { res.status(401).json({ error: 'Session expired — please log in again.' }); return null; }
  const db = getAdminDb();
  const a = await db.collection('admins').doc(decoded.uid).get();
  if (!a.exists || String(a.data().hospitalId || '').trim() !== String(hospitalId || '').trim()) { res.status(403).json({ error: 'Not an admin of this hospital.' }); return null; }
  return db;
}
async function devOwned(req, res) {
  const db = getAdminDb();
  const id = String((req.body || {}).deviceId || '').trim();
  const hid = String((req.body || {}).hospitalId || '').trim();
  if (!db || !id || !hid) { res.status(400).json({ error: 'Missing device or hospital.' }); return null; }
  const snap = await db.collection('devices').doc(id).get();
  if (!snap.exists || snap.data().hospitalId !== hid) { res.status(404).json({ error: 'Device not found for this hospital.' }); return null; }
  const db2 = await devAdmin(req, res, hid);
  if (!db2) return null;
  return { db: db2, id, ref: snap.ref, data: snap.data() };
}
app.post('/api/device-wifi/register', async (req, res) => {
  try {
    const hid = String((req.body || {}).hospitalId || '').trim();
    const name = String((req.body || {}).name || 'Wi-Fi scanner').trim().slice(0, 40);
    const db = await devAdmin(req, res, hid); if (!db) return;
    const id = 'DEV-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const token = crypto.randomBytes(24).toString('hex');
    await db.collection('devices').doc(id).set({ hospitalId: hid, name, tokenHash: devHash(token), createdAt: admin.firestore.FieldValue.serverTimestamp(), scanRequested: false, connectRequest: null, networks: [], status: 'not connected yet' });
    res.json({ ok: true, deviceId: id, token });
  } catch (e) { console.error('device register error:', e); res.status(500).json({ error: 'Could not add the device.' }); }
});
app.post('/api/device-wifi/list', async (req, res) => {
  try {
    const hid = String((req.body || {}).hospitalId || '').trim();
    const db = await devAdmin(req, res, hid); if (!db) return;
    const snap = await db.collection('devices').where('hospitalId', '==', hid).get();
    res.json({ devices: snap.docs.map(d => { const x = d.data(); return { id: d.id, name: x.name, status: x.status || '', currentSsid: x.currentSsid || '', lastSeen: x.lastSeen ? x.lastSeen.toMillis() : null, networks: x.networks || [], scanAt: x.scanAt ? x.scanAt.toMillis() : null, scanRequested: !!x.scanRequested, connectPending: !!x.connectRequest }; }) });
  } catch (e) { res.status(500).json({ error: 'Could not load devices.' }); }
});
app.post('/api/device-wifi/scan', async (req, res) => {
  const d = await devOwned(req, res); if (!d) return;
  await d.ref.update({ scanRequested: true, scanRequestedAt: admin.firestore.FieldValue.serverTimestamp() });
  res.json({ ok: true });
});
app.post('/api/device-wifi/connect', async (req, res) => {
  const d = await devOwned(req, res); if (!d) return;
  const ssid = String((req.body || {}).ssid || '').slice(0, 32);
  const password = String((req.body || {}).password || '').slice(0, 63);
  if (!ssid) return res.status(400).json({ error: 'Choose a Wi-Fi network first.' });
  await d.ref.update({ connectRequest: { ssid, password, at: Date.now() }, status: 'waiting for the device to connect' });
  res.json({ ok: true });
});
app.post('/api/device-wifi/remove', async (req, res) => {
  const d = await devOwned(req, res); if (!d) return;
  await d.ref.delete();
  res.json({ ok: true });
});
// Device side: authenticated by the device's own token.
async function devAuth(req, res) {
  const db = getAdminDb();
  const id = String(req.query.deviceId || (req.body || {}).deviceId || '').trim();
  const token = String(req.headers['x-device-token'] || (req.body || {}).token || '');
  if (!db || !id || !token) { res.status(401).json({ error: 'unauthorised' }); return null; }
  const snap = await db.collection('devices').doc(id).get();
  if (!snap.exists || snap.data().tokenHash !== devHash(token)) { res.status(401).json({ error: 'unauthorised' }); return null; }
  return { ref: snap.ref, data: snap.data() };
}
app.get('/api/device/poll', async (req, res) => {
  try {
    const d = await devAuth(req, res); if (!d) return;
    await d.ref.update({ lastSeen: admin.firestore.FieldValue.serverTimestamp() });
    const cr = d.data.connectRequest;
    res.json({ scan: !!d.data.scanRequested, connect: cr ? { ssid: cr.ssid, password: cr.password } : null });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
app.post('/api/device/report', async (req, res) => {
  try {
    const d = await devAuth(req, res); if (!d) return;
    const b = req.body || {};
    const upd = { lastSeen: admin.firestore.FieldValue.serverTimestamp() };
    if (Array.isArray(b.networks)) {
      upd.networks = b.networks.slice(0, 30).map(n => ({ ssid: String(n.ssid || '').slice(0, 32), rssi: Number(n.rssi) || -100, secure: !!n.secure }));
      upd.scanAt = admin.firestore.FieldValue.serverTimestamp();
      upd.scanRequested = false;
    }
    if (typeof b.status === 'string') upd.status = b.status.slice(0, 120);
    if (typeof b.currentSsid === 'string') upd.currentSsid = b.currentSsid.slice(0, 32);
    if (b.connectApplied) { upd.connectRequest = null; upd.status = 'connected to ' + (b.currentSsid || 'Wi-Fi'); }
    await d.ref.update(upd);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// The scanner sends a card tap here. We write it to the same realtime-database path the app already listens to,
// so the Patient Scanner, RFID registration and check-in screens receive it without any app change.
const RTDB_URL = 'https://medilink-55d49-default-rtdb.asia-southeast1.firebasedatabase.app';
app.post('/api/device/card', async (req, res) => {
  try {
    const d = await devAuth(req, res); if (!d) return;
    const cardId = String((req.body || {}).cardId || '').trim().toUpperCase().slice(0, 40);
    if (!cardId) return res.status(400).json({ error: 'No card id' });
    const hid = d.data.hospitalId;
    if (!hid) return res.status(400).json({ error: 'Scanner is not linked to a hospital' });
    getAdminDb();   // makes sure the admin app is ready
    // Write the card first, so the app sees it at once; the lastSeen update can finish after the reply.
    await admin.app().database(RTDB_URL).ref('rfid/' + hid + '/lastScan').set(cardId);
    res.json({ ok: true });
    d.ref.update({ lastSeen: admin.firestore.FieldValue.serverTimestamp(), lastCard: cardId }).catch(() => {});
  } catch (e) { console.error('card endpoint failed:', e.message); res.status(500).json({ error: 'server error' }); }
});

// ============ AUTOMATIC REMINDERS ============
// Runs every morning (Vercel cron, 09:00 India time) and sends, by SMS first and WhatsApp as backup:
//   1. a reminder the day before every booked appointment, with one-tap Cancel / Reschedule links;
//   2. a follow-up reminder the day before the follow-up date the doctor wrote on the prescription;
//   3. a medicine-refill reminder the day before the longest course on a prescription ends.
// Each reminder is sent once (the record is stamped), and a hospital can switch the whole thing off in Control.
const APP_BASE = () => process.env.APP_URL || 'https://mediflow-naitik.vercel.app';
const istDate = (plusDays) => new Date(Date.now() + 5.5 * 3600e3 + (plusDays || 0) * 86400e3).toISOString().slice(0, 10);
const reminderSig = (h, a) => crypto.createHmac('sha256', process.env.CRON_SECRET || 'mf-reminder').update(h + '|' + a).digest('hex').slice(0, 24);
function courseDays(duration) {
  const t = String(duration || '').toLowerCase();
  const m = t.match(/(\d+(?:\.\d+)?)\s*(day|d|week|wk|month|mo)?/);
  if (!m) return 0;
  const n = parseFloat(m[1]); const u = m[2] || 'day';
  return Math.round(n * (/^w/.test(u) ? 7 : /^mo/.test(u) ? 30 : 1));
}
async function runReminders(db, onlyHospital) {
  const out = { hospitals: 0, appointments: 0, followUps: 0, refills: 0, failed: 0 };
  const tomorrow = istDate(1), today = istDate(0);
  const hs = await db.collection('hospitals').get();
  for (const hd of hs.docs) {
    const h = hd.data(), hid = hd.id;
    if (onlyHospital && hid !== onlyHospital) continue;
    if (h.status === 'blocked' || (h.features && h.features.reminders === false)) continue;
    out.hospitals++;
    const base = 'hospitals/' + hid;
    const patientCache = {};
    const phoneOf = async (pid) => {
      if (!pid) return '';
      if (!(pid in patientCache)) {
        const s = await db.collection(base + '/patients').where('patientId', '==', pid).limit(1).get();
        patientCache[pid] = s.empty ? '' : String(s.docs[0].data().phone || '').replace(/\D/g, '').slice(-10);
      }
      return patientCache[pid];
    };
    const send = async (phone, text) => {
      if (!phone || phone.length !== 10) return false;
      try { const r = await deliverNotice(db, hid, h, '91' + phone, text, 'update', null); return !!r.sent; } catch(e) { return false; }
    };
    const hosp = h.name || 'your hospital';
    // 0. pharmacy stock / expiry summary for the admin (only when something needs attention)
    try {
      if (h.adminWhatsAppNumber && h.features && h.features.pharmacy === false) { /* store switched off */ }
      else if (h.adminWhatsAppNumber) {
        const mSnap = await db.collection(base + '/medicines').get();
        const todayD = new Date(today + 'T00:00:00Z').getTime(), soonD = todayD + 60 * 86400e3;
        let low = 0, expiring = 0, expired = 0;
        mSnap.docs.forEach(d => {
          const m = d.data();
          if ((Number(m.stock) || 0) <= (Number(m.lowStockThreshold) || 5)) low++;
          if (m.expiryDate) { const e = new Date(String(m.expiryDate).slice(0, 10) + 'T00:00:00Z').getTime(); if (!isNaN(e)) { if (e < todayD) expired++; else if (e <= soonD) expiring++; } }
        });
        if ((low || expiring || expired) && h.lastStockAlertDate !== today) {
          const parts = [];
          if (low) parts.push(low + ' medicine' + (low === 1 ? ' is' : 's are') + ' low on stock');
          if (expired) parts.push(expired + ' ' + (expired === 1 ? 'has' : 'have') + ' expired');
          if (expiring) parts.push(expiring + ' expire' + (expiring === 1 ? 's' : '') + ' within 60 days');
          const to = String(h.adminWhatsAppNumber).replace(/\D/g, '').slice(-10);
          if (to.length === 10) {
            await deliverNotice(db, hid, h, '91' + to, 'MediFlow pharmacy alert: ' + parts.join(', ') + '. Open Medical Store to see the reorder list.', 'update', null).catch(() => {});
            await hd.ref.update({ lastStockAlertDate: today }).catch(() => {});
            out.stockAlerts = (out.stockAlerts || 0) + 1;
          }
        }
      }
    } catch(e) { console.warn('stock alert failed for', hid, e.message); }
    // 1. appointments tomorrow
    const apSnap = await db.collection(base + '/appointments').where('appointmentDate', '==', tomorrow).get();
    for (const d of apSnap.docs) {
      const a = d.data();
      if (a.status !== 'pending' || a.reminderSentAt) continue;
      const phone = await phoneOf(a.patientId);
      const sig = reminderSig(hid, d.id);
      const link = APP_BASE() + '/r/' + hid + '/' + d.id + '/' + sig;
      const ok = await send(phone, 'Reminder: you have an appointment with Dr ' + (a.doctorName || '') + ' tomorrow' + (a.appointmentTime ? ' at ' + a.appointmentTime : '') + (a.token ? ' (token ' + a.token + ')' : '') + ' at ' + hosp + '. Cannot come? Cancel or reschedule in one tap: ' + link);
      if (ok) { await d.ref.update({ reminderSentAt: admin.firestore.FieldValue.serverTimestamp() }); out.appointments++; } else if (phone) out.failed++;
    }
    // 2 + 3. finished visits: follow-up and medicine refill
    const doneSnap = await db.collection(base + '/appointments').where('status', '==', 'done').get();
    for (const d of doneSnap.docs) {
      const a = d.data();
      if (a.followupDate && a.followupDate === tomorrow && !a.followUpReminderSentAt) {
        const phone = await phoneOf(a.patientId);
        const ok = await send(phone, 'Reminder: Dr ' + (a.doctorName || '') + ' asked you to come for a follow-up visit tomorrow at ' + hosp + '. Book your slot: ' + APP_BASE() + '/?go=patBook');
        if (ok) { await d.ref.update({ followUpReminderSentAt: admin.firestore.FieldValue.serverTimestamp() }); out.followUps++; } else if (phone) out.failed++;
      }
      if (!a.refillReminderSentAt && Array.isArray(a.medicines) && a.medicines.length) {
        const days = Math.max(0, ...a.medicines.map(m => courseDays(m && m.duration)));
        const start = String(a.appointmentDate || '').slice(0, 10);
        if (days > 0 && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
          const end = new Date(new Date(start + 'T00:00:00Z').getTime() + days * 86400e3).toISOString().slice(0, 10);
          if (end === tomorrow || end === today) {
            const phone = await phoneOf(a.patientId);
            const ok = await send(phone, 'Your medicines from Dr ' + (a.doctorName || '') + ' may be finishing ' + (end === today ? 'today' : 'tomorrow') + '. Order a refill from ' + hosp + "'s medical store: " + APP_BASE() + '/?go=patMedStore');
            if (ok) { await d.ref.update({ refillReminderSentAt: admin.firestore.FieldValue.serverTimestamp() }); out.refills++; } else if (phone) out.failed++;
          }
        }
      }
    }
  }
  return out;
}
app.get('/api/send-reminders', async (req, res) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers.authorization !== 'Bearer ' + cronSecret) return res.status(401).json({ error: 'Unauthorized' });
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    res.json({ ok: true, ...(await runReminders(db, null)) });
  } catch(e) { console.error('send-reminders error:', e); res.status(500).json({ error: e.message }); }
});
// Owner can run it by hand for one hospital (handy for testing).
app.post('/api/send-reminders-now', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    const dec = await requireOwner(req, res); if (!dec) return;
    res.json({ ok: true, ...(await runReminders(db, String((req.body || {}).hospitalId || '') || null)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// One-tap page from the reminder message: cancel, or cancel and go straight to rebooking.
function reminderPage(title, body, extra) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#0b1220;color:#eaf0fa;display:grid;place-items:center;min-height:100vh;padding:20px}.c{max-width:420px;width:100%;background:#131f36;border:1px solid #22314f;border-radius:18px;padding:26px;text-align:center}button,a.b{display:block;width:100%;padding:13px;border-radius:12px;border:none;font-weight:700;font-size:1rem;margin-top:10px;cursor:pointer;text-decoration:none;box-sizing:border-box;color:#04121a;background:linear-gradient(135deg,#00e676,#00b0ff)}button.s{background:#22314f;color:#eaf0fa}button.d{background:#ff5252;color:#fff}</style></head><body><div class="c"><img src="/mediflow-logo.png" width="56" height="56" style="border-radius:12px;background:#fff" alt="MediFlow"><h2>' + title + '</h2>' + body + (extra || '') + '</div></body></html>';
}
async function reminderLookup(req) {
  const { h, a, sig } = req.params;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(h) || !/^[A-Za-z0-9]{10,40}$/.test(a) || sig !== reminderSig(h, a)) return null;
  const db = getAdminDb(); if (!db) return null;
  const ref = db.collection('hospitals/' + h + '/appointments').doc(a);
  const snap = await ref.get();
  return snap.exists ? { db, ref, h, a, data: snap.data() } : null;
}
app.get('/r/:h/:a/:sig', async (req, res) => {
  try {
    const r = await reminderLookup(req);
    if (!r) return res.status(404).type('html').send(reminderPage('Link not valid', '<p>This link is invalid or has expired.</p>'));
    if (r.data.status !== 'pending') return res.type('html').send(reminderPage('Already updated', '<p>This appointment is already ' + String(r.data.status).replace(/[<>&]/g, '') + '.</p><a class="b" href="/?go=patBook">Book a new appointment</a>'));
    const when = String(r.data.appointmentDate || '') + (r.data.appointmentTime ? ' at ' + String(r.data.appointmentTime) : '');
    const esc = t => String(t || '').replace(/[<>&"]/g, '');
    res.type('html').send(reminderPage('Your appointment', '<p>Dr ' + esc(r.data.doctorName) + '<br><strong>' + esc(when) + '</strong></p>',
      '<form method="post"><button name="act" value="reschedule">Reschedule</button><button class="d" name="act" value="cancel" onclick="return confirm(\'Cancel this appointment?\')">Cancel appointment</button><button class="s" type="button" onclick="location.href=\'/\'">Keep it</button></form>'));
  } catch(e) { res.status(500).send('Something went wrong'); }
});
app.post('/r/:h/:a/:sig', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const r = await reminderLookup(req);
    if (!r || r.data.status !== 'pending') return res.status(404).type('html').send(reminderPage('Link not valid', '<p>This link is invalid or has expired.</p>'));
    await r.ref.update({ status: 'cancelled', cancelledBy: 'patient-reminder-link', cancelledAt: admin.firestore.FieldValue.serverTimestamp() });
    const q = await r.db.collection('hospitals/' + r.h + '/queue').where('appointmentId', '==', r.a).get();
    await Promise.all(q.docs.map(d => d.ref.update({ status: 'cancelled' })));
    if ((req.body || {}).act === 'reschedule') return res.redirect(302, '/?go=patBook');
    res.type('html').send(reminderPage('Appointment cancelled', '<p>Your appointment has been cancelled. The hospital has been told.</p>', '<a class="b" href="/?go=patBook">Book another time</a>'));
  } catch(e) { res.status(500).send('Something went wrong'); }
});

// ============ OPTIONAL TWO-STEP LOGIN (admins) ============
// After the password, an admin who switched this on gets a 6-digit code by SMS (WhatsApp as backup).
// Codes are stored only as a hash, last 5 minutes, allow 5 tries, and one can be requested every 30 seconds.
const TWOSTEP_TTL = 5 * 60 * 1000;
const twoStepHash = (uid, code) => crypto.createHash('sha256').update(uid + ':' + code + ':' + (process.env.CRON_SECRET || 'mf')).digest('hex');
async function adminFromToken(req, res) {
  const { idToken } = req.body || {};
  if (!idToken) { res.status(400).json({ error: 'Missing idToken.' }); return null; }
  try { return await admin.auth().verifyIdToken(idToken); }
  catch(e) { res.status(401).json({ error: 'Session expired — please log in again.' }); return null; }
}
app.post('/api/2fa-send', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    const dec = await adminFromToken(req, res); if (!dec) return;
    const aSnap = await db.collection('admins').doc(dec.uid).get();
    if (!aSnap.exists || !aSnap.data().twoStep) return res.json({ ok: true, required: false });
    const hid = String(aSnap.data().hospitalId || '').trim();
    const hSnap = hid ? await db.collection('hospitals').doc(hid).get() : null;
    const h = hSnap && hSnap.exists ? hSnap.data() : {};
    const to = String(aSnap.data().twoStepPhone || h.adminWhatsAppNumber || h.phone || '').replace(/\D/g, '').slice(-10);
    if (to.length !== 10) return res.json({ ok: false, required: true, error: 'No mobile number on file for this admin.' });
    const ref = db.collection('loginOtps').doc(dec.uid);
    const prev = await ref.get();
    if (prev.exists && Date.now() - (prev.data().sentAt || 0) < 30000) return res.status(429).json({ error: 'Please wait 30 seconds before asking for another code.' });
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await ref.set({ hash: twoStepHash(dec.uid, code), sentAt: Date.now(), expiresAt: Date.now() + TWOSTEP_TTL, tries: 0 });
    const r = await deliverNotice(db, hid, h, '91' + to, 'Your MediFlow login code is ' + code + '. It is valid for 5 minutes. Do not share it with anyone.', 'otp', null);
    if (!r.sent) return res.json({ ok: false, required: true, error: 'Could not send the code (' + (r.error || 'SMS/WhatsApp unavailable') + ').' });
    res.json({ ok: true, required: true, sentTo: '******' + to.slice(-4) });
  } catch(e) { console.error('2fa-send error:', e); res.status(500).json({ error: 'Something went wrong.' }); }
});
app.post('/api/2fa-verify', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    const dec = await adminFromToken(req, res); if (!dec) return;
    const code = String((req.body || {}).code || '').replace(/\D/g, '');
    const ref = db.collection('loginOtps').doc(dec.uid);
    const snap = await ref.get();
    if (!snap.exists) return res.status(400).json({ error: 'Ask for a new code.' });
    const d = snap.data();
    if (Date.now() > d.expiresAt) { await ref.delete(); return res.status(400).json({ error: 'That code has expired. Ask for a new one.' }); }
    if ((d.tries || 0) >= 5) { await ref.delete(); return res.status(429).json({ error: 'Too many wrong tries. Ask for a new code.' }); }
    if (twoStepHash(dec.uid, code) !== d.hash) { await ref.update({ tries: (d.tries || 0) + 1 }); return res.status(400).json({ error: 'Wrong code.' }); }
    await ref.delete();
    res.json({ ok: true });
  } catch(e) { console.error('2fa-verify error:', e); res.status(500).json({ error: 'Something went wrong.' }); }
});

// ============ PUSHED UPDATES (banner + install screen) ============
// The owner writes a title/description in Manage Hospitals → "Push an Update". Every targeted hospital admin
// then sees a banner on opening the app, can tap Install, and the app clears its caches and reloads onto the
// newest deployed code. Hospitals that are pinned to an old version (no updates in their plan) are skipped.
// Everything goes through these endpoints (admin SDK) so no Firestore rules need changing.
const UPDATE_TYPES = ['feature', 'bugfix', 'security', 'critical'];
async function requireOwner(req, res) {
  const { idToken } = req.body || {};
  if (!idToken) { res.status(400).json({ error: 'Missing idToken.' }); return null; }
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(idToken); }
  catch(e) { res.status(401).json({ error: 'Session expired — please log in again.' }); return null; }
  if (decoded.email !== PLATFORM_SUPER_ADMIN_EMAIL) { res.status(403).json({ error: 'Only the platform owner can do this.' }); return null; }
  return decoded;
}
app.post('/api/push-platform-update', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    const decoded = await requireOwner(req, res); if (!decoded) return;
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 120);
    const description = String(b.description || '').trim().slice(0, 2000);
    if (!title || !description) return res.status(400).json({ error: 'Add a title and a description.' });
    const type = UPDATE_TYPES.includes(b.type) ? b.type : 'feature';
    const targets = Array.isArray(b.targets) && b.targets.length ? b.targets.map(String).slice(0, 500) : 'all';
    const installSeconds = Math.min(300, Math.max(5, parseInt(b.installSeconds, 10) || 180));
    const mandatory = !!b.mandatory || type === 'critical';
    const unlocks = ['icons'].includes(b.unlocks) ? b.unlocks : '';
    // Update number: what you type, or automatically the next one after the highest so far (the first is #32).
    let version = String(b.version || '').trim();
    if (!/^\d{1,3}(\.\d{1,3}){0,2}$/.test(version)) {
      // Automatic: one step above the highest version pushed so far; the very first push is 15.2.
      const prev = await db.collection('platformUpdates').get();
      const parse = v => String(v || '').split('.').map(n => parseInt(n, 10) || 0);
      const cmp = (x, y) => { for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
      let best = null;
      prev.docs.forEach(d => { const v = parse(d.data().version); if (d.data().version && (!best || cmp(v, best) > 0)) best = v; });
      if (!best) version = '15.2';
      else { best = best.slice(0, Math.max(2, best.length)); best[best.length - 1] += 1; version = best.join('.'); }
    }
    const number = null;
    const ref = db.collection('platformUpdates').doc();
    await ref.set({ title, description, type, targets, installSeconds, mandatory, unlocks, version, installedCount: 0, createdAt: admin.firestore.FieldValue.serverTimestamp(), createdBy: decoded.email });
    // Heads-up on WhatsApp for hospitals that linked an admin number (banner is the main channel).
    (async () => {
      try {
        const hs = await db.collection('hospitals').get();
        for (const d of hs.docs) {
          const h = d.data();
          if (h.pinnedVersion || h.status === 'blocked') continue;
          if (targets !== 'all' && !targets.includes(d.id)) continue;
          if (h.adminWhatsAppNumber && h.whatsappPhoneNumberId) {
            try { await sendWhatsAppText(h.adminWhatsAppNumber, '🚀 MediFlow update available: ' + title + '\n\n' + description + '\n\nOpen MediFlow and tap Install.', h.whatsappPhoneNumberId); } catch(e) {}
          }
        }
      } catch(e) { console.warn('update WhatsApp heads-up failed:', e.message); }
    })();
    res.json({ ok: true, id: ref.id });
  } catch(e) { console.error('push-platform-update error:', e); res.status(500).json({ error: e.message }); }
});
// What the app asks on opening: is there an update this hospital hasn't installed yet?
app.get('/api/pending-update', async (req, res) => {
  try {
    const db = getAdminDb();
    const hid = String(req.query.hospitalId || '');
    if (!db || !hid) return res.json({ update: null });
    const hsnap = await db.collection('hospitals').doc(hid).get();
    if (!hsnap.exists) return res.json({ update: null });
    const pinned = !!hsnap.data().pinnedVersion;
    const ups = await db.collection('platformUpdates').orderBy('createdAt', 'desc').limit(10).get();
    const applied = new Set((await db.collection('hospitals/' + hid + '/appliedUpdates').get()).docs.map(d => d.id));
    if (req.query.all) {
      const history = ups.docs.filter(d => { const t = d.data().targets; return t === 'all' || (Array.isArray(t) && t.includes(hid)); }).map(d => { const u = d.data(); return { id: d.id, title: u.title, description: u.description, type: u.type, mandatory: !!u.mandatory, installSeconds: u.installSeconds || 180, installed: applied.has(d.id), version: u.version || null, createdAt: u.createdAt && u.createdAt.toMillis ? u.createdAt.toMillis() : null }; });
      return res.json({ history, pinned });
    }
    if (pinned) return res.json({ update: null });
    for (const d of ups.docs) {
      const u = d.data();
      if (applied.has(d.id)) continue;
      if (u.targets !== 'all' && !(Array.isArray(u.targets) && u.targets.includes(hid))) continue;
      return res.json({ update: { id: d.id, title: u.title, description: u.description, type: u.type, mandatory: !!u.mandatory, installSeconds: u.installSeconds || 180, unlocks: u.unlocks || '', version: u.version || null, createdAt: u.createdAt && u.createdAt.toMillis ? u.createdAt.toMillis() : null } });
    }
    res.json({ update: null });
  } catch(e) { res.json({ update: null }); }
});
app.post('/api/update-installed', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    const { idToken, hospitalId, updateId } = req.body || {};
    if (!idToken || !hospitalId || !updateId) return res.status(400).json({ error: 'Missing details.' });
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(idToken); }
    catch(e) { return res.status(401).json({ error: 'Session expired — please log in again.' }); }
    let allowed = decoded.email === PLATFORM_SUPER_ADMIN_EMAIL;
    if (!allowed) {
      const norm = x => String(x || '').trim();
      const byUid = await db.collection('admins').doc(decoded.uid).get();
      allowed = byUid.exists && norm(byUid.data().hospitalId) === norm(hospitalId);
      if (!allowed) {
        const q = await db.collection('admins').where('email', '==', decoded.email).get();
        allowed = q.docs.some(d => norm(d.data().hospitalId) === norm(hospitalId));
      }
      if (!allowed) {
        const hd = await db.collection('hospitals').doc(hospitalId).get();
        const e = hd.exists ? [hd.data().email, hd.data().adminEmail, hd.data().contactEmail].map(x => String(x || '').toLowerCase()) : [];
        allowed = e.includes(String(decoded.email || '').toLowerCase());
      }
    }
    if (!allowed) return res.status(403).json({ error: 'Not an admin of this hospital.' });
    // Installing puts the hospital on the newest code, so it also covers any older announced updates.
    const target = await db.collection('platformUpdates').doc(String(updateId)).get();
    const cutoff = target.exists && target.data().createdAt ? target.data().createdAt.toMillis() : Date.now();
    if (target.exists && target.data().version) await db.collection('hospitals').doc(hospitalId).set({ appVersion: target.data().version }, { merge: true });
    const recent = await db.collection('platformUpdates').orderBy('createdAt', 'desc').limit(20).get();
    for (const u of recent.docs) {
      const t = u.data().createdAt ? u.data().createdAt.toMillis() : 0;
      if (t > cutoff) continue;
      const tg = u.data().targets;
      if (!(tg === 'all' || (Array.isArray(tg) && tg.includes(hospitalId)))) continue;
      const aref = db.collection('hospitals/' + hospitalId + '/appliedUpdates').doc(u.id);
      if (!(await aref.get()).exists) {
        await aref.set({ installedAt: admin.firestore.FieldValue.serverTimestamp(), by: decoded.email });
        await u.ref.set({ installedCount: admin.firestore.FieldValue.increment(1) }, { merge: true });
      }
      // Some updates switch on a visual pack for the hospital the moment they are installed.
      if (u.data().unlocks) await db.collection('hospitals').doc(hospitalId).set({ uiPacks: admin.firestore.FieldValue.arrayUnion(u.data().unlocks) }, { merge: true });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/platform-updates-list', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    const decoded = await requireOwner(req, res); if (!decoded) return;
    const snap = await db.collection('platformUpdates').orderBy('createdAt', 'desc').limit(30).get();
    const hs = await db.collection('hospitals').get();
    const eligible = hs.docs.filter(d => !d.data().pinnedVersion && d.data().status !== 'blocked').map(d => d.id);
    res.json({ updates: snap.docs.map(d => { const u = d.data(); return { id: d.id, title: u.title, description: u.description, type: u.type, mandatory: !!u.mandatory, version: u.version || null, targets: u.targets === 'all' ? 'all' : (u.targets || []).length, installedCount: u.installedCount || 0, eligible: u.targets === 'all' ? eligible.length : (u.targets || []).filter(x => eligible.includes(x)).length, createdAt: u.createdAt && u.createdAt.toMillis ? u.createdAt.toMillis() : null }; }) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/platform-update-delete', async (req, res) => {
  try {
    const db = getAdminDb();
    if (!db) return res.status(503).json({ error: 'Not configured yet.' });
    const decoded = await requireOwner(req, res); if (!decoded) return;
    const id = String((req.body || {}).id || '');
    if (!id) return res.status(400).json({ error: 'Missing id.' });
    await db.collection('platformUpdates').doc(id).delete();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Vercel's serverless bundler only packages files it can trace by name from the code — it
// can't see what express.static(__dirname) might serve at runtime, so anything not named
// explicitly here (like the logo) gets silently dropped from the deployment and every request
// for it falls through to the catch-all route below, which "succeeds" by returning index.html
// instead of a 404. Any new static asset added later needs its own explicit route like this.
// Public website. Ads load only when ADSENSE_CLIENT (e.g. ca-pub-1234567890123456) and ADSENSE_SLOT are set in
// Vercel, and in the browser only after the visitor accepts. The logged-in app never shows ads.
app.get(['/home', '/home.html'], (req, res) => {
  try {
    const client = /^ca-pub-\d{10,20}$/.test(process.env.ADSENSE_CLIENT || '') ? process.env.ADSENSE_CLIENT : '';
    const slot = /^\d{6,20}$/.test(process.env.ADSENSE_SLOT || '') ? process.env.ADSENSE_SLOT : '';
    const html = fs.readFileSync(path.join(__dirname, 'home.html'), 'utf8').replace('__ADSENSE_CLIENT__', client).replace('__ADSENSE_SLOT__', slot);
    res.type('html').send(html);
  } catch(e) { res.status(500).send('Page unavailable'); }
});
app.get('/ads.txt', (req, res) => {
  const client = /^ca-pub-\d{10,20}$/.test(process.env.ADSENSE_CLIENT || '') ? process.env.ADSENSE_CLIENT : '';
  if (!client) return res.status(404).send('Not found');
  res.type('text/plain').send('google.com, ' + client.replace('ca-', '') + ', DIRECT, f08c47fec0942fa0\n');
});
app.get('/mediflow-logo.png', (req, res) => res.sendFile(path.join(__dirname, 'mediflow-logo.png')));

// Same "untraced static file" issue as the logo above — Node File Trace only follows literal
// path.join(__dirname, 'x') string arguments; a loop building the path from a variable (as this
// used to do) isn't statically analyzable, so those files got silently dropped again. Every new
// static asset needs its own explicit route with a literal filename, no exceptions.
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/service-worker.js', (req, res) => res.sendFile(path.join(__dirname, 'service-worker.js')));
app.get('/icon-192.png', (req, res) => res.sendFile(path.join(__dirname, 'icon-192.png')));
app.get('/icon-512.png', (req, res) => res.sendFile(path.join(__dirname, 'icon-512.png')));
app.get('/icon-maskable-512.png', (req, res) => res.sendFile(path.join(__dirname, 'icon-maskable-512.png')));
app.get('/apple-touch-icon.png', (req, res) => res.sendFile(path.join(__dirname, 'apple-touch-icon.png')));
app.get('/mediflow.apk', (req, res) => res.sendFile(path.join(__dirname, 'mediflow.apk'), err => {
  if (err) res.status(404).send('APK not built yet');
}));

// Alexa skill (voice booking) — endpoint, account linking and token exchange.
require('./alexa')(app, { getAdminDb, admin, execWaTool, express });
const { renderLegalPage } = require('./legal');
['privacy', 'terms', 'cookies', 'refund'].forEach(slug => {
  app.get('/' + slug, (req, res) => res.type('html').send(renderLegalPage(slug)));
});

app.use(express.static(path.join(__dirname), { index: false }));

app.get(/.*/, (req, res) => {
  res.sendFile(indexFile);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('MediLink running at http://localhost:' + PORT);
});
