/*
 * Familienkalender-Worker (Cloudflare Workers)
 *
 * Liest einen iCloud-Kalender (CalDAV) oder eine ICS-Adresse und gibt die Termine als JSON an das Dashboard weiter.
 * Nur lesend. Die App darf iCloud nicht direkt ansprechen (Zugangsdaten, CORS), deshalb dieser Zwischenschritt.
 *
 * Geheime Werte (Secrets) im Worker:
 *   APP_TOKEN          Zugangscode, den die App mitschickt (frei wählbar, lang und zufällig)
 *   APPLE_ID           Apple-ID (E-Mail)                       } für CalDAV
 *   APPLE_APP_PASSWORD App-spezifisches Passwort von Apple     } für CalDAV
 *   CALENDAR_NAME      Name des Kalenders, z. B. "Familie"     (optional, Standard: "Familie" oder "Family")
 *   ICS_URL            Alternativ: Adresse eines veröffentlichten Kalenders (statt CalDAV)
 *   CALDAV_BASE        Nur für Tests (Standard: https://caldav.icloud.com)
 *
 * Aufruf:  GET /events?from=2026-11-01&to=2026-12-31   mit Header  Authorization: Bearer <APP_TOKEN>
 * Antwort: { calendar, from, to, ics: ["BEGIN:VCALENDAR…", …], fetchedAt }
 */

const DEFAULT_BASE = 'https://caldav.icloud.com';
const DEFAULT_NAMES = ['familie', 'family'];
const MAX_RANGE_DAYS = 400;
const DISCOVERY_TTL_MS = 6 * 3600 * 1000;
const discoveryCache = new Map();

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra || {}; }
}

function corsHeaders(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store'
  }, extra || {});
}
function json(obj, status) {
  return new Response(JSON.stringify(obj), { status: status || 200, headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' }) });
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/* ---------- Datum ---------- */
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return new Date(t).toISOString().slice(0, 10) === s ? t : null;
}
function addDaysMs(ms, n) { return ms + n * 86400000; }
function davTime(ms) { return new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'; }

/* ---------- XML (ohne DOM, nur die benötigten Teile) ---------- */
const NS = '(?:[\\w-]+:)?';
function decodeXml(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function firstHrefInside(xml, tag) {
  const m = new RegExp('<' + NS + tag + '[^>]*>[\\s\\S]*?<' + NS + 'href[^>]*>([^<]*)<', 'i').exec(xml);
  return m ? decodeXml(m[1]).trim() : null;
}
function responsesOf(xml) {
  return xml.split(new RegExp('<' + NS + 'response[\\s>]', 'i')).slice(1);
}
function textOf(block, tag) {
  const m = new RegExp('<' + NS + tag + '[^>]*>([\\s\\S]*?)</' + NS + tag + '>', 'i').exec(block);
  return m ? decodeXml(m[1]).trim() : '';
}
function parseCalendars(xml, baseUrl) {
  const out = [];
  responsesOf(xml).forEach((block) => {
    const href = textOf(block, 'href');
    const rt = new RegExp('<' + NS + 'resourcetype[^>]*>([\\s\\S]*?)</' + NS + 'resourcetype>', 'i').exec(block);
    const isCal = !!rt && new RegExp('<' + NS + 'calendar(?=[\\s/>])', 'i').test(rt[1]);
    const sc = new RegExp('<' + NS + 'supported-calendar-component-set[^>]*>([\\s\\S]*?)</' + NS + 'supported-calendar-component-set>', 'i').exec(block);
    const hasEvents = !sc || /name="VEVENT"/i.test(sc[1]);
    const name = textOf(block, 'displayname') || decodeURIComponent((href || '').replace(/\/+$/, '').split('/').pop() || '');
    if (href && isCal && hasEvents && name) out.push({ name, url: new URL(href, baseUrl).href });
  });
  return out;
}

/* ---------- CalDAV ---------- */
function mask(t) { return String(t).replace(/\d{6,}/g, '#').replace(/[\w.+-]+@[\w.-]+/g, '<mail>'); }
async function dav(method, url, env, body, depth, ctx) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: 'Basic ' + btoa(unescape(encodeURIComponent(env.APPLE_ID + ':' + env.APPLE_APP_PASSWORD))),
        'Content-Type': 'application/xml; charset=utf-8',
        Depth: String(depth)
      },
      body
    });
  } catch (e) {
    throw new HttpError(502, 'iCloud ist nicht erreichbar');
  }
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(502, 'iCloud hat die Zugangsdaten abgelehnt (Apple-ID und App-spezifisches Passwort prüfen)');
  }
  const text = res.status >= 400 ? '' : await res.text();
  if (ctx) ctx.trace.push({ step: method + ' ' + mask(new URL(url).pathname) + ' (Depth ' + depth + ')', status: res.status, length: text.length, excerpt: mask(text.replace(/\s+/g, ' ').slice(0, 700)) });
  if (res.status >= 400) throw new HttpError(502, 'iCloud antwortet mit Status ' + res.status);
  return text;
}
const PROP = (inner) => '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>' + inner + '</d:prop></d:propfind>';

async function discover(env, ctx) {
  const base = (env.CALDAV_BASE || DEFAULT_BASE).replace(/\/+$/, '') + '/';
  const key = base + '|' + env.APPLE_ID;
  const hit = discoveryCache.get(key);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.calendars;
  let xml = await dav('PROPFIND', base, env, PROP('<d:current-user-principal/>'), 0, ctx);
  const principal = firstHrefInside(xml, 'current-user-principal');
  if (!principal) throw new HttpError(502, 'iCloud: Benutzerkonto nicht gefunden');
  const principalUrl = new URL(principal, base).href;
  xml = await dav('PROPFIND', principalUrl, env, PROP('<c:calendar-home-set/>'), 0, ctx);
  const home = firstHrefInside(xml, 'calendar-home-set');
  if (!home) throw new HttpError(502, 'iCloud: Kalenderbereich nicht gefunden');
  const homeUrl = new URL(home, principalUrl).href;
  xml = await dav('PROPFIND', homeUrl, env, PROP('<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/>'), 1, ctx);
  let calendars = parseCalendars(xml, homeUrl);
  if (!calendars.length) {   /* zweiter Versuch mit weniger Eigenschaften */
    xml = await dav('PROPFIND', homeUrl, env, PROP('<d:displayname/><d:resourcetype/>'), 1, ctx);
    calendars = parseCalendars(xml, homeUrl);
  }
  if (calendars.length) discoveryCache.set(key, { at: Date.now(), calendars });
  return calendars;
}
function pickCalendar(calendars, wanted) {
  const norm = (x) => x.trim().toLowerCase();
  if (wanted) {
    return calendars.find((c) => norm(c.name) === norm(wanted)) || calendars.find((c) => norm(c.name).includes(norm(wanted)));
  }
  return calendars.find((c) => DEFAULT_NAMES.includes(norm(c.name)));
}
async function fromCalDav(env, fromMs, toMs) {
  const ctx = { trace: [] };
  const calendars = await discover(env, ctx);
  const cal = pickCalendar(calendars, env.CALENDAR_NAME);
  if (!cal) {
    discoveryCache.clear();
    const names = calendars.map((c) => c.name);
    const diag = names.length ? '' : ' Diagnose: ' + ctx.trace.map((t) => t.step + ' → ' + t.status + ', ' + t.length + ' Zeichen: ' + t.excerpt).join(' | ');
    throw new HttpError(404, 'Kalender "' + (env.CALENDAR_NAME || 'Familie') + '" nicht gefunden. Vorhanden: ' + (names.join(', ') || 'keine') + '.' + diag, { available: names, debug: ctx.trace });
  }
  const body = '<?xml version="1.0" encoding="utf-8"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop>' +
    '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="' + davTime(addDaysMs(fromMs, -1)) + '" end="' + davTime(addDaysMs(toMs, 2)) + '"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>';
  const xml = await dav('REPORT', cal.url, env, body, 1, ctx);
  const ics = [];
  const re = new RegExp('<' + NS + 'calendar-data[^>]*>([\\s\\S]*?)</' + NS + 'calendar-data>', 'gi');
  let m;
  while ((m = re.exec(xml))) { const t = decodeXml(m[1]).trim(); if (t) ics.push(t); }
  return { calendar: cal.name, ics };
}
async function fromIcs(env) {
  let res;
  try { res = await fetch(String(env.ICS_URL).replace(/^webcal:/i, 'https:')); } catch (e) { throw new HttpError(502, 'Die ICS-Adresse ist nicht erreichbar'); }
  if (!res.ok) throw new HttpError(502, 'Die ICS-Adresse antwortet mit Status ' + res.status);
  const text = await res.text();
  if (text.indexOf('BEGIN:VCALENDAR') < 0) throw new HttpError(502, 'Die ICS-Adresse liefert keinen Kalender');
  return { calendar: env.CALENDAR_NAME || '', ics: [text] };
}

/* ---------- Anfrage ---------- */
export async function handle(request, env) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== 'GET') return json({ error: 'Nur GET erlaubt' }, 405);
  if (!env.APP_TOKEN) return json({ error: 'APP_TOKEN ist im Worker nicht gesetzt' }, 500);
  if (!safeEqual(request.headers.get('Authorization') || '', 'Bearer ' + env.APP_TOKEN)) return json({ error: 'Zugangscode falsch' }, 401);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/health') return json({ ok: true });
  if (path !== '/events') return json({ error: 'Nicht gefunden' }, 404);

  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  let from = parseDate(url.searchParams.get('from'));
  let to = parseDate(url.searchParams.get('to'));
  if (from === null) from = addDaysMs(today, -31);
  if (to === null) to = addDaysMs(today, 93);
  if (to < from) return json({ error: '"to" liegt vor "from"' }, 400);
  if ((to - from) / 86400000 > MAX_RANGE_DAYS) return json({ error: 'Zeitraum zu groß (höchstens ' + MAX_RANGE_DAYS + ' Tage)' }, 400);

  try {
    let r;
    if (env.ICS_URL) r = await fromIcs(env);
    else if (env.APPLE_ID && env.APPLE_APP_PASSWORD) r = await fromCalDav(env, from, to);
    else return json({ error: 'Weder ICS_URL noch APPLE_ID und APPLE_APP_PASSWORD sind im Worker gesetzt' }, 500);
    return json({ calendar: r.calendar, from: new Date(from).toISOString().slice(0, 10), to: new Date(to).toISOString().slice(0, 10), ics: r.ics, fetchedAt: new Date().toISOString() });
  } catch (e) {
    if (e instanceof HttpError) return json(Object.assign({ error: e.message }, e.extra), e.status);
    return json({ error: 'Unerwarteter Fehler: ' + (e && e.message) }, 502);
  }
}

export default { fetch: handle };
export const _test = { decodeXml, parseCalendars, davTime, discoveryCache, mask };
