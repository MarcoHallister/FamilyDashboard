'use strict';
/*
 * Tests für die Kalenderanzeige (nur lesen): ICS-Auswertung, Wiederholungen, Tagesliste rechts,
 * großer Kalender mit Monats-/Wochenansicht, Abruf, Offline-Verhalten und Einstellungen.
 * Der Worker wird per Netzwerk-Umleitung nachgebaut (https://cal.test). Uhr: Mittwoch, 18.11.2026, 10:00 (Berlin).
 */
const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const APP_URL = process.env.APP_URL || pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const KEY = 'haushaltsplaner.v2', CAL_KEY = 'haushaltsplaner.cal';
const NOW = '2026-11-18T10:00:00+01:00';
const PIN = '1234', SALT = 'testsalt';
const LAYOUTS = {
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  wide: { viewport: { width: 962, height: 601 } }
};

/* ------------------------------------------------------------ Testdaten */
const BER = ';TZID=Europe/Berlin';
function ev(lines) { return ['BEGIN:VEVENT'].concat(lines, ['END:VEVENT']).join('\r\n'); }
function vcal() { return ['BEGIN:VCALENDAR', 'VERSION:2.0'].concat([].slice.call(arguments), ['END:VCALENDAR']).join('\r\n') + '\r\n'; }
const FIXTURE = vcal(
  ev(['UID:e1', 'SUMMARY:Zahnarzt Leah', 'LOCATION:Praxis Dr. Meier', 'DESCRIPTION:Bitte Versichertenkarte\\nmitnehmen', 'DTSTART' + BER + ':20261118T150000', 'DTEND' + BER + ':20261118T160000']),
  ev(['UID:e2', 'SUMMARY:Müllabfuhr', 'DTSTART;VALUE=DATE:20261118', 'DTEND;VALUE=DATE:20261119']),
  ev(['UID:e3', 'SUMMARY:Frühstück', 'DTSTART' + BER + ':20261118T080000', 'DTEND' + BER + ':20261118T090000']),
  ev(['UID:e4', 'SUMMARY:Laufender Termin', 'DTSTART' + BER + ':20261118T093000', 'DTEND' + BER + ':20261118T110000']),
  ev(['UID:e5', 'SUMMARY:Elternabend', 'LOCATION:Schule', 'DTSTART' + BER + ':20261119T193000', 'DTEND' + BER + ':20261119T210000']),
  ev(['UID:e6', 'SUMMARY:Fußball Ben', 'DTSTART' + BER + ':20261103T170000', 'DTEND' + BER + ':20261103T183000', 'RRULE:FREQ=WEEKLY;BYDAY=TU,TH', 'EXDATE' + BER + ':20261124T170000']),
  ev(['UID:e6', 'RECURRENCE-ID' + BER + ':20261119T170000', 'SUMMARY:Fußball Ben (verlegt)', 'DTSTART' + BER + ':20261119T180000', 'DTEND' + BER + ':20261119T190000']),
  ev(['UID:e7', 'SUMMARY:Urlaub Oma', 'DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261123']),
  ev(['UID:e8', 'SUMMARY:Abgesagt', 'STATUS:CANCELLED', 'DTSTART' + BER + ':20261118T120000', 'DTEND' + BER + ':20261118T130000'])
);
function seed() {
  return {
    version: 2, savedAt: 1,
    settings: { pinHash: crypto.createHash('sha256').update(SALT + ':' + PIN).digest('hex'), pinSalt: SALT, currency: 'EUR', piggyFull: 20, selected: 'pa' },
    profiles: [{ id: 'pa', name: 'Anna', color: '#e4572e', avatar: '', pinned: true, payouts: [] }, { id: 'pb', name: 'Ben', color: '#2f6fde', avatar: '', pinned: true, payouts: [] }],
    tasks: [{ id: 't1', title: 'Zimmer', icon: '🧹', value: 0.5, order: 0 }],
    assignments: [
      { id: 'a1', taskId: 't1', profileId: 'pa', valueOverride: null, schedule: { type: 'weekdays', days: [1, 2, 3, 4, 5, 6, 7] } },
      { id: 'a2', taskId: 't1', profileId: 'pb', valueOverride: null, schedule: { type: 'weekdays', days: [1, 2, 3, 4, 5, 6, 7] } }
    ],
    completions: []
  };
}

/* ------------------------------------------------------------ Helfer */
let browser;
before(async () => { browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}); });
after(async () => { await browser.close(); });
let current = null;
afterEach(async () => {
  if (!current) return;
  const { ctx, errors } = current; current = null;
  await ctx.close();
  assert.deepEqual(errors, [], 'JavaScript-Fehler in der App: ' + errors.join(' | '));
});

/* Öffnet die App mit nachgebautem Worker. opts: layout|viewport, cfg (null = Kalender aus), ics, wait */
async function open(opts) {
  opts = opts || {};
  const ctx = await browser.newContext(Object.assign({}, opts.viewport ? { viewport: opts.viewport } : LAYOUTS[opts.layout || 'wide'], { timezoneId: 'Europe/Berlin', locale: 'de-DE' }));
  const calls = [], state = { mode: opts.offline ? 'offline' : 'ok', ics: opts.ics || [FIXTURE], status: 500, error: 'Fehler' };
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, OPTIONS' };
  await ctx.route('https://cal.test/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push({ url: req.url(), auth: req.headers().authorization });
    if (state.mode === 'offline') return route.abort('failed');
    if (state.mode === 'error') return route.fulfill({ status: state.status, headers: Object.assign({ 'content-type': 'application/json' }, cors), body: JSON.stringify({ error: state.error }) });
    return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'application/json' }, cors), body: JSON.stringify({ calendar: 'Familie', ics: state.ics }) });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.install({ time: new Date(NOW) });
  const cfg = opts.cfg === undefined ? { mode: 'worker', url: 'https://cal.test', token: 'tok', view: 'month' } : opts.cfg;
  const cache = opts.cache ? JSON.stringify({ mode: 'worker', url: 'https://cal.test', ics: [FIXTURE], cover: { from: '2026-10-18', to: '2027-02-19' }, fetchedAt: Date.parse(NOW) - 3600000 }) : '';
  await page.addInitScript(([k1, v1, k2, v2, k3, v3]) => {
    if (window.name === '__seeded') return;      /* nur beim ersten Laden vorbelegen */
    window.name = '__seeded';
    localStorage.setItem(k1, v1);
    if (v2) localStorage.setItem(k2, v2);
    if (v3) localStorage.setItem(k3, v3);
  }, [KEY, JSON.stringify(seed()), CAL_KEY, cfg ? JSON.stringify(cfg) : '', 'haushaltsplaner.calcache', cache]);
  await page.goto(APP_URL);
  await page.clock.resume();
  await page.waitForFunction(() => window.__hp && window.__hp.getData());
  if (cfg && opts.wait !== false) await page.waitForFunction(() => window.__hp.cal.state.fetchedAt > 0 || window.__hp.cal.state.error, null, { timeout: 8000 });
  await page.waitForTimeout(150);
  current = { ctx, page, calls, state, errors, layout: opts.layout || 'wide' };
  return current;
}
async function pin(page, p = PIN) {
  for (const ch of p) await page.locator('.pad button', { hasText: new RegExp('^' + ch + '$') }).click();
  await page.locator('.pad button', { hasText: /^OK$/ }).click();
  await page.waitForTimeout(100);
}
/* "08:00–09:00 Frühstück" je Zeile */
async function rowsOf(loc) {
  const out = [];
  const n = await loc.count();
  for (let i = 0; i < n; i++) out.push((await loc.nth(i).locator('.ct').innerText()).trim() + ' ' + (await loc.nth(i).locator('.cn').innerText()).trim());
  return out;
}
async function openMax(h) { await h.page.locator('.calmax').first().click(); await h.page.waitForSelector('.dialog.cal'); }
const title = (h) => h.page.locator('.caltitle2').innerText();

/* Zeigt Instanzen als Text in lokaler Zeit (Berlin) */
async function expand(ics, from, to) {
  const h = current || await open({ cfg: null });
  return h.page.evaluate(([ics, from, to]) => {
    const p = (n) => String(n).padStart(2, '0');
    const f = (e) => {
      if (e.allDay) return e.startDate + ' ganztägig ' + e.title;
      const d = new Date(e.start), z = new Date(e.end);
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + (e.end > e.start ? '-' + p(z.getHours()) + ':' + p(z.getMinutes()) : '') + ' ' + e.title;
    };
    return window.__hp.cal.expand(window.__hp.cal.parse(ics), from, to).map(f);
  }, [ics, from, to]);
}

/* ================================================================ Logik */
describe('ICS-Auswertung', () => {
  test('Zeitzone Berlin: 15:00 im Winter ist 14:00 UTC', async () => {
    const h = await open({ cfg: null });
    const ms = await h.page.evaluate((t) => window.__hp.cal.parse(t)[0].startMs, vcal(ev(['UID:x', 'SUMMARY:A', 'DTSTART' + BER + ':20261118T150000', 'DTEND' + BER + ':20261118T160000'])));
    assert.equal(ms, Date.UTC(2026, 10, 18, 14, 0, 0));
  });
  test('UTC (Z) und schwebende Zeit (Gerätezeit) werden unterschieden', async () => {
    const r = await expand(vcal(
      ev(['UID:a', 'SUMMARY:Utc', 'DTSTART:20261118T140000Z', 'DTEND:20261118T150000Z']),
      ev(['UID:b', 'SUMMARY:Schwebend', 'DTSTART:20261118T140000', 'DTEND:20261118T150000'])), '2026-11-18', '2026-11-18');
    assert.deepEqual(r, ['2026-11-18 14:00-15:00 Schwebend', '2026-11-18 15:00-16:00 Utc']);
  });
  test('unbekannte Zeitzone führt nicht zum Absturz (Gerätezeit)', async () => {
    const r = await expand(vcal(ev(['UID:a', 'SUMMARY:Fremd', 'DTSTART;TZID=W. Europe Standard Time:20261118T090000', 'DTEND;TZID=W. Europe Standard Time:20261118T100000'])), '2026-11-18', '2026-11-18');
    assert.deepEqual(r, ['2026-11-18 09:00-10:00 Fremd']);
  });
  test('ganztägig: Ende ist exklusiv, mehrtägig erscheint an jedem Tag', async () => {
    const ics = vcal(ev(['UID:a', 'SUMMARY:Urlaub', 'DTSTART;VALUE=DATE:20261120', 'DTEND;VALUE=DATE:20261123']));
    for (const [d, n] of [['2026-11-19', 0], ['2026-11-20', 1], ['2026-11-22', 1], ['2026-11-23', 0]]) assert.equal((await expand(ics, d, d)).length, n, d);
  });
  test('ganztägig ohne Ende dauert einen Tag, Dauer (DURATION) wird verstanden', async () => {
    const r = await expand(vcal(
      ev(['UID:a', 'SUMMARY:Eintag', 'DTSTART;VALUE=DATE:20261118']),
      ev(['UID:b', 'SUMMARY:Dauer', 'DTSTART:20261118T100000Z', 'DURATION:PT1H30M'])), '2026-11-18', '2026-11-18');
    assert.deepEqual(r, ['2026-11-18 ganztägig Eintag', '2026-11-18 11:00-12:30 Dauer']);
  });
  test('Texte: Maskierung, gefaltete Zeilen, Anführungszeichen in Parametern', async () => {
    const h = await open({ cfg: null });
    const raw = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Eltern\\, Kind\; Spiel\r\nDESCRIPTION:Zeile eins\\nZeile\r\n  zwei lang\r\nLOCATION;ALTREP="http://x:80":Halle 3\r\nDTSTART:20261118T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    const r = await h.page.evaluate((t) => { const e = window.__hp.cal.parse(t)[0]; return [e.title, e.description, e.location]; }, raw);
    assert.deepEqual(r, ['Eltern, Kind; Spiel', 'Zeile eins\nZeile zwei lang', 'Halle 3']);
  });
  test('abgesagte Termine und Alarme (VALARM) stören nicht', async () => {
    const r = await expand(vcal(
      ev(['UID:a', 'SUMMARY:Weg', 'STATUS:CANCELLED', 'DTSTART:20261118T100000Z']),
      ev(['UID:b', 'SUMMARY:Mit Alarm', 'DTSTART:20261118T100000Z', 'DTEND:20261118T110000Z', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'SUMMARY:Alarm', 'TRIGGER:-PT15M', 'END:VALARM'])), '2026-11-18', '2026-11-18');
    assert.deepEqual(r, ['2026-11-18 11:00-12:00 Mit Alarm']);
  });
  test('Termine über Mitternacht erscheinen an beiden Tagen, Zeitlose werden angezeigt', async () => {
    const ics = vcal(ev(['UID:a', 'SUMMARY:Nacht', 'DTSTART' + BER + ':20261118T230000', 'DTEND' + BER + ':20261119T010000']), ev(['UID:b', 'SUMMARY:Punkt', 'DTSTART' + BER + ':20261119T120000']));
    assert.equal((await expand(ics, '2026-11-18', '2026-11-18')).length, 1);
    assert.equal((await expand(ics, '2026-11-19', '2026-11-19')).length, 2);
    assert.equal((await expand(ics, '2026-11-20', '2026-11-20')).length, 0);
  });
  test('kaputte Teile werden übersprungen', async () => {
    const r = await expand('Müll\r\nBEGIN:VEVENT\r\nSUMMARY:Ohne Datum\r\nEND:VEVENT\r\n' + vcal(ev(['UID:a', 'SUMMARY:Gut', 'DTSTART:20261118T100000Z'])), '2026-11-18', '2026-11-18');
    assert.deepEqual(r, ['2026-11-18 11:00 Gut']);
  });
});

describe('Wiederholungen', () => {
  test('wöchentlich Di/Do mit Ausnahme (EXDATE) und verlegtem Einzeltermin', async () => {
    const r = await expand(FIXTURE, '2026-11-16', '2026-11-30');
    assert.deepEqual(r.filter((x) => /Fußball/.test(x)), ['2026-11-17 17:00-18:30 Fußball Ben', '2026-11-19 18:00-19:00 Fußball Ben (verlegt)', '2026-11-26 17:00-18:30 Fußball Ben']);
  });
  test('Sommerzeit: 10:00 Ortszeit bleibt 10:00', async () => {
    const h = await open({ cfg: null });
    const r = await h.page.evaluate((t) => window.__hp.cal.expand(window.__hp.cal.parse(t), '2027-03-22', '2027-03-30').map((e) => e.start), vcal(ev(['UID:a', 'SUMMARY:W', 'DTSTART' + BER + ':20270322T100000', 'DTEND' + BER + ':20270322T110000', 'RRULE:FREQ=WEEKLY'])));
    assert.deepEqual(r, [Date.UTC(2027, 2, 22, 9), Date.UTC(2027, 2, 29, 8)]);
  });
  test('monatlich: zweiter Dienstag, letzter Tag, 31. überspringt kurze Monate', async () => {
    const mk = (rule, start) => vcal(ev(['UID:a', 'SUMMARY:M', 'DTSTART;VALUE=DATE:' + start, 'RRULE:' + rule]));
    assert.deepEqual(await expand(mk('FREQ=MONTHLY;BYDAY=2TU', '20260113'), '2026-11-01', '2026-11-30'), ['2026-11-10 ganztägig M']);
    assert.deepEqual(await expand(mk('FREQ=MONTHLY;BYMONTHDAY=-1', '20260131'), '2026-11-01', '2026-11-30'), ['2026-11-30 ganztägig M']);
    assert.deepEqual(await expand(mk('FREQ=MONTHLY', '20260131'), '2026-11-01', '2026-12-31'), ['2026-12-31 ganztägig M'], 'November hat keinen 31.');
    assert.deepEqual(await expand(mk('FREQ=MONTHLY;BYDAY=-1FR', '20260101'), '2026-11-01', '2026-11-30'), ['2026-11-27 ganztägig M']);
  });
  test('jährlich (Geburtstag), auch über viele Jahre', async () => {
    const r = await expand(vcal(ev(['UID:a', 'SUMMARY:Oma', 'DTSTART;VALUE=DATE:19501120', 'RRULE:FREQ=YEARLY'])), '2026-11-20', '2026-11-20');
    assert.deepEqual(r, ['2026-11-20 ganztägig Oma']);
  });
  test('täglich mit COUNT, UNTIL und INTERVAL', async () => {
    const mk = (rule) => vcal(ev(['UID:a', 'SUMMARY:T', 'DTSTART;VALUE=DATE:20261116', 'RRULE:' + rule]));
    assert.equal((await expand(mk('FREQ=DAILY;COUNT=3'), '2026-11-01', '2026-12-31')).length, 3);
    assert.equal((await expand(mk('FREQ=DAILY;UNTIL=20261117'), '2026-11-01', '2026-12-31')).length, 2);
    assert.deepEqual(await expand(mk('FREQ=DAILY;INTERVAL=2'), '2026-11-16', '2026-11-21'), ['2026-11-16 ganztägig T', '2026-11-18 ganztägig T', '2026-11-20 ganztägig T']);
    assert.deepEqual(await expand(mk('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO'), '2026-11-16', '2026-12-31').then((x) => x.slice(0, 3)), ['2026-11-16 ganztägig T', '2026-11-30 ganztägig T', '2026-12-14 ganztägig T']);
  });
  test('COUNT zählt ab dem ersten Termin, auch vor dem sichtbaren Zeitraum', async () => {
    const r = await expand(vcal(ev(['UID:a', 'SUMMARY:C', 'DTSTART;VALUE=DATE:20261101', 'RRULE:FREQ=DAILY;COUNT=20'])), '2026-11-18', '2026-11-30');
    assert.deepEqual(r.map((x) => x.slice(0, 10)), ['2026-11-18', '2026-11-19', '2026-11-20']);
  });
  test('nicht unterstützte Regeln (BYSETPOS) zeigen den ersten Termin und stürzen nicht ab', async () => {
    const r = await expand(vcal(ev(['UID:a', 'SUMMARY:S', 'DTSTART;VALUE=DATE:20261118', 'RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1'])), '2026-11-18', '2026-11-18');
    assert.deepEqual(r, ['2026-11-18 ganztägig S']);
  });
  test('lang zurückliegende Serie wird schnell berechnet', async () => {
    const t0 = Date.now();
    const r = await expand(vcal(ev(['UID:a', 'SUMMARY:Alt', 'DTSTART;VALUE=DATE:20100101', 'RRULE:FREQ=DAILY'])), '2026-11-18', '2026-11-18');
    assert.equal(r.length, 1);
    assert.ok(Date.now() - t0 < 3000);
  });
});

/* =========================================================== Oberfläche */
for (const layout of Object.keys(LAYOUTS)) {
  describe(`Heute-Liste [${layout}]`, () => {
    test('zeigt die heutigen Termine sortiert: ganztägig zuerst, abgesagte fehlen', async () => {
      const h = await open({ layout });
      const sel = layout === 'wide' ? '#calpanel .cev' : '.calcard .cev';
      assert.deepEqual(await rowsOf(h.page.locator(sel)), ['ganztägig Müllabfuhr', '08:00–09:00 Frühstück', '09:30–11:00 Laufender Termin', '15:00–16:00 Zahnarzt Leah']);
    });
    test('Vergangenes ist abgeblendet, Laufendes hervorgehoben, Ort sichtbar', async () => {
      const h = await open({ layout });
      const base = layout === 'wide' ? '#calpanel' : '.calcard';
      assert.equal(await h.page.locator(base + ' .cev.past').count(), 1);
      assert.match(await h.page.locator(base + ' .cev.past').innerText(), /Frühstück/);
      assert.match(await h.page.locator(base + ' .cev.now').innerText(), /Laufender Termin/);
      assert.match(await h.page.locator(base).innerText(), /Praxis Dr\. Meier/);
      assert.match(await h.page.locator(base + ' .caldate').innerText(), /Mittwoch, 18\.11\./);
    });
    test('Termintitel mit HTML werden als Text angezeigt', async () => {
      const evil = vcal(ev(['UID:x', 'SUMMARY:<img src=x onerror=window.__pwned=1>', 'DTSTART' + BER + ':20261118T120000', 'DTEND' + BER + ':20261118T130000']));
      const h = await open({ layout, ics: [evil] });
      assert.equal(await h.page.locator('#board img, #calpanel img').count(), 0);
      assert.equal(await h.page.evaluate(() => !!window.__pwned), false);
      assert.match(await h.page.locator(layout === 'wide' ? '#calpanel' : '.calcard').innerText(), /<img src=x/);
    });
    test('Kalender aus: nichts davon sichtbar, kein Abruf', async () => {
      const h = await open({ layout, cfg: null });
      assert.equal(await h.page.locator('#calpanel').isVisible(), false);
      assert.equal(await h.page.locator('.calcard').count(), 0);
      assert.equal(await h.page.locator('#calbtn').isVisible(), false);
      assert.equal(h.calls.length, 0);
    });
    test('Abruf mit Zugangscode, Zeitraum um heute (−31 / +93 Tage)', async () => {
      const h = await open({ layout });
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].auth, 'Bearer tok');
      const u = new URL(h.calls[0].url);
      assert.equal(u.pathname, '/events');
      assert.equal(u.searchParams.get('from'), '2026-10-18');
      assert.equal(u.searchParams.get('to'), '2027-02-19');
    });
  });
}

describe('Platz je nach Bildschirmbreite', () => {
  test('breit: Liste steht rechts neben dem Raster, Raster bleibt nutzbar', async () => {
    const h = await open({ layout: 'wide' });
    const p = await h.page.locator('#calpanel').boundingBox(), b = await h.page.locator('#board').boundingBox();
    assert.ok(p.x >= b.x + b.width - 2, 'Liste rechts vom Raster');
    assert.ok(b.width > 600);
    assert.equal(await h.page.locator('#calbtn').isVisible(), false);
  });
  test('mittel (800 px): keine Liste, dafür Kalender-Knopf in der Kopfzeile', async () => {
    const h = await open({ viewport: { width: 800, height: 600 } });
    assert.equal(await h.page.locator('#calpanel').isVisible(), false);
    await h.page.locator('#calbtn').click();
    await h.page.waitForSelector('.dialog.cal');
    assert.match(await title(h), /November 2026/);
  });
  test('schmal: Karte oben im Scrollbereich, kein Seitenpanel', async () => {
    const h = await open({ layout: 'mobile' });
    assert.equal(await h.page.locator('#calpanel').isVisible(), false);
    assert.equal(await h.page.locator('#gbody > :first-child.calcard').count(), 1);
  });
});

for (const layout of Object.keys(LAYOUTS)) {
  describe(`Großer Kalender [${layout}]`, () => {
    test('Vergrößern öffnet die Monatsansicht mit Titel, 6 Wochen und markiertem heute', async () => {
      const h = await open({ layout });
      await openMax(h);
      assert.equal(await title(h), 'November 2026');
      assert.equal(await h.page.locator('.cday').count(), 42);
      assert.equal(await h.page.locator('.cday.today').getAttribute('data-date'), '2026-11-18');
      assert.equal(await h.page.locator('.cday.out').count(), 12, 'Tage des Vor- und Folgemonats abgeblendet');
      assert.deepEqual(await h.page.locator('.cwd div').allInnerTexts(), ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']);
    });
    test('Monat: Termine je Tag (Serien, Ausnahme, mehrtägig)', async () => {
      const h = await open({ layout });
      await openMax(h);
      const count = async (d) => +(/(\d+) Termine/.exec(await h.page.locator(`.cday[data-date="${d}"]`).getAttribute('aria-label'))[1]);
      assert.equal(await count('2026-11-18'), 4);
      assert.equal(await count('2026-11-17'), 1, 'Fußball dienstags');
      assert.equal(await count('2026-11-24'), 0, 'Ausnahme');
      assert.equal(await count('2026-11-19'), 2);
      for (const d of ['2026-11-20', '2026-11-21', '2026-11-22']) assert.equal(await count(d), 1, d);
      assert.equal(await count('2026-11-23'), 0);
      if (layout === 'wide') {
        const today = await h.page.locator('.cday[data-date="2026-11-18"]').innerText();
        assert.match(today, /Müllabfuhr/); assert.match(today, /\+ 2 weitere/, 'mehr als zwei Termine: Rest wird zusammengefasst');
        assert.match(await h.page.locator('.cday[data-date="2026-11-19"]').innerText(), /Fußball Ben \(verlegt\)/);
      } else {
        assert.equal(await h.page.locator('.cday[data-date="2026-11-18"] .cdot').count(), 4, 'schmal: Punkte statt Text');
      }
    });
    test('Tag antippen zeigt die Tagesliste, Termin antippen die Details', async () => {
      const h = await open({ layout });
      await openMax(h);
      await h.page.locator('.cday[data-date="2026-11-19"]').click();
      assert.deepEqual(await rowsOf(h.page.locator('.dialog.small .cev')), ['18:00–19:00 Fußball Ben (verlegt)', '19:30–21:00 Elternabend']);
      await h.page.locator('.dialog.small .cev', { hasText: 'Elternabend' }).click();
      const txt = await h.page.locator('.dialog.small').last().innerText();
      assert.match(txt, /Elternabend/); assert.match(txt, /Do 19\.11\.2026, 19:30–21:00/); assert.match(txt, /Schule/);
    });
    test('Details: Beschreibung mit Zeilenumbruch, ganztägig mehrtägig', async () => {
      const h = await open({ layout });
      await openMax(h);
      await h.page.locator('.cday[data-date="2026-11-18"]').click();
      await h.page.locator('.dialog.small .cev', { hasText: 'Zahnarzt' }).click();
      const d = await h.page.locator('.dialog.small .evdesc').last().innerText();
      assert.equal(d.replace(/\r/g, ''), 'Bitte Versichertenkarte\nmitnehmen');
      while (await h.page.locator('.dialog.small').count()) await h.page.locator('.dialog.small .dlg-foot button').last().click();
      await h.page.locator('.cday[data-date="2026-11-21"]').click();
      await h.page.locator('.dialog.small .cev', { hasText: 'Urlaub' }).click();
      assert.match(await h.page.locator('.dialog.small .evwhen').last().innerText(), /Fr 20\.11\.2026 – So 22\.11\.2026, ganztägig/);
    });
    test('Navigation Monat vor/zurück und Heute', async () => {
      const h = await open({ layout });
      await openMax(h);
      await h.page.locator('.calnext').click(); assert.equal(await title(h), 'Dezember 2026');
      await h.page.locator('.calnext').click(); await h.page.locator('.calnext').click(); assert.equal(await title(h), 'Februar 2027');
      await h.page.locator('.calprev').click(); await h.page.locator('.calprev').click(); await h.page.locator('.calprev').click(); await h.page.locator('.calprev').click();
      assert.equal(await title(h), 'Oktober 2026');
      await h.page.locator('.caltoday').click(); assert.equal(await title(h), 'November 2026');
    });
    test('Woche: Titel mit Kalenderwoche, Navigation, Heute', async () => {
      const h = await open({ layout });
      await openMax(h);
      await h.page.locator('.segweek').click();
      assert.equal(await title(h), 'KW 47 · 16.–22. Nov 2026');
      await h.page.locator('.calnext').click(); assert.equal(await title(h), 'KW 48 · 23.–29. Nov 2026');
      await h.page.locator('.calprev').click(); await h.page.locator('.calprev').click(); assert.equal(await title(h), 'KW 46 · 9.–15. Nov 2026');
      await h.page.locator('.caltoday').click(); assert.equal(await title(h), 'KW 47 · 16.–22. Nov 2026');
    });
    test('Woche über den Monatswechsel', async () => {
      const h = await open({ layout });
      await openMax(h);
      await h.page.locator('.segweek').click();
      await h.page.locator('.calnext').click(); await h.page.locator('.calnext').click();
      assert.equal(await title(h), 'KW 49 · 30. Nov – 6. Dez 2026');
    });
    test('Ansicht merken: nach Schließen und erneutem Öffnen bleibt Woche', async () => {
      const h = await open({ layout });
      await openMax(h);
      await h.page.locator('.segweek').click();
      await h.page.locator('.calclose').click();
      assert.equal(await h.page.locator('.dialog.cal').count(), 0);
      await openMax(h);
      assert.match(await title(h), /^KW 47/);
      assert.equal(await h.page.locator('.segweek.on').count(), 1);
    });
  });
}

describe('Wochenansicht breit: Zeitraster', () => {
  test('Termine stehen zur richtigen Stunde, ganztägig oben, Jetzt-Linie', async () => {
    const h = await open({ layout: 'wide' });
    await openMax(h);
    await h.page.locator('.segweek').click();
    assert.equal(await h.page.locator('.wkcol').count(), 7);
    const col = h.page.locator('.wkcol[data-date="2026-11-18"]');
    assert.equal(await col.locator('.wev').count(), 3);
    const z = col.locator('.wev', { hasText: 'Zahnarzt' });
    assert.equal(await z.evaluate((e) => e.style.top), '720px', '15:00 = 15 × 48 px');
    assert.equal(await z.evaluate((e) => e.style.height), '46px');
    const now = await col.locator('.nowline').evaluate((e) => parseFloat(e.style.top));
    assert.ok(now >= 480 && now < 495, 'Jetzt-Linie bei 10:00, war ' + now);
    assert.match(await h.page.locator('.wkall').innerText(), /Müllabfuhr/);
    assert.match(await h.page.locator('.wkall').innerText(), /Urlaub Oma/);
    assert.equal(await h.page.locator('.whd.today').getAttribute('data-date'), '2026-11-18');
  });
  test('Überlappende Termine stehen nebeneinander', async () => {
    const two = vcal(
      ev(['UID:a', 'SUMMARY:Eins', 'DTSTART' + BER + ':20261118T100000', 'DTEND' + BER + ':20261118T120000']),
      ev(['UID:b', 'SUMMARY:Zwei', 'DTSTART' + BER + ':20261118T110000', 'DTEND' + BER + ':20261118T130000']),
      ev(['UID:c', 'SUMMARY:Drei', 'DTSTART' + BER + ':20261118T140000', 'DTEND' + BER + ':20261118T150000']));
    const h = await open({ layout: 'wide', ics: [two] });
    await openMax(h);
    await h.page.locator('.segweek').click();
    const get = (t) => h.page.locator('.wkcol[data-date="2026-11-18"] .wev', { hasText: t }).evaluate((e) => [e.style.left, e.style.width]);
    assert.deepEqual(await get('Eins'), ['0%', 'calc(50% - 2px)']);
    assert.deepEqual(await get('Zwei'), ['50%', 'calc(50% - 2px)']);
    assert.deepEqual(await get('Drei'), ['0%', 'calc(100% - 2px)']);
  });
  test('Termin im Raster antippen öffnet die Details', async () => {
    const h = await open({ layout: 'wide' });
    await openMax(h);
    await h.page.locator('.segweek').click();
    await h.page.locator('.wev', { hasText: 'Zahnarzt' }).click();
    assert.match(await h.page.locator('.dialog.small').innerText(), /Praxis Dr\. Meier/);
  });
});

describe('Wochenansicht schmal: Tagesliste', () => {
  test('sieben Tage untereinander mit allen Terminen', async () => {
    const h = await open({ layout: 'mobile' });
    await openMax(h);
    await h.page.locator('.segweek').click();
    assert.equal(await h.page.locator('.agd').count(), 7);
    assert.match(await h.page.locator('.agd.today').innerText(), /Mittwoch, 18\.11\. · heute/);
    assert.equal(await h.page.locator('.agenda .cev').count(), 10);
  });
});

describe('Verbindung, Zwischenspeicher, Fehler', () => {
  test('Kalender weiter in der Zukunft: es wird nachgeladen, ein weiterer Abruf mit größerem Zeitraum', async () => {
    const h = await open({ layout: 'wide' });
    await openMax(h);
    for (let i = 0; i < 4; i++) await h.page.locator('.calnext').click();
    await h.page.waitForTimeout(400);
    assert.equal(await title(h), 'März 2027');
    assert.ok(h.calls.length >= 2, 'zweiter Abruf erwartet');
    const to = new URL(h.calls[h.calls.length - 1].url).searchParams.get('to');
    assert.ok(to >= '2027-04-01', 'Zeitraum muss den März abdecken, war bis ' + to);
  });
  test('Kein Netz: letzter Stand bleibt sichtbar, Hinweis "Offline"', async () => {
    const h = await open({ layout: 'wide' });
    h.state.mode = 'offline';
    await h.page.evaluate(() => new Promise((r) => window.__hp.cal.refresh(r)));
    const panel = h.page.locator('#calpanel');
    assert.match(await panel.locator('.calfoot').innerText(), /^Offline – Stand \d\d:\d\d/);
    assert.deepEqual((await rowsOf(panel.locator('.cev'))).length, 4, 'Termine bleiben sichtbar');
  });
  test('Nach dem Abruf wird ein Zwischenspeicher angelegt', async () => {
    const h = await open({ layout: 'wide' });
    const c = JSON.parse(await h.page.evaluate(() => localStorage.getItem('haushaltsplaner.calcache')));
    assert.equal(c.mode, 'worker'); assert.equal(c.url, 'https://cal.test');
    assert.ok(c.ics[0].includes('Zahnarzt Leah')); assert.ok(c.fetchedAt > 0);
  });
  test('Start ohne Netz: Termine kommen aus dem Zwischenspeicher, mit Hinweis "Offline"', async () => {
    const h = await open({ layout: 'wide', cache: true, offline: true });
    await h.page.waitForSelector('#calpanel .cev');
    assert.equal(await h.page.locator('#calpanel .cev').count(), 4);
    assert.match(await h.page.locator('#calpanel .calfoot').innerText(), /^Offline – Stand \d\d:\d\d/);
  });
  test('Zwischenspeicher einer anderen Adresse wird nicht verwendet', async () => {
    const h = await open({ layout: 'wide', cache: true, offline: true, cfg: { mode: 'worker', url: 'https://cal.test/anders', token: 'x', view: 'month' } });
    assert.equal(await h.page.locator('#calpanel .cev').count(), 0);
    assert.match(await h.page.locator('#calpanel .calempty').innerText(), /Heute keine Termine/);
  });
  test('Fehlermeldung des Workers wird angezeigt (Zugangscode falsch)', async () => {
    const h = await open({ layout: 'wide', wait: false });
    h.state.mode = 'error'; h.state.status = 401; h.state.error = 'Zugangscode falsch';
    await h.page.evaluate(() => new Promise((r) => window.__hp.cal.refresh(r)));
    assert.equal(await h.page.evaluate(() => window.__hp.cal.state.error), 'Zugangscode falsch');
    assert.match(await h.page.locator('#calpanel .calfoot').getAttribute('title'), /Zugangscode falsch/);
  });
  test('Zugangsdaten stehen nicht im Backup der Aufgabendaten', async () => {
    const h = await open({ layout: 'wide' });
    assert.ok(!(await h.page.evaluate(() => JSON.stringify(window.__hp.getData()))).includes('tok'));
    assert.ok(!(await h.page.evaluate((k) => localStorage.getItem(k), KEY)).includes('cal.test'));
  });
  test('Aktualisierung läuft regelmäßig im Hintergrund (alle 10 Minuten)', async () => {
    const h = await open({ layout: 'wide' });
    const n = h.calls.length;
    await h.page.clock.fastForward('10:05');
    await h.page.waitForTimeout(300);
    assert.ok(h.calls.length > n, 'erneuter Abruf nach 10 Minuten');
  });
  test('ICS-Adresse direkt: wird ohne Worker geladen', async () => {
    const h = await open({ layout: 'wide', cfg: { mode: 'ics', url: 'https://cal.test/familie.ics', token: '', view: 'month' }, wait: false });
    await h.ctx.route('https://cal.test/familie.ics', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/calendar', 'access-control-allow-origin': '*' }, body: FIXTURE }));
    await h.page.evaluate(() => new Promise((r) => window.__hp.cal.refresh(r)));
    assert.equal(await h.page.locator('#calpanel .cev').count(), 4);
  });
});

describe('Einstellungen', () => {
  test('Kalender verbinden: nur mit PIN, Demo zeigt Beispieltermine', async () => {
    const h = await open({ layout: 'wide', cfg: null });
    await h.page.locator('#gear').click();
    assert.ok((await h.page.locator('.pad').count()) > 0, 'PIN-Abfrage');
    await pin(h.page);
    assert.match(await h.page.locator('.dialog .sec h3', { hasText: 'Kalender' }).innerText(), /kalender/i);
    await h.page.locator('.calmode', { hasText: 'Demo' }).click();
    await h.page.locator('.calsave').click();
    await h.page.waitForTimeout(200);
    assert.match(await h.page.locator('.calmsg').innerText(), /Verbunden: \d+ Termine/);
    await h.page.getByRole('button', { name: 'Fertig' }).click();
    assert.match(await h.page.locator('#calpanel').innerText(), /Zahnarzt Leah/);
    assert.match(await h.page.locator('#calpanel .calfoot').innerText(), /Demo/);
  });
  test('Worker eintragen: verbindet mit Zugangscode und zeigt die Termine', async () => {
    const h = await open({ layout: 'wide', cfg: null });
    await h.page.locator('#gear').click(); await pin(h.page);
    await h.page.locator('.calmode', { hasText: 'iCloud' }).click();
    await h.page.locator('.calurl').fill('https://cal.test/');
    await h.page.locator('.caltoken').fill('geheim');
    await h.page.locator('.calsave').click();
    await h.page.waitForFunction(() => /Verbunden|Fehler/.test(document.querySelector('.calmsg').textContent));
    assert.match(await h.page.locator('.calmsg').innerText(), /Verbunden: [1-9]\d* Termine/);
    assert.equal(h.calls[h.calls.length - 1].auth, 'Bearer geheim');
    assert.equal(new URL(h.calls[h.calls.length - 1].url).pathname, '/events', 'doppelter Schrägstrich wird entfernt');
    await h.page.getByRole('button', { name: 'Fertig' }).click();
    assert.equal(await h.page.locator('#calpanel .cev').count(), 4);
    const saved = await h.page.evaluate((k) => JSON.parse(localStorage.getItem(k)), CAL_KEY);
    assert.deepEqual([saved.mode, saved.url, saved.token], ['worker', 'https://cal.test/', 'geheim']);
  });
  test('Fehler beim Verbinden wird verständlich angezeigt', async () => {
    const h = await open({ layout: 'wide', cfg: null });
    h.state.mode = 'error'; h.state.status = 404; h.state.error = 'Kalender "Familie" nicht gefunden. Vorhanden: Privat';
    await h.page.locator('#gear').click(); await pin(h.page);
    await h.page.locator('.calmode', { hasText: 'iCloud' }).click();
    await h.page.locator('.calurl').fill('https://cal.test');
    await h.page.locator('.caltoken').fill('x');
    await h.page.locator('.calsave').click();
    await h.page.waitForFunction(() => /Verbunden|Fehler/.test(document.querySelector('.calmsg').textContent));
    assert.match(await h.page.locator('.calmsg').innerText(), /Fehler: Kalender "Familie" nicht gefunden/);
  });
  test('Ausschalten entfernt Liste und Zwischenspeicher', async () => {
    const h = await open({ layout: 'wide' });
    assert.equal(await h.page.locator('#calpanel').isVisible(), true);
    await h.page.locator('#gear').click(); await pin(h.page);
    await h.page.locator('.calmode', { hasText: 'Aus' }).click();
    await h.page.locator('.calsave').click();
    await h.page.getByRole('button', { name: 'Fertig' }).click();
    assert.equal(await h.page.locator('#calpanel').isVisible(), false);
    assert.equal(await h.page.evaluate(() => localStorage.getItem('haushaltsplaner.calcache')), null);
  });
});
