'use strict';
/*
 * Tests für den Familienkalender-Worker (worker/worker.mjs) gegen einen nachgebauten iCloud-CalDAV-Server.
 * Geprüft wird das Verhalten des Workers, nicht iCloud selbst: Echte iCloud-Antworten können im Detail abweichen.
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let worker, server, base, requests, authOk;
const APPLE_ID = 'familie@example.com', APPLE_PW = 'abcd-efgh-ijkl-mnop', TOKEN = 'geheim-123';

const ICS_A = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:a1\r\nSUMMARY:Zahnarzt & Co\r\nDTSTART:20261118T140000Z\r\nDTEND:20261118T150000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const ICS_B = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:b1\r\nSUMMARY:Fußball\r\nDTSTART:20261119T160000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\r/g, '&#13;');

function multistatus(inner) { return '<?xml version="1.0" encoding="UTF-8"?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">' + inner + '</multistatus>'; }
function readBody(req) { return new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); }); }

before(async () => {
  worker = (await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'worker.mjs')).href)).default;
  server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ method: req.method, url: req.url, depth: req.headers.depth, auth: req.headers.authorization, body });
    const expected = 'Basic ' + Buffer.from(APPLE_ID + ':' + APPLE_PW).toString('base64');
    if (req.headers.authorization !== expected) { res.writeHead(authOk === 'forbidden' ? 403 : 401); return res.end(); }
    const host = 'http://127.0.0.1:' + server.address().port;
    res.writeHead(207, { 'Content-Type': 'application/xml' });
    if (req.method === 'PROPFIND' && req.url === '/') {
      return res.end(multistatus('<response><href>/</href><propstat><prop><current-user-principal><href>/123/principal/</href></current-user-principal></prop></propstat></response>'));
    }
    if (req.method === 'PROPFIND' && req.url === '/123/principal/') {
      return res.end(multistatus('<response><href>/123/principal/</href><propstat><prop><C:calendar-home-set><href>' + host + '/123/calendars/</href></C:calendar-home-set></prop></propstat></response>'));
    }
    if (req.method === 'PROPFIND' && req.url === '/123/calendars/') {
      const cal = (href, name, comps) => '<response><href>' + href + '</href><propstat><prop><displayname>' + name + '</displayname><resourcetype><collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></resourcetype><C:supported-calendar-component-set>' + comps.map((c) => '<C:comp name="' + c + '"/>').join('') + '</C:supported-calendar-component-set></prop></propstat></response>';
      return res.end(multistatus(
        '<response><href>/123/calendars/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>' +
        '<response><href>/123/calendars/inbox/</href><propstat><prop><displayname>Posteingang</displayname><resourcetype><collection/><C:schedule-inbox/></resourcetype></prop></propstat></response>' +
        cal('/123/calendars/privat/', 'Privat', ['VEVENT']) + cal('/123/calendars/fam/', 'Familie', ['VEVENT']) + cal('/123/calendars/todo/', 'Erinnerungen', ['VTODO'])));
    }
    if (req.method === 'REPORT' && req.url === '/123/calendars/fam/') {
      return res.end(multistatus('<response><href>/123/calendars/fam/a1.ics</href><propstat><prop><getetag>"1"</getetag><C:calendar-data>' + esc(ICS_A) + '</C:calendar-data></prop></propstat></response>' +
        '<response><href>/123/calendars/fam/b1.ics</href><propstat><prop><C:calendar-data><![CDATA[' + ICS_B + ']]></C:calendar-data></prop></propstat></response>'));
    }
    if (req.method === 'REPORT' && req.url === '/123/calendars/privat/') return res.end(multistatus(''));
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => server.close());
beforeEach(() => { requests = []; authOk = true; });

const env = (extra) => Object.assign({ APP_TOKEN: TOKEN, APPLE_ID, APPLE_APP_PASSWORD: APPLE_PW, CALDAV_BASE: base }, extra || {});
async function get(pathAndQuery, e, headers, method) {
  return worker.fetch(new Request('https://worker.test' + pathAndQuery, { method: method || 'GET', headers: headers || { Authorization: 'Bearer ' + TOKEN } }), e);
}
async function clearCache() { const m = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'worker.mjs')).href); m._test.discoveryCache.clear(); }

describe('Zugriff', () => {
  test('ohne Zugangscode: 401, iCloud wird nicht kontaktiert', async () => {
    const r = await get('/events', env(), {});
    assert.equal(r.status, 401);
    assert.equal(requests.length, 0);
  });
  test('falscher Zugangscode: 401', async () => {
    const r = await get('/events', env(), { Authorization: 'Bearer falsch' });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error, 'Zugangscode falsch');
  });
  test('APP_TOKEN fehlt im Worker: 500 mit Hinweis', async () => {
    const r = await get('/events', env({ APP_TOKEN: '' }));
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /APP_TOKEN/);
  });
  test('CORS: Preflight wird beantwortet, Antworten erlauben die App', async () => {
    const r = await get('/events', env(), {}, 'OPTIONS');
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.match(r.headers.get('access-control-allow-headers'), /Authorization/);
    const r2 = await get('/events', env(), {});
    assert.equal(r2.headers.get('access-control-allow-origin'), '*', 'auch Fehlerantworten brauchen CORS');
  });
  test('nur GET, unbekannter Pfad, /health', async () => {
    assert.equal((await get('/events', env(), { Authorization: 'Bearer ' + TOKEN }, 'POST')).status, 405);
    assert.equal((await get('/gibtsnicht', env())).status, 404);
    assert.deepEqual(await (await get('/health', env())).json(), { ok: true });
  });
  test('Zeitraum wird geprüft', async () => {
    assert.equal((await get('/events?from=2026-12-01&to=2026-11-01', env())).status, 400);
    assert.equal((await get('/events?from=2020-01-01&to=2026-11-01', env())).status, 400);
  });
});

describe('CalDAV (iCloud)', () => {
  test('findet den Kalender "Familie" und liefert dessen Termine', async () => {
    await clearCache();
    const r = await get('/events?from=2026-11-01&to=2026-12-31', env());
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.calendar, 'Familie');
    assert.equal(j.ics.length, 2);
    assert.ok(j.ics[0].includes('SUMMARY:Zahnarzt & Co'), 'XML-Entitäten (&amp;) müssen aufgelöst sein');
    assert.ok(j.ics[0].includes('\r\nDTSTART:20261118T140000Z'), 'Zeilenumbrüche (&#13;) müssen erhalten sein');
    assert.ok(j.ics[1].includes('SUMMARY:Fußball'), 'CDATA muss ausgepackt werden');
    assert.equal(j.from, '2026-11-01'); assert.equal(j.to, '2026-12-31');
  });
  test('Ablauf: Hauptadresse, Benutzer, Kalenderbereich, Liste, Abfrage – alle mit Zugangsdaten', async () => {
    await clearCache();
    await get('/events?from=2026-11-01&to=2026-12-31', env());
    assert.deepEqual(requests.map((q) => q.method + ' ' + q.url), ['PROPFIND /', 'PROPFIND /123/principal/', 'PROPFIND /123/calendars/', 'REPORT /123/calendars/fam/']);
    const expected = 'Basic ' + Buffer.from(APPLE_ID + ':' + APPLE_PW).toString('base64');
    assert.ok(requests.every((q) => q.auth === expected));
    assert.equal(requests[2].depth, '1');
  });
  test('Zeitraumfilter in der Abfrage: UTC mit Puffer (−1 Tag / +2 Tage)', async () => {
    await clearCache();
    await get('/events?from=2026-11-01&to=2026-12-31', env());
    const rep = requests[requests.length - 1].body;
    assert.match(rep, /time-range start="20261031T000000Z" end="20270102T000000Z"/);
    assert.match(rep, /comp-filter name="VEVENT"/);
  });
  test('zweite Anfrage nutzt die gemerkte Kalenderadresse', async () => {
    await clearCache();
    await get('/events?from=2026-11-01&to=2026-12-31', env());
    requests = [];
    await get('/events?from=2026-11-01&to=2026-12-31', env());
    assert.deepEqual(requests.map((q) => q.method), ['REPORT']);
  });
  test('Kalendername frei wählbar (Groß-/Kleinschreibung egal)', async () => {
    await clearCache();
    const j = await (await get('/events?from=2026-11-01&to=2026-12-31', env({ CALENDAR_NAME: 'privat' }))).json();
    assert.equal(j.calendar, 'Privat');
    assert.deepEqual(j.ics, []);
  });
  test('Kalender nicht gefunden: 404 mit Liste der vorhandenen (ohne Erinnerungen)', async () => {
    await clearCache();
    const r = await get('/events', env({ CALENDAR_NAME: 'Urlaub' }));
    assert.equal(r.status, 404);
    const j = await r.json();
    assert.match(j.error, /"Urlaub" nicht gefunden/);
    assert.deepEqual(j.available.sort(), ['Familie', 'Privat']);
  });
  test('falsches Passwort: 502 mit verständlicher Meldung, Passwort steht nicht in der Antwort', async () => {
    await clearCache();
    const r = await get('/events', env({ APPLE_APP_PASSWORD: 'falsch' }));
    assert.equal(r.status, 502);
    const txt = await r.text();
    assert.match(txt, /App-spezifisches Passwort/);
    assert.ok(!txt.includes('falsch') || txt.includes('abgelehnt'));
    assert.ok(!txt.includes(APPLE_PW));
  });
  test('Zugangsdaten fehlen im Worker: 500 mit Hinweis', async () => {
    const r = await get('/events', { APP_TOKEN: TOKEN });
    assert.equal(r.status, 500);
    assert.match((await r.json()).error, /ICS_URL|APPLE_ID/);
  });
});

describe('ICS-Adresse', () => {
  let icsServer, icsUrl;
  before(async () => {
    icsServer = http.createServer((req, res) => {
      if (req.url === '/gut.ics') { res.writeHead(200, { 'Content-Type': 'text/calendar' }); return res.end(ICS_A); }
      if (req.url === '/html') { res.writeHead(200); return res.end('<html></html>'); }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => icsServer.listen(0, '127.0.0.1', r));
    icsUrl = 'http://127.0.0.1:' + icsServer.address().port;
  });
  after(() => icsServer.close());
  test('liefert den Kalender unverändert', async () => {
    const j = await (await get('/events', { APP_TOKEN: TOKEN, ICS_URL: icsUrl + '/gut.ics' })).json();
    assert.equal(j.ics.length, 1);
    assert.ok(j.ics[0].includes('Zahnarzt'));
  });
  test('Adresse ohne Kalender / nicht vorhanden: 502', async () => {
    assert.equal((await get('/events', { APP_TOKEN: TOKEN, ICS_URL: icsUrl + '/html' })).status, 502);
    assert.equal((await get('/events', { APP_TOKEN: TOKEN, ICS_URL: icsUrl + '/fehlt' })).status, 502);
  });
});
