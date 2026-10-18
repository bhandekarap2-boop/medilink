// MediFlow Alexa skill — voice access for patients (book / hear / cancel appointments, token, hospital info, medicine order status).
//
// Pieces:
//   POST /api/alexa         the skill endpoint (every request is checked to really come from Amazon)
//   GET/POST /alexa/auth    account linking page: the patient signs in with Patient ID + password
//   POST /alexa/token       account linking token exchange (authorization code + refresh token)
//
// Alexa never sees anything until the patient links their account; after that every request carries an access
// token that maps to exactly one patient record in one hospital.
const crypto = require('crypto');

module.exports = function mountAlexa(app, deps) {
  const { getAdminDb, admin, execWaTool, express } = deps;
  const BASE = process.env.APP_BASE_URL || 'https://mediflow-naitik.vercel.app';
  const ALLOWED_REDIRECTS = [/^https:\/\/pitangui\.amazon\.com\/api\/skill\/link\//, /^https:\/\/layla\.amazon\.com\/api\/skill\/link\//, /^https:\/\/alexa\.amazon\.co\.jp\/api\/skill\/link\//];
  const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
  const rand = n => crypto.randomBytes(n).toString('hex');
  const esc = t => String(t == null ? '' : t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- password check (same formats the app writes) ----------
  function verifyPassword(pw, stored) {
    if (!stored || typeof stored !== 'string') return false;
    if (stored.indexOf('pbkdf2$') === 0) {
      const p = stored.split('$'); if (p.length !== 4) return false;
      const h = crypto.pbkdf2Sync(String(pw), Buffer.from(p[2], 'base64'), parseInt(p[1], 10) || 150000, 32, 'sha256').toString('base64');
      return h.length === p[3].length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(p[3]));
    }
    return stored === Buffer.from(String(pw), 'latin1').toString('base64') || stored === pw;
  }

  // ---------- tiny login rate limit ----------
  const tries = new Map();
  function limited(ip) {
    const now = Date.now(), arr = (tries.get(ip) || []).filter(t => now - t < 10 * 60 * 1000);
    arr.push(now); tries.set(ip, arr); return arr.length > 12;
  }

  // ---------- account linking ----------
  function page(title, body) {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#0b1220;color:#eaf0fa;display:grid;place-items:center;min-height:100vh;padding:20px}.c{max-width:420px;width:100%;background:#131f36;border:1px solid #22314f;border-radius:18px;padding:26px}input{width:100%;padding:13px;margin:6px 0 14px;border-radius:12px;border:1px solid #2d4068;background:#0d1a30;color:#fff;font-size:1rem;box-sizing:border-box}button{width:100%;padding:14px;border:none;border-radius:12px;font-weight:700;font-size:1rem;color:#04121a;background:linear-gradient(135deg,#00e676,#00b0ff);cursor:pointer}.e{color:#ff8a80;margin-bottom:10px}small{color:#9fb0cc}</style></head><body><div class="c"><div style="text-align:center"><img src="/mediflow-logo.png" width="64" height="64" style="border-radius:14px;background:#fff" alt="MediFlow"></div><h2 style="text-align:center">' + esc(title) + '</h2>' + body + '</div></body></html>';
  }
  function loginForm(q, error) {
    const hidden = ['client_id', 'redirect_uri', 'state', 'response_type', 'scope'].map(k => '<input type="hidden" name="' + k + '" value="' + esc(q[k] || '') + '">').join('');
    return page('Link MediFlow to Alexa', (error ? '<div class="e">' + esc(error) + '</div>' : '') +
      '<p><small>Sign in with your Patient ID and password. After this, you can ask Alexa to book and manage your appointments.</small></p><form method="post" action="/alexa/auth">' + hidden +
      '<label>Patient ID</label><input name="pid" autocomplete="username" placeholder="e.g. PAT-ABC-0001" required><label>Password</label><input name="pw" type="password" autocomplete="current-password" required><button type="submit">Link my account</button></form>');
  }
  function checkClient(q) {
    const okId = process.env.ALEXA_CLIENT_ID && q.client_id === process.env.ALEXA_CLIENT_ID;
    const okUri = ALLOWED_REDIRECTS.some(r => r.test(String(q.redirect_uri || '')));
    return okId && okUri && q.response_type === 'code';
  }
  app.get('/alexa/auth', (req, res) => {
    if (!checkClient(req.query)) return res.status(400).type('html').send(page('Link not valid', '<p>This link is not valid. Start linking again from the Alexa app.</p>'));
    res.type('html').send(loginForm(req.query));
  });
  app.post('/alexa/auth', express.urlencoded({ extended: false }), async (req, res) => {
    const q = req.body || {};
    if (!checkClient(q)) return res.status(400).type('html').send(page('Link not valid', '<p>This link is not valid. Start linking again from the Alexa app.</p>'));
    try {
      if (limited(req.ip || 'x')) return res.status(429).type('html').send(loginForm(q, 'Too many tries. Please wait a few minutes.'));
      const db = getAdminDb(); if (!db) return res.status(503).send('Not configured');
      const pid = String(q.pid || '').trim().toUpperCase();
      const dir = pid ? await db.collection('patientDirectory').doc(pid).get() : null;
      if (!dir || !dir.exists) return res.type('html').send(loginForm(q, 'Patient ID or password is wrong.'));
      const hid = String(dir.data().hospitalId || '').trim();
      const ps = await db.collection('hospitals/' + hid + '/patients').where('patientId', '==', pid).limit(1).get();
      if (ps.empty || !verifyPassword(q.pw, ps.docs[0].data().password)) return res.type('html').send(loginForm(q, 'Patient ID or password is wrong.'));
      const hs = await db.collection('hospitals').doc(hid).get();
      if (hs.exists && hs.data().status === 'blocked') return res.type('html').send(loginForm(q, 'This hospital is not available right now.'));
      const code = rand(24);
      await db.collection('alexaCodes').doc(sha(code)).set({ hospitalId: hid, patientDocId: ps.docs[0].id, patientId: pid, expiresAt: Date.now() + 10 * 60 * 1000, redirect: q.redirect_uri });
      const u = new URL(q.redirect_uri); u.searchParams.set('code', code); if (q.state) u.searchParams.set('state', q.state);
      res.redirect(302, u.toString());
    } catch (e) { console.error('alexa auth error:', e); res.status(500).type('html').send(page('Something went wrong', '<p>Please try again.</p>')); }
  });
  app.post('/alexa/token', express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const db = getAdminDb(); if (!db) return res.status(503).json({ error: 'server_error' });
      const q = req.body || {};
      let cid = q.client_id, cs = q.client_secret;
      const basic = String(req.headers.authorization || '').match(/^Basic (.+)$/i);
      if (basic) { const [a, b] = Buffer.from(basic[1], 'base64').toString().split(':'); cid = a; cs = b; }
      if (!process.env.ALEXA_CLIENT_ID || cid !== process.env.ALEXA_CLIENT_ID || !process.env.ALEXA_CLIENT_SECRET || cs !== process.env.ALEXA_CLIENT_SECRET) return res.status(401).json({ error: 'invalid_client' });
      let link = null;
      if (q.grant_type === 'authorization_code') {
        const ref = db.collection('alexaCodes').doc(sha(q.code || '')); const snap = await ref.get();
        if (!snap.exists || snap.data().expiresAt < Date.now()) return res.status(400).json({ error: 'invalid_grant' });
        link = snap.data(); await ref.delete();
      } else if (q.grant_type === 'refresh_token') {
        const snap = await db.collection('alexaRefresh').doc(sha(q.refresh_token || '')).get();
        if (!snap.exists) return res.status(400).json({ error: 'invalid_grant' });
        link = snap.data();
      } else return res.status(400).json({ error: 'unsupported_grant_type' });
      const access = rand(32), refresh = q.grant_type === 'refresh_token' ? q.refresh_token : rand(32);
      await db.collection('alexaTokens').doc(sha(access)).set({ hospitalId: link.hospitalId, patientDocId: link.patientDocId, patientId: link.patientId, expiresAt: Date.now() + 3600 * 1000 });
      if (q.grant_type !== 'refresh_token') await db.collection('alexaRefresh').doc(sha(refresh)).set({ hospitalId: link.hospitalId, patientDocId: link.patientDocId, patientId: link.patientId, createdAt: Date.now() });
      res.set('Cache-Control', 'no-store').json({ access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh });
    } catch (e) { console.error('alexa token error:', e); res.status(500).json({ error: 'server_error' }); }
  });

  // ---------- owner test page: makes a one-hour test login for the Alexa simulator ----------
  // Needs the Alexa client secret plus a patient's own Patient ID and password, so only the owner can use it.
  const testForm = msg => page('Alexa test login', (msg ? '<div class="e">' + esc(msg) + '</div>' : '') +
    '<p><small>For testing the MediFlow skill in the Alexa simulator. Creates a login that lasts one hour.</small></p>' +
    '<form method="post" action="/alexa/test-token"><label>Alexa client secret</label><input name="secret" type="password" required><label>Patient ID</label><input name="pid" required><label>Patient password</label><input name="pw" type="password" required><button type="submit">Create test login</button></form>');
  app.get('/alexa/test-token', (req, res) => res.type('html').send(testForm()));
  app.post('/alexa/test-token', express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const q = req.body || {};
      if (!process.env.ALEXA_CLIENT_SECRET || q.secret !== process.env.ALEXA_CLIENT_SECRET) return res.status(401).type('html').send(testForm('Client secret is wrong.'));
      if (limited(req.ip || 'x')) return res.status(429).type('html').send(testForm('Too many tries. Wait a few minutes.'));
      const db = getAdminDb(); if (!db) return res.status(503).type('html').send(testForm('Server not configured.'));
      const pid = String(q.pid || '').trim().toUpperCase();
      const dir = pid ? await db.collection('patientDirectory').doc(pid).get() : null;
      if (!dir || !dir.exists) return res.type('html').send(testForm('Patient ID or password is wrong.'));
      const hid = String(dir.data().hospitalId || '').trim();
      const ps = await db.collection('hospitals/' + hid + '/patients').where('patientId', '==', pid).limit(1).get();
      if (ps.empty || !verifyPassword(q.pw, ps.docs[0].data().password)) return res.type('html').send(testForm('Patient ID or password is wrong.'));
      const token = rand(32);
      await db.collection('alexaTokens').doc(sha(token)).set({ hospitalId: hid, patientDocId: ps.docs[0].id, patientId: pid, expiresAt: Date.now() + 3600 * 1000 });
      const skillId = process.env.ALEXA_SKILL_ID || 'amzn1.ask.skill.476f3b88-bc43-4120-bcc9-edd0ee6d4ac6';
      const json = JSON.stringify({ version: '1.0', context: { System: { application: { applicationId: skillId }, user: { accessToken: token }, device: { supportedInterfaces: {} } } }, session: { new: true, sessionId: 'test-' + Date.now(), application: { applicationId: skillId }, user: { userId: 'test', accessToken: token }, attributes: {} }, request: { type: 'IntentRequest', requestId: 'test', timestamp: new Date().toISOString(), locale: 'en-IN', intent: { name: 'MyAppointmentsIntent', slots: {} } } }, null, 2);
      res.type('html').send(page('Test login ready', '<p>Signed in as <strong>' + esc(ps.docs[0].data().name) + '</strong>. Valid for one hour.</p><p><small>Paste this into the simulator Manual JSON tab. Change the intent name to test others, e.g. BookAppointmentIntent.</small></p><textarea style="width:100%;height:320px;background:#0d1a30;color:#cfe8ff;border:1px solid #2d4068;border-radius:12px;padding:12px;font:12px monospace">' + esc(json) + '</textarea>'));
    } catch (e) { console.error('test-token error:', e); res.status(500).type('html').send(testForm('Something went wrong.')); }
  });

  // ---------- proving a request really came from Amazon ----------
  const certCache = new Map();
  async function verifyFromAmazon(req) {
    const url = req.headers['signaturecertchainurl'], sig256 = req.headers['signature-256'], sig1 = req.headers['signature'];
    if (!url || !(sig256 || sig1) || !req.rawBody) return 'missing signature headers';
    let u; try { u = new URL(url); } catch (e) { return 'bad cert url'; }
    if (u.protocol !== 'https:' || u.hostname.toLowerCase() !== 's3.amazonaws.com' || !u.pathname.startsWith('/echo.api/') || (u.port && u.port !== '443')) return 'cert url not allowed';
    let pems = certCache.get(url);
    if (!pems || pems.at < Date.now() - 6 * 3600e3) {
      const r = await fetch(url); if (!r.ok) return 'could not fetch cert';
      pems = { at: Date.now(), list: (await r.text()).match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [] };
      certCache.set(url, pems);
    }
    if (!pems.list.length) return 'no certificate';
    const certs = pems.list.map(p => new crypto.X509Certificate(p)), now = Date.now();
    if (certs.some(c => now < Date.parse(c.validFrom) || now > Date.parse(c.validTo))) return 'certificate not valid now';
    if (!/echo-api\.amazon\.com/i.test(certs[0].subjectAltName || '')) return 'certificate not for Alexa';
    for (let i = 0; i < certs.length - 1; i++) if (!certs[i].verify(certs[i + 1].publicKey)) return 'broken certificate chain';
    const v = crypto.createVerify(sig256 ? 'RSA-SHA256' : 'RSA-SHA1').update(req.rawBody);
    if (!v.verify(certs[0].publicKey, sig256 || sig1, 'base64')) return 'bad signature';
    const ts = Date.parse((req.body && req.body.request && req.body.request.timestamp) || '');
    if (!ts || Math.abs(now - ts) > 150000) return 'stale request';
    return null;
  }

  // ---------- voice helpers ----------
  const say = (text, o) => {
    o = o || {};
    const out = { version: '1.0', sessionAttributes: o.attrs || {}, response: { outputSpeech: { type: 'PlainText', text }, shouldEndSession: !!o.end } };
    if (o.reprompt) out.response.reprompt = { outputSpeech: { type: 'PlainText', text: o.reprompt } };
    if (o.card) out.response.card = o.card;
    return out;
  };
  const dayWords = d => {
    const t = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10), tm = new Date(Date.now() + 29.5 * 3600e3).toISOString().slice(0, 10);
    if (d === t) return 'today'; if (d === tm) return 'tomorrow';
    return new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  };
  const slotStartMin = label => { const m = String(label || '').match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i); if (!m) return null; let h = +m[1]; const mi = +m[2], ap = (m[3] || '').toUpperCase(); if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; return h * 60 + mi; };
  const speakSlot = label => String(label || '').replace(/\s*[–-]\s*.*/, '').replace(/^0/, '');
  const ISTtoday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const slotVal = (intent, n) => { const s = intent && intent.slots && intent.slots[n]; return s && s.value ? s.value : ''; };
  const findDoctor = (list, spoken) => {
    const w = String(spoken || '').toLowerCase().replace(/\b(doctor|dr\.?|mister|mr|ms|mrs)\b/g, ' ').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (!w.length) return null;
    let best = null, score = 0;
    list.forEach(d => { const n = String(d.name || '').toLowerCase().replace(/[^a-z\s]/g, ' '); const sc = w.filter(x => n.includes(x)).length; if (sc > score) { score = sc; best = d; } });
    return score ? best : null;
  };

  // ---------- the skill ----------
  async function handle(body) {
    const req = body.request || {}, session = body.session || {}, attrs = Object.assign({}, session.attributes || {});
    const token = session.user && session.user.accessToken;
    if (req.type === 'SessionEndedRequest') return { version: '1.0', response: {} };
    if (!token) return say('To use MediFlow, please link your account in the Alexa app. I have sent a card there.', { end: true, card: { type: 'LinkAccount' } });
    const db = getAdminDb(); if (!db) return say('MediFlow is not available right now. Please try again later.', { end: true });
    const tk = await db.collection('alexaTokens').doc(sha(token)).get();
    if (!tk.exists || tk.data().expiresAt < Date.now()) return say('Your MediFlow link has expired. Please link your account again in the Alexa app.', { end: true, card: { type: 'LinkAccount' } });
    const { hospitalId, patientDocId } = tk.data();
    const ps = await db.collection('hospitals/' + hospitalId + '/patients').doc(patientDocId).get();
    if (!ps.exists) return say('I could not find your patient record. Please link your account again.', { end: true, card: { type: 'LinkAccount' } });
    const patient = Object.assign({ docId: ps.id }, ps.data());
    const first = String(patient.name || '').split(' ')[0] || 'there';
    const tool = (name, args) => execWaTool(db, hospitalId, patient, name, args || {});

    if (req.type === 'LaunchRequest') return say('Welcome to MediFlow, ' + first + '. You can book an appointment, hear your appointments, cancel one, ask for your token, or ask about hospital timings. What would you like to do?', { reprompt: 'You can say, book an appointment.', attrs: {} });
    if (req.type !== 'IntentRequest') return say('Sorry, I did not get that.', { end: true });
    const intent = req.intent || {}, name = intent.name;

    // ---- yes / no for a pending action
    if (name === 'AMAZON.YesIntent' || name === 'AMAZON.NoIntent') {
      const yes = name === 'AMAZON.YesIntent';
      if (attrs.st === 'confirm_book' && yes) {
        const r = await tool('book_appointment', { doctorId: attrs.docId, date: attrs.date, slotId: attrs.slotId, appointmentType: 'offline' });
        if (r && r.ok) return say('Done. Your appointment with ' + attrs.docName + ' is booked for ' + dayWords(attrs.date) + ' at ' + speakSlot(r.time || attrs.slotLabel) + '. Your token number is ' + r.token + '. I have also sent you a message.', { end: true });
        return say((r && r.error) || 'Sorry, I could not book that slot. It may have just filled up. Would you like to try another time?', { attrs: { st: 'pick_slot_again', docId: attrs.docId, docName: attrs.docName, date: attrs.date }, reprompt: 'Say book an appointment to try again.' });
      }
      if (attrs.st === 'confirm_cancel' && yes) {
        await tool('cancel_appointment', { appointmentId: attrs.apptId });
        return say('Okay. I have cancelled your appointment with ' + attrs.docName + ' on ' + dayWords(attrs.date) + '.', { end: true });
      }
      if (!yes && (attrs.st === 'confirm_book' || attrs.st === 'confirm_cancel')) return say('Okay, I have not changed anything. Is there anything else?', { reprompt: 'You can say book an appointment, or stop.' });
      return say('What would you like to do?', { reprompt: 'You can say book an appointment, or my appointments.' });
    }

    if (name === 'PrescriptionIntent') {
      const r = await tool('get_prescription', {});
      if (!r || r.found === false) return say((r && r.note) || 'I could not find a completed prescription for you.', { end: true });
      const meds = (r.medicines || []).slice(0, 6);
      const list = meds.length ? meds.map(m => [m.name, m.whenToTake, m.withFood, m.duration].filter(Boolean).join(', ')).join('. ') : 'No medicines were written on that visit.';
      return say('Your latest prescription from ' + (r.doctorName || 'your doctor') + (r.date ? ' on ' + dayWords(String(r.date).slice(0, 10)) : '') + ' has ' + (meds.length || 0) + ' medicine' + (meds.length === 1 ? '' : 's') + '. ' + list + '. The full prescription is on your phone in the MediFlow app.', { end: true });
    }
    if (name === 'BillIntent') {
      const r = await tool('get_bill', {});
      if (!r || r.found === false) return say((r && r.note) || 'You have no bills on file.', { end: true });
      return say('Your latest bill is ' + r.amount + ' rupees' + (r.purpose ? ' for ' + String(r.purpose).replace(/_/g, ' ') : '') + ', and it is ' + (r.paid ? 'paid' : 'not paid yet') + '. You can see it in the MediFlow app.', { end: true });
    }
    if (name === 'AMAZON.HelpIntent' || name === 'AMAZON.FallbackIntent')
      return say('You can say: book an appointment, my appointments, cancel my appointment, what is my token, hospital timings, or where is my medicine order. What would you like?', { reprompt: 'What would you like to do?' });
    if (name === 'AMAZON.StopIntent' || name === 'AMAZON.CancelIntent') return say('Take care. Goodbye.', { end: true });

    // ---- read-only questions
    if (name === 'MyAppointmentsIntent') {
      const r = await tool('get_my_appointments');
      const list = ((r && r.appointments) || []).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      if (!list.length) return say('You have no upcoming appointments. Would you like to book one?', { reprompt: 'Say book an appointment.' });
      const parts = list.slice(0, 3).map(a => dayWords(String(a.date).slice(0, 10)) + ' at ' + speakSlot(a.time) + ' with ' + a.doctorName);
      return say('You have ' + (list.length === 1 ? 'one appointment: ' : list.length + ' appointments. The next ones are: ') + parts.join('; then ') + '.', { end: true });
    }
    if (name === 'MyTokenIntent') {
      const r = await tool('get_my_appointments'), t = ISTtoday();
      const today = ((r && r.appointments) || []).filter(a => String(a.date).slice(0, 10) === t);
      if (!today.length) return say('You have no appointment today.', { end: true });
      const a = today[0]; return say('Your token today is number ' + a.token + ', with ' + a.doctorName + ' at ' + speakSlot(a.time) + '.', { end: true });
    }
    if (name === 'HospitalInfoIntent') {
      const hs = await db.collection('hospitals').doc(hospitalId).get(), h = hs.exists ? hs.data() : {};
      const bits = [(h.name || 'Your hospital')];
      if (h.opdTimings) bits.push('OPD timings are ' + h.opdTimings); if (h.address1) bits.push('The address is ' + [h.address1, h.address2].filter(Boolean).join(', ')); if (h.phone) bits.push('The phone number is ' + String(h.phone).split('').join(' '));
      return say(bits.join('. ') + '.', { end: true });
    }
    if (name === 'DoctorsIntent') {
      // Doctors who have checked in today (attendance), not every doctor on file. Lists all of them.
      const r = await tool('list_doctors'), all = (r && r.doctors) || [];
      const att = await db.collection('hospitals/' + hospitalId + '/attendance').where('date', '==', ISTtoday()).get();
      const here = new Set(att.docs.map(d => d.data().doctorId));
      const present = all.filter(d => here.has(d.doctorId));
      if (!all.length) return say('I could not find any doctors right now.', { end: true });
      if (!present.length) return say('No doctor has checked in yet today. Please try again later, or ask for a different day.', { end: true });
      const names = present.map(d => 'Doctor ' + String(d.name || '').replace(/^Dr.?s*/i, '') + (d.specialization ? ', ' + d.specialization : ''));
      return say(present.length + (present.length === 1 ? ' doctor is' : ' doctors are') + ' available today: ' + names.join('; ') + '.', { end: true });
    }
    if (name === 'OrderStatusIntent') {
      const r = await tool('get_order_status');
      if (!r || r.found === false || !(r.orders || []).length) return say((r && r.note) || 'You have no medicine orders right now.', { end: true });
      const o = r.orders[0];
      return say('Your latest medicine order is ' + String(o.status || 'being processed') + '.' + (o.deliveryPersonName ? ' ' + o.deliveryPersonName + ' is delivering it.' : '') + (o.deliveryCode ? ' Your delivery code is ' + String(o.deliveryCode).split('').join(' ') + '.' : ''), { end: true });
    }

    // ---- cancel
    if (name === 'CancelAppointmentIntent') {
      const r = await tool('get_my_appointments');
      const list = ((r && r.appointments) || []).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      if (!list.length) return say('You have no upcoming appointments to cancel.', { end: true });
      const a = list[0];
      return say('Your next appointment is ' + dayWords(String(a.date).slice(0, 10)) + ' at ' + speakSlot(a.time) + ' with ' + a.doctorName + '. Do you want me to cancel it?', { attrs: { st: 'confirm_cancel', apptId: a.appointmentId, docName: a.doctorName, date: String(a.date).slice(0, 10) }, reprompt: 'Should I cancel it? Say yes or no.' });
    }

    // ---- booking (a short spoken dialog: doctor -> day -> time -> confirm)
    if (name === 'BookAppointmentIntent' || name === 'ChooseSlotIntent') {
      const docs = ((await tool('list_doctors')) || {}).doctors || [];
      if (!docs.length) return say('There are no doctors available to book right now.', { end: true });
      let docId = attrs.docId, docName = attrs.docName, date = slotVal(intent, 'date') || attrs.date;
      const spoken = slotVal(intent, 'doctorName');
      if (spoken) { const d = findDoctor(docs, spoken); if (d) { docId = d.doctorId; docName = d.name; } else return say('I could not find a doctor called ' + spoken + '. Our doctors are ' + docs.slice(0, 4).map(d => d.name).join(', ') + '. Which one would you like?', { attrs: { st: 'pick_doctor', date }, reprompt: 'Which doctor would you like?' }); }
      if (!docId) { if (docs.length === 1) { docId = docs[0].doctorId; docName = docs[0].name; } }
      if (!docId) return say('Which doctor would you like? We have ' + docs.slice(0, 4).map(d => d.name + (d.specialization ? ', ' + d.specialization : '')).join('; ') + '.', { attrs: { st: 'pick_doctor', date }, reprompt: 'Please say the doctor\'s name.' });
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return say('For which day? You can say today, tomorrow, or a date.', { attrs: { st: 'pick_date', docId, docName }, reprompt: 'Which day would you like?' });
      if (date < ISTtoday()) return say('That date has passed. Please tell me a day from today onwards.', { attrs: { st: 'pick_date', docId, docName }, reprompt: 'Which day would you like?' });
      const sl = await tool('get_available_slots', { doctorId: docId, date });
      if (sl && sl.doctorPresentToday === false) return say(docName + ' has not checked in yet today, so today\'s slots are not open. Try tomorrow, or ask again later.', { end: true });
      let open = ((sl && sl.slots) || []).filter(s => s.booked < s.limit);
      if (date === ISTtoday()) { const nowMin = new Date(Date.now() + 5.5 * 3600e3).getUTCHours() * 60 + new Date(Date.now() + 5.5 * 3600e3).getUTCMinutes(); open = open.filter(s => { const m = slotStartMin(s.label); return m == null || m > nowMin; }); }
      if (!open.length) return say(docName + ' has no free slots ' + dayWords(date) + '. Would you like to try another day?', { attrs: { st: 'pick_date', docId, docName }, reprompt: 'Which other day would you like?' });
      // a spoken time, or a choice among the offered slots
      const wantTime = slotVal(intent, 'time');
      let chosen = null;
      const pick = attrs.st === 'pick_slot' && Array.isArray(attrs.slots) ? attrs.slots : null;
      const ord = slotVal(intent, 'ordinal') || slotVal(intent, 'choice');
      if (pick && ord) { const n = parseInt(ord, 10); const idx = (n >= 1 && n <= pick.length) ? n - 1 : -1; if (idx >= 0) chosen = open.find(s => s.slotId === pick[idx].slotId) || null; }
      if (!chosen && wantTime && /^\d{1,2}:\d{2}/.test(wantTime)) { const [h, m] = wantTime.split(':').map(Number), want = h * 60 + m; chosen = open.map(s => ({ s, m: slotStartMin(s.label) })).filter(x => x.m != null && x.m >= want).sort((a, b) => a.m - b.m).map(x => x.s)[0] || null; if (!chosen) return say('Nothing is free after ' + wantTime + ' ' + dayWords(date) + '. The earliest free time is ' + speakSlot(open[0].label) + '. Should I look at that?', { attrs: { st: 'pick_slot', docId, docName, date, slots: open.slice(0, 3).map(s => ({ slotId: s.slotId, label: s.label })) }, reprompt: 'Say first to take it, or choose another day.' }); }
      if (!chosen) {
        const offer = open.slice(0, 3);
        return say(docName + ' has these times ' + dayWords(date) + ': ' + offer.map((s, i) => (['first', 'second', 'third'][i]) + ', ' + speakSlot(s.label)).join('; ') + '. Which one would you like?', { attrs: { st: 'pick_slot', docId, docName, date, slots: offer.map(s => ({ slotId: s.slotId, label: s.label })) }, reprompt: 'Say first, second or third.' });
      }
      return say('Shall I book ' + docName + ' ' + dayWords(date) + ' at ' + speakSlot(chosen.label) + '?', { attrs: { st: 'confirm_book', docId, docName, date, slotId: chosen.slotId, slotLabel: chosen.label }, reprompt: 'Should I book it? Say yes or no.' });
    }
    return say('Sorry, I did not understand. You can say book an appointment, or my appointments.', { reprompt: 'What would you like to do?' });
  }

  app.post('/api/alexa', async (req, res) => {
    try {
      const bad = await verifyFromAmazon(req);
      if (bad) { console.warn('alexa request rejected:', bad); return res.status(400).json({ error: bad }); }
      const wantId = process.env.ALEXA_SKILL_ID, got = req.body && ((req.body.session && req.body.session.application && req.body.session.application.applicationId) || (req.body.context && req.body.context.System && req.body.context.System.application && req.body.context.System.application.applicationId));
      if (wantId && got !== wantId) return res.status(403).json({ error: 'wrong skill' });
      res.json(await handle(req.body));
    } catch (e) { console.error('alexa error:', e); res.json({ version: '1.0', response: { outputSpeech: { type: 'PlainText', text: 'Sorry, something went wrong with MediFlow. Please try again.' }, shouldEndSession: true } }); }
  });
  return { handle };
};
