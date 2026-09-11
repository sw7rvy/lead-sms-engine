const fs = require('fs');
const path = require('path');

const SUPA = 'https://uhfeehdwxbzdxvltjxbx.supabase.co';

const CRED = {
  supabase: { supabaseApi: { id: 'REPLACE_SUPABASE_CRED_ID', name: 'Supabase account' } },
  openai: { openAiApi: { id: 'REPLACE_OPENAI_CRED_ID', name: 'OpenAi account' } },
  twilio: { twilioApi: { id: 'REPLACE_TWILIO_CRED_ID', name: 'Twilio account' } },
  imap: { imap: { id: 'REPLACE_IMAP_CRED_ID', name: 'IMAP account' } },
  sheets: { googleSheetsOAuth2Api: { id: 'REPLACE_GSHEETS_CRED_ID', name: 'Google Sheets account' } },
};

const supaAuth = {
  authentication: 'predefinedCredentialType',
  nodeCredentialType: 'supabaseApi',
};

const RESILIENT = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, alwaysOutputData: false, onError: 'continueErrorOutput' };

/* ------------------------------------------------------------------ */
/* Code node bodies                                                     */
/* ------------------------------------------------------------------ */

const CODE_EXTRACT_CLIENT = `
// MODULE 1 :: Flatten a Typeform submission into a client_configs row.
const body = $json.body || $json;
const fr = body.form_response || body;

function toE164(v) {
  if (!v) return null;
  const digits = String(v).replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (String(v).trim().charAt(0) === '+') return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  return '+' + digits;
}

function answerValue(a) {
  if (a.text !== undefined) return a.text;
  if (a.email !== undefined) return a.email;
  if (a.phone_number !== undefined) return a.phone_number;
  if (a.url !== undefined) return a.url;
  if (a.number !== undefined) return a.number;
  if (a.boolean !== undefined) return a.boolean;
  if (a.date !== undefined) return a.date;
  if (a.choice && a.choice.label !== undefined) return a.choice.label;
  if (a.choices && Array.isArray(a.choices.labels)) return a.choices.labels.join(', ');
  return null;
}

let flat = {};
if (Array.isArray(fr.answers)) {
  for (const a of fr.answers) {
    const ref = a.field && (a.field.ref || a.field.id);
    if (ref) flat[ref] = answerValue(a);
  }
}
// Hidden fields win over answer refs, direct JSON posts win over both.
flat = Object.assign({}, flat, (fr.hidden || {}), (fr.answers ? {} : body));

function pick(keys, fallback) {
  for (const k of keys) {
    if (flat[k] !== undefined && flat[k] !== null && flat[k] !== '') return flat[k];
  }
  return fallback === undefined ? null : fallback;
}

let businessHours = pick(['business_hours', 'businessHours'], null);
if (typeof businessHours === 'string') {
  try { businessHours = JSON.parse(businessHours); }
  catch (e) { businessHours = { raw: businessHours }; }
}
if (!businessHours) {
  businessHours = { mon_fri: '09:00-17:00', sat: 'closed', sun: 'closed' };
}

const eventTypeIdRaw = pick(['event_type_id', 'eventTypeId']);
const profile = {
  client_id: pick(['client_id', 'clientId']),
  business_name: pick(['business_name', 'businessName']),
  twilio_phone_number: toE164(pick(['twilio_phone_number', 'twilioPhoneNumber', 'twilio_number'])),
  calcom_api_key: pick(['calcom_api_key', 'calcomApiKey', 'cal_api_key']),
  event_type_id: eventTypeIdRaw === null ? null : Number(eventTypeIdRaw),
  system_prompt_rules: pick(['system_prompt_rules', 'systemPromptRules', 'rules'], ''),
  google_sheet_id: pick(['google_sheet_id', 'googleSheetId', 'sheet_id']),
  business_hours: businessHours,
  timezone: pick(['timezone', 'tz'], 'America/New_York'),
  notification_email: pick(['notification_email', 'email']),
  status: 'active',
  onboarded_via: 'typeform',
  typeform_response_id: (fr.token || body.event_id || null),
  updated_at: new Date().toISOString(),
};

const REQUIRED = ['client_id', 'business_name', 'twilio_phone_number', 'calcom_api_key', 'event_type_id', 'google_sheet_id'];
const missing = REQUIRED.filter((k) => profile[k] === null || profile[k] === undefined || profile[k] === '' || (k === 'event_type_id' && Number.isNaN(profile[k])));
if (missing.length) {
  throw new Error('Onboarding payload rejected - missing/invalid fields: ' + missing.join(', '));
}

return [{ json: profile }];
`.trim();

const CODE_NORMALIZE = `
// MODULE 3.1 :: Unify Voice / Email / Web-Form payloads into one lead schema.
function toE164(v) {
  if (!v) return null;
  const raw = String(v).trim();
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (raw.charAt(0) === '+') return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  return '+' + digits;
}

function firstPhoneIn(text) {
  if (!text) return null;
  const m = String(text).match(/(\\+?\\d[\\d\\-\\.\\(\\)\\s]{8,}\\d)/);
  return m ? toE164(m[1]) : null;
}

function clean(s, max) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\\s+/g, ' ').trim().slice(0, max || 1500);
}

const out = [];

for (const item of $input.all()) {
  const j = item.json || {};
  const b = j.body || j;
  let norm = null;

  // ---- Entry D: Twilio inbound SMS (lead replies / multi-turn) -------
  if (b.MessageSid || b.SmsMessageSid || (b.Body !== undefined && b.From && b.To && !b.CallSid)) {
    const numMedia = Number(b.NumMedia || 0);
    const bodyText = clean(b.Body, 1500);
    norm = {
      channel_source: 'sms',
      lead_phone: toE164(b.From),
      client_phone: toE164(b.To),
      lead_name: null,
      lead_email: null,
      raw_message: (bodyText || '(no text)') + (numMedia > 0 ? ' [lead attached ' + numMedia + ' media file(s)]' : ''),
      client_id_or_number: toE164(b.To),
      client_id: null,
      external_id: b.MessageSid || b.SmsMessageSid || null,
    };
  }

  // ---- Entry A: Twilio voice status callback ------------------------
  else if (b.CallSid || b.CallStatus) {
    const duration = Number(b.CallDuration || b.Duration || 0);
    norm = {
      channel_source: 'missed_call',
      lead_phone: toE164(b.From),
      client_phone: toE164(b.To),
      lead_name: clean(b.CallerName || b.FromCity ? (b.CallerName || 'Caller from ' + b.FromCity) : 'Unknown Caller', 120),
      lead_email: null,
      raw_message: 'Inbound call not answered. status=' + (b.CallStatus || 'unknown') + ' duration=' + duration + 's',
      client_id_or_number: toE164(b.To),
      client_id: null,
      external_id: b.CallSid || null,
    };
  }

  // ---- Entry B: IMAP lead-notification email ------------------------
  else if (b.from !== undefined || b.subject !== undefined || b.textPlain !== undefined) {
    const fromRaw = typeof b.from === 'object' && b.from !== null
      ? (b.from.text || (Array.isArray(b.from.value) && b.from.value[0] ? b.from.value[0].address : ''))
      : (b.from || '');
    const bodyText = b.textPlain || b.text || b.textHtml || '';
    const nameMatch = String(fromRaw).match(/^\\s*"?([^"<]+?)"?\\s*</);
    norm = {
      channel_source: 'email',
      lead_phone: firstPhoneIn(bodyText) || firstPhoneIn(b.subject),
      client_phone: null,
      lead_name: clean(nameMatch ? nameMatch[1] : (b.leadName || String(fromRaw).split('@')[0]), 120) || 'Email Lead',
      lead_email: (String(fromRaw).match(/[\\w.+-]+@[\\w-]+\\.[\\w.-]+/) || [null])[0],
      raw_message: clean(clean(b.subject, 200) + ' :: ' + bodyText, 1500),
      client_id_or_number: b.client_id || (Array.isArray(b.to && b.to.value) && b.to.value[0] ? b.to.value[0].address : null),
      client_id: b.client_id || null,
      external_id: b.messageId || b.uid || null,
    };
  }

  // ---- Entry C: Website form / widget --------------------------------
  else {
    norm = {
      channel_source: clean(b.source || 'web_form', 40),
      lead_phone: toE164(b.phone || b.phone_number || b.tel),
      client_phone: toE164(b.client_phone || b.twilio_phone_number),
      lead_name: clean(b.name || b.full_name || ((b.first_name || '') + ' ' + (b.last_name || '')), 120) || 'Web Lead',
      lead_email: b.email || null,
      raw_message: clean(b.message || b.notes || b.comments || b.service || 'New website enquiry', 1500),
      client_id_or_number: b.client_id || toE164(b.client_phone || b.twilio_phone_number),
      client_id: b.client_id || null,
      external_id: b.submission_id || null,
    };
  }

  // Secret presented by web-form intake. Verified against the tenant's
  // webhook_secret after the config fetch - the tenant is not known yet here.
  norm.presented_secret = (b.secret || b.token || b.webhook_secret || null);
  norm.received_at = new Date().toISOString();
  norm.n8n_execution_id = $execution.id;
  // Set by MODULE 6 only; 0 for every genuine inbound lead.
  norm.followup_step = Number(b.followup_step || 0);

  if (!norm.lead_phone) {
    // No reachable SMS number -> nothing for Module 4 to do. Fail loudly.
    throw new Error('Lead from channel "' + norm.channel_source + '" has no resolvable phone number. Payload: ' + JSON.stringify(b).slice(0, 400));
  }
  if (!norm.client_id_or_number) {
    throw new Error('Cannot resolve tenant for lead ' + norm.lead_phone + ' (channel ' + norm.channel_source + ').');
  }

  out.push({ json: norm });
}

return out;
`.trim();

const CODE_BUILD_MESSAGES = `
// MODULE 4.2 :: Assemble the OpenAI Chat Completions payload.
const cfg = $('Fetch Client Config').first().json;
const lead = $('Normalize Lead Payload').first().json;

const history = $input.all()
  .map((i) => i.json)
  .filter((r) => r && (r.role === 'user' || r.role === 'assistant') && r.content)
  .slice(-20)
  .map((r) => ({ role: r.role, content: String(r.content).slice(0, 1000) }));

const turnCount = history.filter((m) => m.role === 'assistant').length;
const bookingLink = 'https://cal.com/' + (cfg.calcom_username || String(cfg.business_name || 'booking').toLowerCase().replace(/[^a-z0-9]+/g, '-')) + '?duration=30';

const nowIso = new Date().toISOString();
const hours = typeof cfg.business_hours === 'string' ? cfg.business_hours : JSON.stringify(cfg.business_hours || {});

const system = [
  'You are the SMS booking assistant for ' + (cfg.business_name || 'the business') + '.',
  'Current UTC time: ' + nowIso + '. Business timezone: ' + (cfg.timezone || 'America/New_York') + '.',
  'Business hours (JSON): ' + hours,
  'Booking link if the lead prefers self-service: ' + bookingLink,
  '',
  'CLIENT RULES (authoritative, follow exactly):',
  String(cfg.system_prompt_rules || 'Qualify the lead, then book an appointment.'),
  '',
  'OBJECTIVES, in order:',
  '1. Qualify the lead against the client rules above (service needed, urgency, location/budget if the rules require it).',
  '2. Once qualified, propose a concrete appointment slot inside business hours. Never invent slots outside them.',
  '3. When the lead accepts a specific date AND time, confirm it and set booking_intent to "confirmed".',
  '4. Collect an email address before confirming - the calendar booking requires it.',
  '',
  'STYLE: friendly, direct, human. No emoji spam, no corporate filler, never say you are an AI.',
  'Keep "reply" under 160 characters whenever possible; 320 is the hard limit.',
  'This is turn ' + (turnCount + 1) + ' of the conversation. Do not repeat questions already answered above.',
  '',
  'OUTPUT: respond with a single JSON object and nothing else:',
  '{',
  '  "reply": "the SMS text to send",',
  '  "qualified": true|false,',
  '  "booking_intent": "none" | "proposed" | "confirmed",',
  '  "booking_start": "ISO-8601 datetime with offset, or null",',
  '  "duration_minutes": 30,',
  '  "lead_name": "best known name or null",',
  '  "lead_email": "best known email or null",',
  '  "notes": "short internal summary of the lead for the CRM"',
  '}',
  'booking_start MUST be null unless booking_intent is "confirmed".',
].join('\\n');

const messages = [{ role: 'system', content: system }];

const cadence = Array.isArray(cfg.followup_cadence_hours) && cfg.followup_cadence_hours.length
  ? cfg.followup_cadence_hours
  : [2, 24, 72];

if (lead.channel_source === 'followup') {
  // MODULE 6 re-engagement: the lead never replied, so there is no new user turn.
  const step = Number(lead.followup_step || 0);
  const attempt = step + 1;
  const isFinal = attempt >= cadence.length;
  messages.push(...history);
  messages.push({
    role: 'system',
    content: [
      'RE-ENGAGEMENT TURN. The lead has not replied to your last message.',
      'This is follow-up attempt ' + attempt + ' of ' + cadence.length + '.',
      'Write ONE short SMS that references the specific thing they enquired about,',
      'gives a concrete reason to reply now (a named slot, or the booking link), and stays under 160 characters.',
      'Do NOT open with "Just following up" or "Checking in". Do NOT repeat any earlier message.',
      'Never mention automation, reminders, or that this is a follow-up.',
      isFinal
        ? 'This is the FINAL attempt: close warmly, leave the door open, do not ask a new qualifying question.'
        : 'Keep it light - one easy question or one concrete slot to accept.',
      'booking_intent MUST be "none" or "proposed". It can never be "confirmed" here, because the lead has not responded.',
    ].join(' '),
  });
} else if (history.length === 0) {
  messages.push({
    role: 'user',
    content: 'INBOUND LEAD (' + lead.channel_source + ') from ' + lead.lead_phone +
      '. Name: ' + (lead.lead_name || 'unknown') +
      '. Email: ' + (lead.lead_email || 'unknown') +
      '. Context: ' + lead.raw_message +
      '. Open the conversation - acknowledge the enquiry and start qualifying.',
  });
} else {
  messages.push(...history);
  messages.push({ role: 'user', content: String(lead.raw_message || '(no message body)') });
}

return [{
  json: {
    model: 'gpt-4o-mini',
    temperature: 0.4,
    max_tokens: 400,
    response_format: { type: 'json_object' },
    messages,
    _meta: {
      client_id: cfg.client_id,
      lead_phone: lead.lead_phone,
      turn: turnCount + 1,
      history_len: history.length,
      booking_link: bookingLink,
    },
  },
}];
`.trim();

const CODE_PARSE_AI = `
// MODULE 4.4 :: Parse + harden the model output before it touches Twilio.
const cfg = $('Fetch Client Config').first().json;
const lead = $('Normalize Lead Payload').first().json;
const meta = $('Build OpenAI Messages').first().json._meta || {};

// $json is only defined in runOnceForEachItem mode; this node runs over all items.
const first = $input.first();
const resp = (first && first.json) || {};
const choice = (resp.choices && resp.choices[0]) || {};
const raw = (choice.message && choice.message.content) || '';

let ai;
try {
  ai = JSON.parse(raw);
} catch (e) {
  const m = String(raw).match(/\\{[\\s\\S]*\\}/);
  try { ai = JSON.parse(m ? m[0] : '{}'); } catch (e2) { ai = {}; }
}

let reply = String(ai.reply || '').replace(/\\s+/g, ' ').trim();
if (!reply) {
  reply = 'Thanks for reaching out to ' + (cfg.business_name || 'us') + '! What can we help you with, and when works best for you?';
}
if (reply.length > 320) reply = reply.slice(0, 317).trim() + '...';

const intent = ['none', 'proposed', 'confirmed'].includes(ai.booking_intent) ? ai.booking_intent : 'none';
let start = ai.booking_start || null;
if (start) {
  const d = new Date(start);
  if (isNaN(d.getTime()) || d.getTime() < Date.now() - 60000) start = null;
}
let bookingIntent = (intent === 'confirmed' && start) ? 'confirmed' : (intent === 'confirmed' ? 'proposed' : intent);

// A re-engagement nudge can never confirm a booking - the lead has not answered.
if (lead.channel_source === 'followup' && bookingIntent === 'confirmed') {
  bookingIntent = 'proposed';
  start = null;
}

const leadEmail = ai.lead_email || lead.lead_email || null;

return [{
  json: {
    client_id: cfg.client_id,
    business_name: cfg.business_name,
    twilio_phone_number: cfg.twilio_phone_number,
    calcom_api_key: cfg.calcom_api_key,
    event_type_id: cfg.event_type_id,
    google_sheet_id: cfg.google_sheet_id,
    timezone: cfg.timezone || 'America/New_York',
    followup_cadence_hours: (Array.isArray(cfg.followup_cadence_hours) && cfg.followup_cadence_hours.length) ? cfg.followup_cadence_hours : [2, 24, 72],
    followup_step: Number(lead.followup_step || 0),

    lead_phone: lead.lead_phone,
    client_phone: lead.client_phone || cfg.twilio_phone_number,
    lead_name: ai.lead_name || lead.lead_name || 'Unknown Lead',
    lead_email: leadEmail,
    channel_source: lead.channel_source,
    inbound_message: lead.raw_message,

    reply,
    qualified: ai.qualified === true,
    booking_intent: bookingIntent,
    booking_start: bookingIntent === 'confirmed' ? start : null,
    duration_minutes: Number(ai.duration_minutes || 30),
    // Cal.com rejects an empty string for responses.notes with a 400, so this
    // must never be ''. A terse model answer is not a reason to fail a booking.
    notes: (String(ai.notes || '').trim() || ('Lead via ' + lead.channel_source + '; no summary returned')).slice(0, 500),
    turn: meta.turn || 1,
    booking_link: meta.booking_link || null,
    tokens_used: (resp.usage && resp.usage.total_tokens) || 0,
    // Cal.com cannot book without an email; degrade to "proposed" so the bot keeps asking.
    booking_ready: bookingIntent === 'confirmed' && !!start && !!leadEmail,
  },
}];
`.trim();

const CODE_SHEET_ROW = `
// MODULE 5.3 :: Build the Google Sheets audit row (runs on booked AND pending paths).
const ai = $('Parse AI Response').first().json;

let booking = null;
try {
  const b = $('Cal.com Create Booking').first().json;
  booking = (b && (b.booking || b.data || b)) || null;
  if (booking && booking.error) booking = null;
} catch (e) {
  booking = null;
}

const bookingId = booking ? (booking.uid || booking.id || null) : null;
const bookingTime = booking
  ? (booking.startTime || booking.start || ai.booking_start)
  : (ai.booking_start || '');

// ---- follow-up ladder state --------------------------------------
const isFollowup = ai.channel_source === 'followup';
const cadence = (Array.isArray(ai.followup_cadence_hours) && ai.followup_cadence_hours.length)
  ? ai.followup_cadence_hours
  : [2, 24, 72];

// A genuine reply resets the ladder; a nudge advances it.
const followupCount = isFollowup ? Number(ai.followup_step || 0) + 1 : 0;

let threadStatus = 'nurturing';
let nextFollowupAt = null;
if (bookingId) {
  threadStatus = 'booked';
} else if (followupCount >= cadence.length) {
  threadStatus = 'dead';
} else {
  nextFollowupAt = new Date(Date.now() + Number(cadence[followupCount] || 24) * 3600000).toISOString();
}

const status = bookingId
  ? 'Booked'
  : (ai.booking_intent === 'confirmed' ? 'Booking Failed'
    : (threadStatus === 'dead' ? 'Cold - No Reply'
      : (isFollowup ? 'Nurturing (F/U ' + followupCount + '/' + cadence.length + ')'
        : (ai.qualified ? 'Qualified - Pending' : 'Pending'))));

const notes = [
  ai.notes,
  'Turn ' + ai.turn,
  isFollowup ? 'Re-engagement attempt ' + followupCount : 'Last inbound: ' + String(ai.inbound_message || '').slice(0, 160),
  bookingId ? 'Cal.com uid: ' + bookingId : null,
  nextFollowupAt ? 'Next nudge: ' + nextFollowupAt : 'No further nudges',
].filter(Boolean).join(' | ').slice(0, 900);

const thread = {
  client_id: ai.client_id,
  lead_phone: ai.lead_phone,
  client_phone: ai.client_phone,
  lead_name: ai.lead_name,
  lead_email: ai.lead_email,
  channel_source: isFollowup ? undefined : ai.channel_source,
  status: threadStatus,
  followup_count: followupCount,
  next_followup_at: nextFollowupAt,
  qualified: ai.qualified === true,
  booking_intent: ai.booking_intent,
  booking_uid: bookingId,
  last_outbound_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};
// Omitted keys are left untouched by the PostgREST upsert - a nudge must not
// overwrite last_inbound_at or the channel the lead originally arrived on.
if (!isFollowup) thread.last_inbound_at = new Date().toISOString();
for (const k of Object.keys(thread)) { if (thread[k] === undefined) delete thread[k]; }

return [{
  json: {
    google_sheet_id: ai.google_sheet_id,
    client_id: ai.client_id,
    Timestamp: new Date().toISOString(),
    'Lead Name': ai.lead_name,
    Phone: ai.lead_phone,
    'Source Channel': ai.channel_source,
    Status: status,
    'Booking Time': bookingTime || '',
    Notes: notes,
    _thread: thread,
  },
}];
`.trim();

const CODE_COLD_GATE = `
// MODULE 6.2 :: Cadence + quiet-hours gate. Nothing leaves here that we are
// not legally and contractually allowed to send right now.
const MAX_PER_SWEEP = 10;
const now = new Date();

function tzHour(tz) {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now));
  } catch (e) {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(now));
  }
}
function tzDay(tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now).toLowerCase();
  } catch (e) { return 'mon'; }
}

const due = [];
const skipped = [];

for (const item of $input.all()) {
  const r = item.json || {};
  if (!r.lead_phone || !r.client_id) continue;

  // PostgREST embeds a many-to-one relation as an object; tolerate an array too.
  const cfgRaw = r.client_configs;
  const cfg = Array.isArray(cfgRaw) ? cfgRaw[0] : cfgRaw;
  if (!cfg || !cfg.client_id) { skipped.push([r.lead_phone, 'no client config']); continue; }
  if (cfg.status !== 'active' || cfg.followup_enabled === false) { skipped.push([r.lead_phone, 'client paused']); continue; }
  if (r.status !== 'nurturing') { skipped.push([r.lead_phone, 'thread ' + r.status]); continue; }

  const cadence = (Array.isArray(cfg.followup_cadence_hours) && cfg.followup_cadence_hours.length)
    ? cfg.followup_cadence_hours
    : [2, 24, 72];
  const step = Number(r.followup_count || 0);
  if (step >= cadence.length) { skipped.push([r.lead_phone, 'ladder exhausted']); continue; }

  const tz = cfg.timezone || 'America/New_York';
  const qStart = cfg.quiet_hours_start === null || cfg.quiet_hours_start === undefined ? 8 : Number(cfg.quiet_hours_start);
  const qEnd = cfg.quiet_hours_end === null || cfg.quiet_hours_end === undefined ? 21 : Number(cfg.quiet_hours_end);
  const hour = tzHour(tz);
  if (hour < qStart || hour >= qEnd) { skipped.push([r.lead_phone, 'quiet hours ' + hour + ':00 ' + tz]); continue; }
  if (cfg.followup_skip_weekends === true && ['sat', 'sun'].includes(tzDay(tz))) {
    skipped.push([r.lead_phone, 'weekend']);
    continue;
  }

  const lastOut = r.last_outbound_at ? new Date(r.last_outbound_at) : null;
  const hoursSilent = lastOut ? Math.round((now.getTime() - lastOut.getTime()) / 3600000) : null;

  due.push({
    json: {
      // Shaped for the web-form branch of Normalize Lead Payload - one code path, no duplication.
      source: 'followup',
      client_id: r.client_id,
      client_phone: r.client_phone || cfg.twilio_phone_number,
      phone: r.lead_phone,
      name: r.lead_name || null,
      email: r.lead_email || null,
      followup_step: step,
      message: 'RE-ENGAGEMENT TRIGGER: attempt ' + (step + 1) + ' of ' + cadence.length +
        (hoursSilent === null ? '.' : ('. Lead has been silent for ~' + hoursSilent + 'h.')),
      _sort: r.next_followup_at || r.last_outbound_at || '',
    },
  });
}

due.sort((a, b) => String(a.json._sort).localeCompare(String(b.json._sort)));
const batch = due.slice(0, MAX_PER_SWEEP);

console.log('cold sweep: ' + batch.length + ' due / ' + due.length + ' eligible / ' + skipped.length + ' skipped');
if (skipped.length) console.log('skip reasons: ' + JSON.stringify(skipped.slice(0, 20)));

return batch;
`.trim();

const CODE_NON_ACTIONABLE_SMS = `
// Compliance: a dropped inbound SMS may still be an opt-out or an opt-in.
// Everything else (empty body, HELP, INFO) needs no state change.
// $json is only defined in runOnceForEachItem mode; this node runs over all items.
const src = ($input.first() || { json: {} }).json || {};
const b = src.body || src;
const kw = String(b.Body || '').trim().toLowerCase().replace(/[^a-z]/g, '');

const OPT_OUT = ['stop', 'stopall', 'unsubscribe', 'cancel', 'quit', 'end', 'revoke', 'optout'];
const OPT_IN = ['start', 'unstop'];

if (!OPT_OUT.includes(kw) && !OPT_IN.includes(kw)) return [];

function toE164(v) {
  if (!v) return null;
  const raw = String(v).trim();
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (raw.charAt(0) === '+') return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  return '+' + digits;
}

const optingOut = OPT_OUT.includes(kw);

return [{
  json: {
    lead_phone: toE164(b.From),
    client_phone: toE164(b.To),
    keyword: kw,
    new_status: optingOut ? 'opted_out' : 'nurturing',
    // Re-opt-in restarts the ladder an hour out; opt-out kills it outright.
    next_followup_at: optingOut ? null : new Date(Date.now() + 3600000).toISOString(),
    followup_count: optingOut ? undefined : 0,
    updated_at: new Date().toISOString(),
  },
}];
`.trim();

const CODE_VERIFY_TWILIO = `
// Validates Twilio's X-Twilio-Signature on the voice and SMS webhooks.
//
// Twilio signs: the exact URL it called, then every POST parameter appended as
// key+value in ascending key order, HMAC-SHA1 with the account Auth Token,
// base64. Without this check both endpoints accept a forged From/To and will
// send SMS from the tenant's number to any target the caller picks.
//
// HMAC-SHA1 is implemented here rather than via require('crypto'), which the
// Code node sandbox blocks unless NODE_FUNCTION_ALLOW_BUILTIN is set.

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c < 0xdc00) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function sha1(bytes) {
  const msg = bytes.slice();
  const bitLen = bytes.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  msg.push(0, 0, 0, 0,
    (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Array(80);

  for (let off = 0; off < msg.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16) |
             (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3];
    }
    for (let i = 16; i < 80; i++) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (n << 1) | (n >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = [];
  for (const h of [h0, h1, h2, h3, h4]) out.push((h >>> 24) & 0xff, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff);
  return out;
}

function hmacSha1(keyBytes, msgBytes) {
  let k = keyBytes.slice();
  if (k.length > 64) k = sha1(k);
  while (k.length < 64) k.push(0);
  const inner = [], outer = [];
  for (let i = 0; i < 64; i++) { inner.push(k[i] ^ 0x36); outer.push(k[i] ^ 0x5c); }
  return sha1(outer.concat(sha1(inner.concat(msgBytes))));
}

function base64(bytes) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
    out += A[b0 >> 2];
    out += A[((b0 & 3) << 4) | ((b1 === undefined ? 0 : b1) >> 4)];
    out += b1 === undefined ? '=' : A[((b1 & 15) << 2) | ((b2 === undefined ? 0 : b2) >> 6)];
    out += b2 === undefined ? '=' : A[b2 & 63];
  }
  return out;
}

// Constant-time compare - a length-dependent early return leaks nothing useful
// here, but a byte-wise early return would.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Twilio's guidance is to use their SDK rather than hand-rolled validation.
// The Code sandbox blocks require() unless NODE_FUNCTION_ALLOW_BUILTIN=crypto
// is set on the n8n host, so prefer the real thing and fall back to the
// implementation above when it is unavailable.
function nodeCryptoHmac(authToken, data) {
  try {
    // eslint-disable-next-line
    const c = typeof require === 'function' ? require('crypto') : null;
    if (c && typeof c.createHmac === 'function') {
      return c.createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
    }
  } catch (e) { /* sandbox blocked it; fall through */ }
  return null;
}

function twilioSignature(authToken, url, params) {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + (params[key] === null || params[key] === undefined ? '' : String(params[key]));
  }
  return nodeCryptoHmac(authToken, data) || base64(hmacSha1(utf8Bytes(authToken), utf8Bytes(data)));
}

const cfg = $input.first().json;
const lead = $('Normalize Lead Payload').first().json;
const TWILIO_CHANNELS = ['sms', 'missed_call'];

const result = {
  twilio_signature_checked: false,
  twilio_signature_valid: null,
  twilio_signature_reason: 'not a Twilio channel',
};

if (TWILIO_CHANNELS.includes(lead.channel_source)) {
  // Whichever Twilio webhook fired carries the headers and the raw form body.
  let req = null;
  for (const name of ['Twilio Inbound SMS Webhook', 'Twilio Voice Status Webhook']) {
    try {
      const j = $(name).first().json;
      if (j && j.body && Object.keys(j.body).length) { req = j; break; }
    } catch (e) { /* that webhook did not run in this execution */ }
  }

  if (cfg.twilio_verify_signatures === false) {
    result.twilio_signature_valid = true;
    result.twilio_signature_reason = 'verification disabled for this tenant';
  } else if (!cfg.twilio_auth_token) {
    result.twilio_signature_valid = false;
    result.twilio_signature_reason = 'no twilio_auth_token configured (fail closed)';
  } else if (!req) {
    result.twilio_signature_valid = false;
    result.twilio_signature_reason = 'could not read the originating webhook request';
  } else {
    const headers = req.headers || {};
    const provided = headers['x-twilio-signature'] || headers['X-Twilio-Signature'] || null;
    if (!provided) {
      result.twilio_signature_valid = false;
      result.twilio_signature_reason = 'no X-Twilio-Signature header present';
    } else {
      // Twilio signs the URL it called. Behind a proxy the scheme arrives in
      // x-forwarded-proto; host must be the externally visible one.
      const proto = headers['x-forwarded-proto'] || 'https';
      const host = headers['x-forwarded-host'] || headers.host || '';
      // Derived with string ops rather than a regex: this source passes through
      // a template literal, and the backslashes in an escaped regex do not survive.
      let path;
      if (req.webhookUrl) {
        const u = String(req.webhookUrl);
        const sep = u.indexOf('://');
        const rest = sep >= 0 ? u.slice(sep + 3) : u;
        const slash = rest.indexOf('/');
        path = slash >= 0 ? rest.slice(slash) : '/';
      } else {
        path = lead.channel_source === 'sms' ? '/webhook/twilio-inbound-sms' : '/webhook/twilio-voice-status';
      }
      const url = proto + '://' + host + path;
      const expected = twilioSignature(cfg.twilio_auth_token, url, req.body || {});
      result.twilio_signature_checked = true;
      result.twilio_signature_valid = safeEqual(expected, String(provided));
      result.twilio_signature_reason = result.twilio_signature_valid
        ? 'signature verified'
        : 'signature mismatch for reconstructed url ' + url;
    }
  }
}

// Pass the tenant config straight through; downstream reads it unchanged.
return [{ json: Object.assign({}, cfg, result) }];
`.trim();

const CODE_REJECTED_INTAKE = `
// Public web-form intake presented no secret, or the wrong one. Nothing is sent.
// Logged loudly: repeated hits on one tenant are someone probing the endpoint.
const lead = $('Normalize Lead Payload').first().json;
return [{
  json: {
    workflow_id: $workflow.id,
    workflow_name: $workflow.name,
    execution_id: $execution.id,
    failed_node: 'IF Intake Authorised',
    error_message: 'Rejected web-form intake for tenant "' + lead.client_id_or_number +
      '": ' + (lead.presented_secret ? 'wrong secret presented' : 'no secret presented') +
      '. Target number was ' + lead.lead_phone + '.',
    error_stack: null,
    http_status: 401,
    payload: JSON.stringify({ channel: lead.channel_source, lead_phone: lead.lead_phone, tenant: lead.client_id_or_number }).slice(0, 2000),
    client_id: null,
    lead_phone: lead.lead_phone,
    severity: 'warning',
    created_at: new Date().toISOString(),
  },
}];
`.trim();

const CODE_ERROR = `
// Shared error funnel: node-level error outputs + the global Error Trigger.
// $json is only defined in runOnceForEachItem mode; this node runs over all items.
const j = ($input.first() || { json: {} }).json || {};
const err = j.error || j;
const trig = j.execution || {};

function str(v, n) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') { try { return JSON.stringify(v).slice(0, n || 2000); } catch (e) { return String(v).slice(0, n || 2000); } }
  return String(v).slice(0, n || 2000);
}

let leadPhone = null;
let clientId = null;
try { leadPhone = $('Normalize Lead Payload').first().json.lead_phone; } catch (e) {}
try { clientId = $('Fetch Client Config').first().json.client_id; } catch (e) {}

return [{
  json: {
    workflow_id: $workflow.id,
    workflow_name: $workflow.name,
    execution_id: $execution.id,
    failed_node: (j.node && j.node.name) || err.node || trig.lastNodeExecuted || 'unknown',
    error_message: str(err.message || trig.error && trig.error.message || 'Unknown error', 1000),
    error_stack: str(err.stack || (trig.error && trig.error.stack), 4000),
    http_status: (err.httpCode || err.status || (err.context && err.context.statusCode)) || null,
    payload: str(j, 4000),
    client_id: clientId,
    lead_phone: leadPhone,
    severity: 'error',
    created_at: new Date().toISOString(),
  },
}];
`.trim();

const CODE_UNKNOWN_CLIENT = `
// Tenant resolution miss -> log and halt this branch (no SMS is sent).
const lead = $('Normalize Lead Payload').first().json;
return [{
  json: {
    workflow_id: $workflow.id,
    workflow_name: $workflow.name,
    execution_id: $execution.id,
    failed_node: 'Fetch Client Config',
    error_message: 'No active client_configs row matched "' + lead.client_id_or_number + '" (channel: ' + lead.channel_source + ').',
    error_stack: null,
    http_status: 404,
    payload: JSON.stringify(lead).slice(0, 2000),
    client_id: null,
    lead_phone: lead.lead_phone,
    severity: 'warning',
    created_at: new Date().toISOString(),
  },
}];
`.trim();

/* ------------------------------------------------------------------ */
/* Nodes                                                                */
/* ------------------------------------------------------------------ */

const nodes = [];
const add = (n) => { nodes.push(n); return n; };

const sticky = (name, content, x, y, w, h, color) => add({
  // Note bodies are authored with escaped \n so they stay one line here;
  // n8n needs real newlines to render the markdown.
  parameters: { content: content.replace(/\\n/g, '\n'), height: h, width: w, color },
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name,
  type: 'n8n-nodes-base.stickyNote',
  typeVersion: 1,
  position: [x, y],
});

sticky('Note M1', '## MODULE 1 — Client Onboarding\\nTypeform webhook ➜ normalize ➜ UPSERT `client_configs`.\\nUpsert key: `client_id` (`?on_conflict=client_id`, `Prefer: resolution=merge-duplicates`).', -1720, -760, 520, 260, 4);
sticky('Note M2', '## MODULE 2 — Multi-Channel Intake\\n**A** Twilio voice status (`no-answer` / `busy` / `failed` / `completed`+0s)\\n**B** IMAP lead notifications\\n**C** Public web-form webhook\\n**D** Twilio inbound SMS — closes the multi-turn loop.\\nOpt-out keywords (STOP/CANCEL/HELP…) are dropped\\nbefore they reach OpenAI; Twilio owns that list.\\n\\nAll four fan into one normalizer.', -1720, -300, 700, 1000, 5);
sticky('Note M3', '## MODULE 3 — Normalize + Tenant Resolve\\nUnified schema, then PostgREST lookup on\\n`twilio_phone_number` OR `client_id`.\\nMiss ➜ logged, branch halts (no SMS).', -880, -300, 460, 260, 6);
sticky('Note M4', '## MODULE 4 — Multi-Turn SMS Engine\\nHistory ➜ messages array ➜ GPT-4o-mini (JSON mode)\\n➜ hardened parse ➜ Twilio SMS ➜ persist both turns.', -100, -300, 520, 240, 3);
sticky('Note M5', '## MODULE 5 — Booking + Ledger\\nConfirmed ➜ Cal.com v1 booking (per-tenant API key)\\nAll paths ➜ Google Sheets append.', 1100, -300, 460, 220, 7);
sticky('Note M6', '## MODULE 6 — Cold-Lead Re-Engagement\\nEvery 30 min: pull `lead_threads` where `status=nurturing`\\nand `next_followup_at <= now` (tenant config joined inline).\\n\\n**Gate** enforces quiet hours in the *tenant* timezone\\n(default 08:00–21:00), the per-client cadence ladder\\n(`followup_cadence_hours`, default `{2,24,72}` hours),\\nand a 10-lead cap per sweep.\\n\\n**Loop batch size = 1.** This is load-bearing: the shared\\nModule 4/5 chain uses `.first()` throughout, so exactly one\\nlead may be in flight per pass. `IF Followup Sweep Run`\\nis the guard that keeps webhook traffic out of the loop.\\n\\nLadder exhausted ➜ `status=dead`, no further nudges.', -1720, 1100, 700, 420, 6);
sticky('Note OPTOUT', '## Compliance — STOP / START\\nDropped inbound SMS still updates thread state:\\nSTOP/CANCEL/UNSUBSCRIBE ➜ `opted_out` (nudges cease).\\nSTART/UNSTOP ➜ back to `nurturing`, ladder reset.\\nScoped by lead **and** tenant number, so opting out of\\none client never silences another.', -1720, 700, 700, 260, 3);
sticky('Note ERR', '## ERROR SPINE\\nEvery external call uses `onError: continueErrorOutput`\\n+ 3 retries. Red edges funnel into one normalizer\\nand a Supabase `error_log` insert. The Error Trigger\\ncatches anything that still escapes.', -880, 640, 520, 260, 2);

/* --- MODULE 1 ------------------------------------------------------ */
add({
  parameters: {
    httpMethod: 'POST',
    path: 'client-onboarding',
    responseMode: 'responseNode',
    options: { rawBody: false },
  },
  id: 'typeform-webhook',
  name: 'Typeform Onboarding Webhook',
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position: [-1700, -460],
  webhookId: 'a1b2c3d4-0001-4000-8000-000000000001',
});

add({
  parameters: { mode: 'runOnceForEachItem', jsCode: CODE_EXTRACT_CLIENT.replace('return [{ json: profile }];', 'return { json: profile };') },
  id: 'extract-client-profile',
  name: 'Extract Client Profile',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [-1460, -460],
  onError: 'continueErrorOutput',
});

add({
  parameters: Object.assign({
    method: 'POST',
    url: SUPA + '/rest/v1/client_configs?on_conflict=client_id',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Prefer', value: 'resolution=merge-duplicates,return=representation' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify([$json]) }}',
    options: { response: { response: { neverError: false, responseFormat: 'json' } }, timeout: 15000 },
  }, supaAuth),
  id: 'supabase-upsert-config',
  name: 'Supabase Upsert Client Config',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [-1220, -460],
  credentials: CRED.supabase,
  ...RESILIENT,
});

add({
  parameters: {
    respondWith: 'json',
    responseBody: '={{ JSON.stringify({ ok: true, client_id: $json.client_id, message: "Client configuration saved." }) }}',
    options: { responseCode: 200 },
  },
  id: 'respond-onboarding',
  name: 'Respond Onboarding OK',
  type: 'n8n-nodes-base.respondToWebhook',
  typeVersion: 1.1,
  position: [-980, -460],
});

/* --- MODULE 2 ------------------------------------------------------ */
add({
  parameters: {
    httpMethod: 'POST',
    path: 'twilio-voice-status',
    responseMode: 'onReceived',
    responseData: 'noData',
    options: { rawBody: false },
  },
  id: 'twilio-voice-webhook',
  name: 'Twilio Voice Status Webhook',
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position: [-1700, -40],
  webhookId: 'a1b2c3d4-0002-4000-8000-000000000002',
});

add({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'missed-call-check',
          leftValue: "={{ ['no-answer','busy','failed','canceled'].includes($json.body.CallStatus) || ($json.body.CallStatus === 'completed' && Number($json.body.CallDuration || 0) === 0) }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  },
  id: 'if-missed-call',
  name: 'IF Missed Call',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: [-1460, -40],
});

add({
  parameters: {
    postProcessAction: 'read',
    format: 'simple',
    options: {
      customEmailConfig: '["UNSEEN"]',
      allowUnauthorizedCerts: false,
      forceReconnect: 60,
    },
    downloadAttachments: false,
  },
  id: 'imap-lead-trigger',
  name: 'Email Lead Trigger (IMAP)',
  type: 'n8n-nodes-base.emailReadImap',
  typeVersion: 2,
  position: [-1700, 160],
  credentials: CRED.imap,
  alwaysOutputData: false,
  onError: 'continueRegularOutput',
});

add({
  parameters: {
    conditions: {
      options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'lead-email-filter',
          leftValue: "={{ /(new lead|new enquiry|new inquiry|contact form|quote request|website lead)/i.test(($json.subject || '') + ' ' + ($json.textPlain || '')) }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  },
  id: 'if-lead-email',
  name: 'IF Lead Notification Email',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: [-1460, 160],
});

add({
  parameters: {
    httpMethod: 'POST',
    path: 'web-lead',
    responseMode: 'onReceived',
    responseData: 'allEntries',
    options: { rawBody: false },
  },
  id: 'web-form-webhook',
  name: 'Web Form Webhook',
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position: [-1700, 360],
  webhookId: 'a1b2c3d4-0003-4000-8000-000000000003',
});

add({
  parameters: {
    httpMethod: 'POST',
    path: 'twilio-inbound-sms',
    responseMode: 'onReceived',
    responseData: 'noData',
    options: { rawBody: false },
  },
  id: 'twilio-inbound-sms-webhook',
  name: 'Twilio Inbound SMS Webhook',
  type: 'n8n-nodes-base.webhook',
  typeVersion: 2,
  position: [-1700, 560],
  webhookId: 'a1b2c3d4-0004-4000-8000-000000000004',
});

add({
  parameters: {
    conditions: {
      options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'has-content',
          leftValue: "={{ String($json.body.Body || '').trim().length > 0 || Number($json.body.NumMedia || 0) > 0 }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
        {
          id: 'not-opt-out-keyword',
          leftValue: "={{ !['stop','stopall','unsubscribe','cancel','quit','end','revoke','optout','start','unstop','help','info'].includes(String($json.body.Body || '').trim().toLowerCase().replace(/[^a-z]/g, '')) }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  },
  id: 'if-actionable-sms',
  name: 'IF Actionable Inbound SMS',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: [-1460, 560],
});

/* --- MODULE 3 ------------------------------------------------------ */
add({
  parameters: { mode: 'runOnceForAllItems', jsCode: CODE_NORMALIZE },
  id: 'normalize-lead',
  name: 'Normalize Lead Payload',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [-1180, 160],
  onError: 'continueErrorOutput',
});

add({
  parameters: Object.assign({
    method: 'GET',
    url: "={{ '" + SUPA + "/rest/v1/client_configs?select=*&status=eq.active&limit=1&or=(twilio_phone_number.eq.' + encodeURIComponent($json.client_id_or_number) + ',client_id.eq.' + encodeURIComponent($json.client_id_or_number) + ')' }}",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] },
    options: { response: { response: { responseFormat: 'json' } }, timeout: 15000 },
  }, supaAuth),
  id: 'fetch-client-config',
  name: 'Fetch Client Config',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [-940, 160],
  credentials: CRED.supabase,
  alwaysOutputData: true,
  ...RESILIENT,
});

add({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'config-found',
          leftValue: '={{ $json.client_id !== undefined && $json.client_id !== null && $json.client_id !== "" }}',
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  },
  id: 'if-config-found',
  name: 'IF Client Config Found',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: [-700, 160],
});

add({
  parameters: { mode: 'runOnceForAllItems', jsCode: CODE_UNKNOWN_CLIENT },
  id: 'flag-unknown-client',
  name: 'Flag Unknown Client',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [-460, 400],
});

add({
  parameters: { mode: 'runOnceForAllItems', jsCode: CODE_VERIFY_TWILIO },
  id: 'verify-twilio-signature',
  name: 'Verify Twilio Signature',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [-820, 300],
  onError: 'continueErrorOutput',
});

add({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'intake-authorised',
          // Fails closed: a web-form lead is only allowed when the tenant has a
          // secret configured AND the caller presented exactly that secret.
          // Every other channel passes through untouched.
          leftValue: "={{ (() => { const ch = $('Normalize Lead Payload').first().json.channel_source; if (ch === 'web_form') { return !!$json.webhook_secret && $('Normalize Lead Payload').first().json.presented_secret === $json.webhook_secret; } if (ch === 'sms' || ch === 'missed_call') { return $json.twilio_signature_valid === true; } return true; })() }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  },
  id: 'if-intake-authorised',
  name: 'IF Intake Authorised',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: [-580, 300],
});

add({
  parameters: { mode: 'runOnceForAllItems', jsCode: CODE_REJECTED_INTAKE },
  id: 'flag-rejected-intake',
  name: 'Flag Rejected Intake',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [-340, 520],
});

/* --- MODULE 4 ------------------------------------------------------ */
add({
  parameters: Object.assign({
    method: 'GET',
    url: "={{ '" + SUPA + "/rest/v1/conversation_history?select=role,content,created_at&order=created_at.asc&limit=40&client_id=eq.' + encodeURIComponent($json.client_id) + '&lead_phone=eq.' + encodeURIComponent($('Normalize Lead Payload').first().json.lead_phone) }}",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] },
    options: { response: { response: { responseFormat: 'json' } }, timeout: 15000 },
  }, supaAuth),
  id: 'fetch-history',
  name: 'Fetch Conversation History',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [-460, 60],
  credentials: CRED.supabase,
  alwaysOutputData: true,
  ...RESILIENT,
});

add({
  parameters: { mode: 'runOnceForAllItems', jsCode: CODE_BUILD_MESSAGES },
  id: 'build-openai-messages',
  name: 'Build OpenAI Messages',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [-220, 60],
  onError: 'continueErrorOutput',
});

add({
  parameters: {
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    authentication: 'predefinedCredentialType',
    nodeCredentialType: 'openAiApi',
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ model: $json.model, temperature: $json.temperature, max_tokens: $json.max_tokens, response_format: $json.response_format, messages: $json.messages }) }}',
    options: { response: { response: { responseFormat: 'json' } }, timeout: 60000 },
  },
  id: 'openai-chat',
  name: 'OpenAI GPT-4o-mini',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [20, 60],
  credentials: CRED.openai,
  ...RESILIENT,
});

add({
  parameters: { mode: 'runOnceForAllItems', jsCode: CODE_PARSE_AI },
  id: 'parse-ai-response',
  name: 'Parse AI Response',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [260, 60],
  onError: 'continueErrorOutput',
});

add({
  parameters: {
    resource: 'sms',
    operation: 'send',
    from: '={{ $json.twilio_phone_number }}',
    to: '={{ $json.lead_phone }}',
    toWhatsapp: false,
    message: '={{ $json.reply }}',
    options: {},
  },
  id: 'twilio-send-sms',
  name: 'Twilio Send SMS',
  type: 'n8n-nodes-base.twilio',
  typeVersion: 1,
  position: [500, 60],
  credentials: CRED.twilio,
  ...RESILIENT,
});

add({
  parameters: Object.assign({
    method: 'POST',
    url: SUPA + '/rest/v1/conversation_history',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Prefer', value: 'return=minimal' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: (() => {
      const P = "$('Parse AI Response').first().json";
      const userRow = [
        '  {',
        '    client_id: ' + P + '.client_id,',
        '    lead_phone: ' + P + '.lead_phone,',
        "    role: 'user',",
        '    content: ' + P + '.inbound_message,',
        '    channel_source: ' + P + '.channel_source,',
        '    turn: ' + P + '.turn,',
        '    execution_id: $execution.id,',
        '    created_at: new Date(Date.now() - 1000).toISOString()',
        '  }',
      ].join('\n');
      const assistantRow = [
        '  {',
        '    client_id: ' + P + '.client_id,',
        '    lead_phone: ' + P + '.lead_phone,',
        "    role: 'assistant',",
        '    content: ' + P + '.reply,',
        "    channel_source: 'sms',",
        '    turn: ' + P + '.turn,',
        '    booking_intent: ' + P + '.booking_intent,',
        "    is_followup: " + P + ".channel_source === 'followup',",
        '    followup_step: ' + P + '.followup_step,',
        '    twilio_sid: $json.sid || null,',
        '    execution_id: $execution.id,',
        '    created_at: new Date().toISOString()',
        '  }',
      ].join('\n');
      // A re-engagement nudge has no inbound message, so no user row is written.
      return '={{ JSON.stringify(\n(' + P + ".channel_source === 'followup' ? [] : [\n" + userRow + '\n]).concat([\n' + assistantRow + '\n])\n) }}';
    })(),
    options: { response: { response: { responseFormat: 'json' } }, timeout: 15000 },
  }, supaAuth),
  id: 'persist-conversation',
  name: 'Persist Conversation Turn',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [740, 60],
  credentials: CRED.supabase,
  alwaysOutputData: true,
  ...RESILIENT,
});

/* --- MODULE 5 ------------------------------------------------------ */
add({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'booking-ready',
          leftValue: "={{ $('Parse AI Response').first().json.booking_ready === true }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  },
  id: 'if-booking-confirmed',
  name: 'IF Booking Confirmed',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: [980, 60],
});

add({
  parameters: {
    method: 'POST',
    url: "={{ 'https://api.cal.com/v1/bookings?apiKey=' + $('Parse AI Response').first().json.calcom_api_key }}",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }] },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({\n  eventTypeId: Number($(\'Parse AI Response\').first().json.event_type_id),\n  start: $(\'Parse AI Response\').first().json.booking_start,\n  timeZone: $(\'Parse AI Response\').first().json.timezone,\n  language: \'en\',\n  title: \'Appointment - \' + $(\'Parse AI Response\').first().json.lead_name,\n  description: $(\'Parse AI Response\').first().json.notes,\n  status: \'ACCEPTED\',\n  responses: {\n    name: $(\'Parse AI Response\').first().json.lead_name,\n    email: $(\'Parse AI Response\').first().json.lead_email,\n    smsReminderNumber: $(\'Parse AI Response\').first().json.lead_phone,\n    notes: $(\'Parse AI Response\').first().json.notes,\n    location: { value: \'phone\', optionValue: $(\'Parse AI Response\').first().json.lead_phone }\n  },\n  metadata: {\n    source: $(\'Parse AI Response\').first().json.channel_source,\n    client_id: $(\'Parse AI Response\').first().json.client_id,\n    n8n_execution: $execution.id\n  }\n}) }}',
    options: { response: { response: { responseFormat: 'json' } }, timeout: 30000 },
  },
  id: 'calcom-create-booking',
  name: 'Cal.com Create Booking',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [1220, -40],
  alwaysOutputData: true,
  ...RESILIENT,
});

add({
  parameters: { mode: 'runOnceForAllItems', jsCode: CODE_SHEET_ROW },
  id: 'build-sheet-row',
  name: 'Build Sheet Row',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [1460, 60],
  onError: 'continueErrorOutput',
});

add({
  parameters: {
    operation: 'append',
    documentId: { __rl: true, value: '={{ $json.google_sheet_id }}', mode: 'id' },
    sheetName: { __rl: true, value: 'Leads', mode: 'name' },
    columns: {
      mappingMode: 'defineBelow',
      value: {
        Timestamp: '={{ $json.Timestamp }}',
        'Lead Name': '={{ $json["Lead Name"] }}',
        Phone: '={{ $json.Phone }}',
        'Source Channel': '={{ $json["Source Channel"] }}',
        Status: '={{ $json.Status }}',
        'Booking Time': '={{ $json["Booking Time"] }}',
        Notes: '={{ $json.Notes }}',
      },
      matchingColumns: [],
      schema: [
        { id: 'Timestamp', displayName: 'Timestamp', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
        { id: 'Lead Name', displayName: 'Lead Name', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
        { id: 'Phone', displayName: 'Phone', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
        { id: 'Source Channel', displayName: 'Source Channel', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
        { id: 'Status', displayName: 'Status', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
        { id: 'Booking Time', displayName: 'Booking Time', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
        { id: 'Notes', displayName: 'Notes', required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true },
      ],
      attemptToConvertTypes: false,
      convertFieldsToString: true,
    },
    options: { cellFormat: 'USER_ENTERED' },
  },
  id: 'append-google-sheet',
  name: 'Append Lead To Google Sheet',
  type: 'n8n-nodes-base.googleSheets',
  typeVersion: 4.5,
  position: [1700, 60],
  credentials: CRED.sheets,
  ...RESILIENT,
});

add({
  parameters: Object.assign({
    method: 'POST',
    url: SUPA + '/rest/v1/lead_threads?on_conflict=client_id,lead_phone',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Prefer', value: 'resolution=merge-duplicates,return=minimal' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: "={{ JSON.stringify([$('Build Sheet Row').first().json._thread]) }}",
    options: { response: { response: { responseFormat: 'json' } }, timeout: 15000 },
  }, supaAuth),
  id: 'upsert-lead-thread',
  name: 'Upsert Lead Thread State',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [1940, 60],
  credentials: CRED.supabase,
  alwaysOutputData: true,
  ...RESILIENT,
});

add({
  parameters: {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [
        {
          id: 'is-sweep-run',
          leftValue: "={{ $('Normalize Lead Payload').first().json.channel_source === 'followup' }}",
          rightValue: '',
          operator: { type: 'boolean', operation: 'true', singleValue: true },
        },
      ],
      combinator: 'and',
    },
    looseTypeValidation: true,
    options: {},
  },
  id: 'if-followup-sweep-run',
  name: 'IF Followup Sweep Run',
  type: 'n8n-nodes-base.if',
  typeVersion: 2.2,
  position: [2180, 60],
});

/* --- MODULE 6 :: COLD-LEAD RE-ENGAGEMENT --------------------------- */
add({
  parameters: {
    rule: { interval: [{ field: 'minutes', minutesInterval: 30 }] },
  },
  id: 'cold-sweep-schedule',
  name: 'Cold Lead Sweep Schedule',
  type: 'n8n-nodes-base.scheduleTrigger',
  typeVersion: 1.2,
  position: [-1700, 1180],
});

add({
  parameters: Object.assign({
    method: 'GET',
    url: "={{ '" + SUPA + "/rest/v1/lead_threads?select=*,client_configs!inner(*)&status=eq.nurturing&client_configs.status=eq.active&client_configs.followup_enabled=is.true&order=next_followup_at.asc&limit=100&next_followup_at=lte.' + encodeURIComponent(new Date().toISOString()) }}",
    sendHeaders: true,
    headerParameters: { parameters: [{ name: 'Accept', value: 'application/json' }] },
    options: { response: { response: { responseFormat: 'json' } }, timeout: 20000 },
  }, supaAuth),
  id: 'fetch-cold-threads',
  name: 'Fetch Cold Threads',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [-1460, 1180],
  credentials: CRED.supabase,
  alwaysOutputData: true,
  ...RESILIENT,
});

add({
  parameters: { mode: 'runOnceForAllItems', jsCode: CODE_COLD_GATE },
  id: 'gate-quiet-hours',
  name: 'Gate Quiet Hours & Cadence',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [-1220, 1180],
  onError: 'continueErrorOutput',
});

add({
  parameters: { batchSize: 1, options: { reset: false } },
  id: 'loop-cold-leads',
  name: 'Loop Over Cold Leads',
  type: 'n8n-nodes-base.splitInBatches',
  typeVersion: 3,
  position: [-980, 1180],
});

add({
  parameters: {},
  id: 'sweep-complete',
  name: 'Sweep Complete',
  type: 'n8n-nodes-base.noOp',
  typeVersion: 1,
  position: [-740, 1300],
});

/* --- COMPLIANCE :: opt-out / opt-in ------------------------------- */
add({
  parameters: { mode: 'runOnceForAllItems', jsCode: CODE_NON_ACTIONABLE_SMS },
  id: 'handle-non-actionable-sms',
  name: 'Handle Non-Actionable SMS',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [-1220, 760],
});

add({
  parameters: Object.assign({
    method: 'PATCH',
    url: "={{ '" + SUPA + "/rest/v1/lead_threads?lead_phone=eq.' + encodeURIComponent($json.lead_phone) + '&client_phone=eq.' + encodeURIComponent($json.client_phone) }}",
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Prefer', value: 'return=minimal' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify({ status: $json.new_status, next_followup_at: $json.next_followup_at, updated_at: $json.updated_at, opt_out_keyword: $json.keyword }) }}',
    options: { response: { response: { responseFormat: 'json' } }, timeout: 15000 },
  }, supaAuth),
  id: 'mark-thread-opted-out',
  name: 'Apply SMS Opt-Out / Opt-In',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [-980, 760],
  credentials: CRED.supabase,
  alwaysOutputData: true,
  ...RESILIENT,
});

/* --- ERROR SPINE --------------------------------------------------- */
add({
  parameters: {},
  id: 'error-trigger',
  name: 'Workflow Error Trigger',
  type: 'n8n-nodes-base.errorTrigger',
  typeVersion: 1,
  position: [-1180, 900],
});

add({
  parameters: { mode: 'runOnceForAllItems', jsCode: CODE_ERROR },
  id: 'handle-api-error',
  name: 'Handle API Error',
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [-460, 900],
});

add({
  parameters: Object.assign({
    method: 'POST',
    url: SUPA + '/rest/v1/error_log',
    sendHeaders: true,
    headerParameters: {
      parameters: [
        { name: 'Prefer', value: 'return=minimal' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    },
    sendBody: true,
    specifyBody: 'json',
    jsonBody: '={{ JSON.stringify([$json]) }}',
    options: { response: { response: { responseFormat: 'json', neverError: true } }, timeout: 15000 },
  }, supaAuth),
  id: 'log-error-supabase',
  name: 'Log Error To Supabase',
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.2,
  position: [-220, 900],
  credentials: CRED.supabase,
  retryOnFail: true,
  maxTries: 2,
  waitBetweenTries: 2000,
  onError: 'continueRegularOutput',
  alwaysOutputData: true,
});

/* ------------------------------------------------------------------ */
/* Connections                                                          */
/* ------------------------------------------------------------------ */

const to = (name, index) => ({ node: name, type: 'main', index: index || 0 });
const ERR = [to('Handle API Error')];

const connections = {
  // Module 1
  'Typeform Onboarding Webhook': { main: [[to('Extract Client Profile')]] },
  'Extract Client Profile': { main: [[to('Supabase Upsert Client Config')], ERR] },
  'Supabase Upsert Client Config': { main: [[to('Respond Onboarding OK')], ERR] },

  // Module 2 -> 3
  'Twilio Voice Status Webhook': { main: [[to('IF Missed Call')]] },
  'IF Missed Call': { main: [[to('Normalize Lead Payload')], []] },
  'Email Lead Trigger (IMAP)': { main: [[to('IF Lead Notification Email')]] },
  'IF Lead Notification Email': { main: [[to('Normalize Lead Payload')], []] },
  'Web Form Webhook': { main: [[to('Normalize Lead Payload')]] },
  'Twilio Inbound SMS Webhook': { main: [[to('IF Actionable Inbound SMS')]] },
  'IF Actionable Inbound SMS': { main: [[to('Normalize Lead Payload')], [to('Handle Non-Actionable SMS')]] },
  'Handle Non-Actionable SMS': { main: [[to('Apply SMS Opt-Out / Opt-In')]] },
  'Apply SMS Opt-Out / Opt-In': { main: [[], ERR] },

  // Module 6 - cold-lead re-engagement (batch of 1 keeps the shared chain single-lead)
  'Cold Lead Sweep Schedule': { main: [[to('Fetch Cold Threads')]] },
  'Fetch Cold Threads': { main: [[to('Gate Quiet Hours & Cadence')], ERR] },
  'Gate Quiet Hours & Cadence': { main: [[to('Loop Over Cold Leads')], ERR] },
  'Loop Over Cold Leads': { main: [[to('Sweep Complete')], [to('Normalize Lead Payload')]] },

  // Module 3
  'Normalize Lead Payload': { main: [[to('Fetch Client Config')], ERR] },
  'Fetch Client Config': { main: [[to('IF Client Config Found')], ERR] },
  'IF Client Config Found': { main: [[to('Verify Twilio Signature')], [to('Flag Unknown Client')]] },
  'Verify Twilio Signature': { main: [[to('IF Intake Authorised')], ERR] },
  'IF Intake Authorised': { main: [[to('Fetch Conversation History')], [to('Flag Rejected Intake')]] },
  'Flag Rejected Intake': { main: [[to('Log Error To Supabase')]] },
  'Flag Unknown Client': { main: [[to('Log Error To Supabase')]] },

  // Module 4
  'Fetch Conversation History': { main: [[to('Build OpenAI Messages')], ERR] },
  'Build OpenAI Messages': { main: [[to('OpenAI GPT-4o-mini')], ERR] },
  'OpenAI GPT-4o-mini': { main: [[to('Parse AI Response')], ERR] },
  'Parse AI Response': { main: [[to('Twilio Send SMS')], ERR] },
  'Twilio Send SMS': { main: [[to('Persist Conversation Turn')], ERR] },
  'Persist Conversation Turn': { main: [[to('IF Booking Confirmed')], ERR] },

  // Module 5
  'IF Booking Confirmed': { main: [[to('Cal.com Create Booking')], [to('Build Sheet Row')]] },
  'Cal.com Create Booking': { main: [[to('Build Sheet Row')], [to('Build Sheet Row'), to('Handle API Error')]] },
  'Build Sheet Row': { main: [[to('Append Lead To Google Sheet')], ERR] },
  'Append Lead To Google Sheet': { main: [[to('Upsert Lead Thread State')], ERR] },
  'Upsert Lead Thread State': { main: [[to('IF Followup Sweep Run')], ERR] },
  'IF Followup Sweep Run': { main: [[to('Loop Over Cold Leads')], []] },

  // Error spine
  'Workflow Error Trigger': { main: [[to('Handle API Error')]] },
  'Handle API Error': { main: [[to('Log Error To Supabase')]] },
};

const workflow = {
  // Required by `n8n import:workflow`; the UI importer generates one, the CLI does not.
  id: 'LeadSMSBooking01',
  name: 'Multi-Channel Inbound Lead Automation & Multi-Turn SMS Booking Engine',
  nodes,
  connections,
  active: false,
  settings: {
    executionOrder: 'v1',
    saveManualExecutions: true,
    saveExecutionProgress: true,
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
    callerPolicy: 'workflowsFromSameOwner',
    executionTimeout: 900,
    timezone: 'America/New_York',
    errorWorkflow: '',
  },
  staticData: null,
  meta: { instanceId: 'REPLACE_WITH_YOUR_N8N_INSTANCE_ID', templateCredsSetupCompleted: false },
  pinData: {},
  tags: [
    { id: 'lead-automation', name: 'lead-automation' },
    { id: 'sms-booking', name: 'sms-booking' },
    { id: 'multi-tenant', name: 'multi-tenant' },
  ],
  versionId: '00000000-0000-4000-8000-000000000000',
};

// ---- validation ----
const names = new Set(nodes.map((n) => n.name));
if (names.size !== nodes.length) throw new Error('Duplicate node names');
for (const [src, cfg] of Object.entries(connections)) {
  if (!names.has(src)) throw new Error('Connection source missing: ' + src);
  for (const out of cfg.main) for (const c of out) {
    if (!names.has(c.node)) throw new Error('Connection target missing: ' + c.node);
  }
}
for (const n of nodes) {
  if (n.type === 'n8n-nodes-base.stickyNote') continue;
  JSON.stringify(n);
}

const outPath = process.argv[2];
fs.writeFileSync(outPath, JSON.stringify(workflow, null, 2), 'utf8');
console.log('nodes=' + nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote').length + ' sticky=' + nodes.filter(n => n.type === 'n8n-nodes-base.stickyNote').length + ' bytes=' + fs.statSync(outPath).size);
