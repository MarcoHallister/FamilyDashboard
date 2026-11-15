'use strict';
/*
 * Abnahmetests für den Haushaltsplaner (index.html).
 * Jeder Test hält eine Anforderung aus dem Konzept fest und läuft in beiden Layouts:
 *   - "mobile": Smartphone im Hochformat (Tagesleiste + Karten)
 *   - "wide":   Tablet/Querformat (Wochenraster)
 * Die Uhr ist eingefroren auf Mittwoch, 18.11.2026, damit es Vortage, heute und Zukunft gibt.
 *
 * Start:  npm install && npx playwright install chromium && npm test
 * Optional: APP_URL (andere Adresse testen, z. B. GitHub Pages), PW_CHROMIUM (Pfad zu Chromium).
 */
const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const APP_URL = process.env.APP_URL || pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const KEY = 'haushaltsplaner.v2';
const NOW = '2026-11-18T10:00:00+01:00';            /* Mittwoch */
const PIN = '1234', SALT = 'testsalt';
const MON = '2026-11-16', PAST = '2026-11-17', TODAY = '2026-11-18', FUTURE = '2026-11-20';
const LAYOUTS = {
  mobile: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  wide: { viewport: { width: 962, height: 601 } }
};

/* ---------------------------------------------------------------- Testdaten */
function assign(id, taskId, profileId, schedule) { return { id, taskId, profileId, valueOverride: null, schedule }; }
function seed(patch) {
  const all = [1, 2, 3, 4, 5, 6, 7];
  const data = {
    version: 2, savedAt: 1,
    settings: { pinHash: crypto.createHash('sha256').update(SALT + ':' + PIN).digest('hex'), pinSalt: SALT, currency: 'EUR', piggyFull: 20, selected: 'pa' },
    profiles: [
      { id: 'pa', name: 'Anna', color: '#e4572e', avatar: '', pinned: true, payouts: [] },
      { id: 'pb', name: 'Ben', color: '#2f6fde', avatar: '', pinned: true, payouts: [] }
    ],
    tasks: [
      { id: 't1', title: 'Zimmer aufräumen', icon: '🧹', value: 0.5, order: 0 },
      { id: 't2', title: 'Müll rausbringen', icon: '🗑️', value: 0.3, order: 1 },
      { id: 't3', title: 'Nur Ben', icon: '', value: 0.2, order: 2 }
    ],
    assignments: [
      assign('a1', 't1', 'pa', { type: 'weekdays', days: all }),
      assign('a2', 't1', 'pb', { type: 'weekdays', days: all }),
      assign('a3', 't2', 'pa', { type: 'interval', everyDays: 2, start: MON }),   /* fällig: 16., 18., 20., 22. */
      assign('a4', 't3', 'pb', { type: 'weekdays', days: all })
    ],
    completions: []
  };
  return Object.assign(data, patch || {});
}
const done = (profileId, taskId, date, value) => ({ profileId, taskId, date, value });

/* ------------------------------------------------------------------ Helfer */
let browser;
before(async () => {
  browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
});
after(async () => { await browser.close(); });

async function open(layout, data) {
  const ctx = await browser.newContext({ ...LAYOUTS[layout], timezoneId: 'Europe/Berlin', locale: 'de-DE' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.install({ time: new Date(NOW) });
  if (data) {
    await page.addInitScript(([k, v]) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v); }, [KEY, JSON.stringify(data)]);
  }
  await page.goto(APP_URL);
  await page.clock.resume();
  await page.waitForFunction(() => window.__hp && window.__hp.getData() && document.querySelector('#board'));
  await page.waitForTimeout(150);
  return { ctx, page, layout, errors };
}
let current = null;
async function start(layout, data) { current = await open(layout, data === undefined ? seed() : data); return current; }
afterEach(async () => {
  if (!current) return;
  const { ctx, errors } = current;
  current = null;
  await ctx.close();
  assert.deepEqual(errors, [], 'JavaScript-Fehler in der App: ' + errors.join(' | '));
});

function dayIndex(date) { return Math.round((Date.UTC(...date.split('-').map((x, i) => (i === 1 ? +x - 1 : +x))) - Date.UTC(2026, 10, 16)) / 864e5); }
/* Liefert den Locator der Zelle. In der Mobil-Ansicht wird dafür zuerst der Tag gewählt. */
async function cell(h, task, prof, date) {
  if (h.layout === 'mobile') await h.page.locator('.dchip').nth(dayIndex(date)).click();
  return h.page.locator(`[data-t="${task}"][data-p="${prof}"][data-d="${date}"]`);
}
const completions = (h) => h.page.evaluate(() => window.__hp.getData().completions.map((c) => c.profileId + '|' + c.taskId + '|' + c.date));
const balance = (h, pid) => h.page.evaluate((id) => window.__hp.balance(id), pid);
const padVisible = async (h) => (await h.page.locator('.pad').count()) > 0;
async function enterPin(h, pin = PIN) {
  for (const ch of pin) await h.page.locator('.pad button', { hasText: new RegExp('^' + ch + '$') }).click();
  await h.page.locator('.pad button', { hasText: /^OK$/ }).click();
  await h.page.waitForTimeout(80);
}
async function settleTick(h) { await h.page.waitForTimeout(1200); }   /* ein Takt der App-Uhr (1 s) */
async function unlockViaPastCell(h) {
  const c = await cell(h, 't1', 'pa', MON);
  await c.click();
  assert.ok(await padVisible(h), 'PIN-Feld erwartet');
  await enterPin(h);
  await settleTick(h);
}
const isActive = async (loc) => (await loc.count()) > 0 && !(await loc.first().isDisabled());
const isDoneCell = (loc) => loc.evaluate((el) => (el.closest('.c, .mrow') || el).classList.contains('done'));
const openMask = async (h, taskId) => { await h.page.locator(`[data-task="${taskId}"]`).first().click(); await h.page.waitForSelector('.dialog'); };

/* ============================================================ Logik (ohne UI) */
describe('Zeitplan-Logik (3.1)', () => {
  test('Wochentage: Mo/Mi/Fr', async () => {
    const h = await start('wide');
    const r = await h.page.evaluate(() => {
      const s = { type: 'weekdays', days: [1, 3, 5] };
      return ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'].map((d) => window.__hp.isDue(s, d));
    });
    assert.deepEqual(r, [true, false, true, false, true, false, false]);
  });
  test('Intervall alle 2 Tage ab 16.12.2026 (ein Mittwoch)', async () => {
    const h = await start('wide');
    const r = await h.page.evaluate(() => {
      const s = { type: 'interval', everyDays: 2, start: '2026-12-16' };
      return { wd: window.__hp.isoDay('2026-12-16'), due: ['2026-12-14', '2026-12-15', '2026-12-16', '2026-12-17', '2026-12-18', '2027-01-01'].map((d) => window.__hp.isDue(s, d)), txt: window.__hp.schedText(s) };
    });
    assert.equal(r.wd, 3, '16.12.2026 ist ein Mittwoch');
    assert.deepEqual(r.due, [false, false, true, false, true, true], 'vor dem Startdatum nie fällig');
    assert.equal(r.txt, 'alle 2 Tage ab Mi 16.12.2026');
  });
  test('Intervall ist sommerzeitfest', async () => {
    const h = await start('wide');
    const r = await h.page.evaluate(() => [window.__hp.diffDays('2027-03-29', '2027-03-27'), window.__hp.diffDays('2026-10-26', '2026-10-24')]);
    assert.deepEqual(r, [2, 2]);
  });
  test('Geldeingabe: Komma/Punkt, ungültig abgelehnt', async () => {
    const h = await start('wide');
    const r = await h.page.evaluate(() => ['0,50', '3.5', '12', 'abc', '1,234', ''].map((x) => window.__hp.parseMoney(x)));
    assert.equal(r[0], 50); assert.equal(r[1], 350); assert.equal(r[2], 1200);
    assert.ok(Number.isNaN(r[3]) && Number.isNaN(r[4]) && Number.isNaN(r[5]));
  });
  test('Backup: Import prüft die Struktur, Export/Import ist verlustfrei', async () => {
    const h = await start('wide', seed({ completions: [done('pa', 't1', TODAY, 0.5)] }));
    const r = await h.page.evaluate(() => {
      const d = window.__hp.getData();
      const n = window.__hp.normalize(JSON.parse(JSON.stringify(d)));
      return { bad: window.__hp.normalize({}) === null, same: [n.profiles.length, n.tasks.length, n.assignments.length, n.completions.length].join() === [d.profiles.length, d.tasks.length, d.assignments.length, d.completions.length].join() };
    });
    assert.equal(r.bad, true); assert.equal(r.same, true);
  });
});

/* ====================================================== Erststart & Speicherung */
describe('Erststart und Speicherung', () => {
  test('PIN wird nur als Hash gespeichert, Profile werden angelegt', async () => {
    const h = await start('wide', null);
    await h.page.getByRole('button', { name: 'PIN festlegen' }).click();
    await enterPin(h, '4711'); await enterPin(h, '4711');
    await h.page.locator('.dialog input.inp').nth(0).fill('Mia');
    await h.page.getByRole('button', { name: 'Los geht’s' }).click();
    await h.page.waitForTimeout(200);
    const s = await h.page.evaluate((k) => localStorage.getItem(k), KEY);
    const d = JSON.parse(s);
    assert.equal(d.profiles[0].name, 'Mia');
    assert.match(d.settings.pinHash, /^[0-9a-f]{64}$/);
    assert.ok(!s.includes('4711'), 'der PIN darf nicht im Klartext gespeichert sein');
  });
  test('Falsch wiederholter PIN wird nicht übernommen', async () => {
    const h = await start('wide', null);
    await h.page.getByRole('button', { name: 'PIN festlegen' }).click();
    await enterPin(h, '1111'); await enterPin(h, '2222');
    assert.ok(await padVisible(h), 'es muss erneut nach dem PIN gefragt werden');
    const hash = await h.page.evaluate(() => window.__hp.getData().settings.pinHash);
    assert.equal(hash, null);
  });
  for (const layout of Object.keys(LAYOUTS)) {
    test(`[${layout}] Erledigungen bleiben nach Neuladen erhalten`, async () => {
      const h = await start(layout);
      await (await cell(h, 't1', 'pa', TODAY)).click();
      assert.deepEqual(await completions(h), ['pa|t1|' + TODAY]);
      await h.page.reload();
      await h.page.waitForFunction(() => window.__hp && window.__hp.getData());
      assert.deepEqual(await completions(h), ['pa|t1|' + TODAY]);
    });
  }
});

/* ============================== Sperre für Vortage und Zukunft (4.4 / 4.7) */
for (const layout of Object.keys(LAYOUTS)) {
  describe(`Sperre für Vortage [${layout}]`, () => {
    test('heute: ohne PIN abhaken und zurücknehmen', async () => {
      const h = await start(layout);
      const c = await cell(h, 't1', 'pa', TODAY);
      await c.click();
      assert.equal(await padVisible(h), false);
      assert.deepEqual(await completions(h), ['pa|t1|' + TODAY]);
      await c.click();
      assert.deepEqual(await completions(h), []);
    });

    test('Vortag: PIN-Abfrage, falscher PIN ändert nichts, richtiger PIN hakt ab', async () => {
      const h = await start(layout);
      await (await cell(h, 't1', 'pa', PAST)).click();
      assert.ok(await padVisible(h), 'PIN-Abfrage erwartet');
      assert.deepEqual(await completions(h), []);
      await enterPin(h, '9999');
      assert.ok(await padVisible(h), 'nach falschem PIN bleibt das Feld offen');
      assert.deepEqual(await completions(h), [], 'falscher PIN darf nichts ändern');
      await enterPin(h, PIN);
      assert.deepEqual(await completions(h), ['pa|t1|' + PAST]);
    });

    test('Vortag zurücknehmen verlangt ebenfalls den PIN', async () => {
      const h = await start(layout, seed({ completions: [done('pa', 't1', PAST, 0.5)] }));
      await (await cell(h, 't1', 'pa', PAST)).click();
      assert.ok(await padVisible(h));
      assert.deepEqual(await completions(h), ['pa|t1|' + PAST], 'ohne PIN bleibt der Haken');
      await enterPin(h);
      assert.deepEqual(await completions(h), []);
    });

    test('nach PIN-Eingabe sind Vortage 2 Minuten frei, danach wieder gesperrt', async () => {
      const h = await start(layout);
      await unlockViaPastCell(h);
      assert.deepEqual(await completions(h), ['pa|t1|' + MON]);
      assert.equal(await h.page.locator('#lockind button').count(), 1, 'Entsperr-Anzeige erwartet');
      await (await cell(h, 't1', 'pb', PAST)).click();
      assert.equal(await padVisible(h), false, 'innerhalb der 2 Minuten kein PIN');
      await h.page.clock.fastForward('02:05');
      await settleTick(h);
      assert.equal(await h.page.locator('#lockind button').count(), 0, 'Entsperr-Anzeige muss verschwinden');
      const before = await completions(h);
      await (await cell(h, 't1', 'pa', PAST)).click();
      assert.ok(await padVisible(h), 'nach Ablauf wieder PIN-Abfrage');
      assert.deepEqual(await completions(h), before, 'nach Ablauf darf nichts geändert werden');
    });

    test('Sperre wird nach einer Eingabe nicht dauerhaft verlängert', async () => {
      const h = await start(layout);
      await unlockViaPastCell(h);
      for (let i = 0; i < 4; i++) { await h.page.clock.fastForward('00:40'); await h.page.mouse.click(5, 5); await h.page.waitForTimeout(50); }
      await settleTick(h);
      assert.equal(await h.page.locator('#lockind button').count(), 0, 'Antippen außerhalb geschützter Dialoge darf die Entsperrung nicht verlängern');
    });

    test('Zukunft ist immer gesperrt, auch mit PIN-Entsperrung', async () => {
      const h = await start(layout);
      await (await cell(h, 't1', 'pa', FUTURE)).click();
      assert.deepEqual(await completions(h), []);
      assert.equal(await padVisible(h), false, 'für die Zukunft gibt es keine PIN-Abfrage, sondern ein Nein');
      await unlockViaPastCell(h);
      await (await cell(h, 't1', 'pb', FUTURE)).click();
      assert.deepEqual((await completions(h)).filter((x) => x.endsWith(FUTURE)), []);
    });

    test('Entsperrung gilt nicht nach Neuladen', async () => {
      const h = await start(layout);
      await unlockViaPastCell(h);
      await h.page.reload();
      await h.page.waitForFunction(() => window.__hp && window.__hp.getData());
      await (await cell(h, 't1', 'pb', PAST)).click();
      assert.ok(await padVisible(h), 'nach dem Neuladen muss wieder gesperrt sein');
    });

    test('gesperrte Vortage zeigen ein Schloss, entsperrt nicht', async () => {
      const h = await start(layout);
      await cell(h, 't1', 'pa', PAST);
      assert.ok((await h.page.locator('#board .lock').count()) > 0, 'Schloss-Markierung für Vortage erwartet');
      await unlockViaPastCell(h);
      await cell(h, 't1', 'pa', PAST);
      assert.equal(await h.page.locator('#board .lock').count(), 0, 'entsperrt: keine Schlösser');
    });

    test('5 Fehlversuche sperren die PIN-Eingabe kurz', async () => {
      const h = await start(layout);
      await (await cell(h, 't1', 'pa', PAST)).click();
      for (let i = 0; i < 5; i++) await enterPin(h, '0000');
      await enterPin(h, PIN);
      assert.match(await h.page.locator('.pinmsg').textContent(), /Zu viele Versuche/);
      assert.deepEqual(await completions(h), []);
      await h.page.clock.fastForward('00:35');
      await enterPin(h, PIN);
      assert.deepEqual(await completions(h), ['pa|t1|' + PAST]);
    });
  });
}

/* ================================== Zellzustände, Zuordnung, Anzeige (4.1–4.4) */
for (const layout of Object.keys(LAYOUTS)) {
  describe(`Raster und Zuordnung [${layout}]`, () => {
    test('nicht fälliger Tag ist nicht bedienbar, fälliger schon', async () => {
      const h = await start(layout);
      assert.equal(await isActive(await cell(h, 't2', 'pa', PAST)), false, 'Müll ist am 17.11. nicht fällig');
      assert.equal(await isActive(await cell(h, 't2', 'pa', TODAY)), true, 'Müll ist am 18.11. fällig');
    });
    test('Aufgabe nur für Ben ist bei Anna nicht bedienbar', async () => {
      const h = await start(layout);
      assert.equal(await isActive(await cell(h, 't3', 'pa', TODAY)), false);
      assert.equal(await isActive(await cell(h, 't3', 'pb', TODAY)), true);
    });
    test('erledigter Eintrag bleibt sichtbar, auch wenn der Tag nicht mehr fällig ist', async () => {
      const h = await start(layout, seed({ completions: [done('pa', 't2', PAST, 0.3)] }));
      const c = await cell(h, 't2', 'pa', PAST);
      assert.equal(await isActive(c), true);
      assert.equal(await isDoneCell(c), true);
    });
    test('Beträge sind eine Momentaufnahme und zählen zum Saldo', async () => {
      const h = await start(layout);
      await (await cell(h, 't1', 'pa', TODAY)).click();
      await openMask(h, 't1');
      await h.page.getByRole('button', { name: /Bearbeiten/ }).click();
      await enterPin(h);
      await h.page.locator('.dialog input.inp.short').first().fill('1,00');
      await h.page.locator('.dlg-foot').getByRole('button', { name: 'Speichern' }).click();
      const c = await h.page.evaluate(() => window.__hp.getData().completions[0].value);
      assert.equal(c, 0.5, 'alte Erledigung behält den damaligen Betrag');
      assert.equal(await balance(h, 'pa'), 50);
      await (await cell(h, 't1', 'pb', TODAY)).click();
      assert.equal(await balance(h, 'pb'), 100, 'neue Erledigung nutzt den neuen Betrag');
    });
    test('Sparschwein zeigt den Saldo', async () => {
      const h = await start(layout);
      await (await cell(h, 't1', 'pa', TODAY)).click();
      await h.page.waitForFunction(() => document.querySelector('.amount') && /0,50/.test(document.querySelector('.amount').textContent), null, { timeout: 5000 });
    });
    test('Sparschwein animiert beim Abhaken, aber nicht erneut beim Tages- oder Wochenwechsel', async () => {
      const h = await start(layout);
      /* je Profil eine Aufgabe abhaken (wie im Alltag), dann den Tag wechseln */
      await (await cell(h, 't1', 'pa', TODAY)).click();
      assert.equal(await h.page.locator('.pig.wobble').count(), 1, 'beim Abhaken wackelt das Schwein');
      assert.equal(await h.page.locator('.coin.drop').count(), 1, 'beim Abhaken fällt eine Münze');
      await (await cell(h, 't1', 'pb', TODAY)).click();
      const change = async () => { if (layout === 'mobile') await h.page.locator('.dchip').nth(0).click(); else await h.page.locator('#nextw').click(); await h.page.waitForTimeout(100); };
      await change();
      assert.equal(await h.page.locator('.pig.wobble').count(), 0, 'Wechsel darf die Animation in keinem Profil neu starten');
      assert.equal(await h.page.locator('.coin.drop').count(), 0);
      assert.equal(await h.page.evaluate(() => document.getAnimations().filter((a) => /wobble|drop/.test(a.animationName || '')).length), 0, 'keine laufende Sparschwein-Animation');
    });
    test('Animations-Klassen verschwinden von selbst, auch ohne Neuaufbau', async () => {
      const h = await start(layout);
      await (await cell(h, 't1', 'pa', TODAY)).click();
      await h.page.waitForTimeout(1700);
      assert.equal(await h.page.locator('.pig.wobble').count(), 0);
      assert.equal(await h.page.locator('.coin.drop').count(), 0);
    });
    test('Versionsnummer ist sichtbar', async () => {
      const h = await start(layout);
      assert.match(await h.page.locator('.ver').first().innerText(), /^Version \d/);
    });
    test('nur Symbol, kein Aufgabenname im Raster', async () => {
      const h = await start(layout);
      const text = await h.page.locator('#board').innerText();
      for (const name of ['Zimmer aufräumen', 'Müll rausbringen', 'Nur Ben']) assert.ok(!text.includes(name), name + ' darf nicht als Text erscheinen');
      assert.equal(await h.page.locator('[data-task="t1"] .ticon.emo').first().textContent(), '🧹');
    });
    test('Aufgabe ohne Symbol zeigt die ersten zwei Buchstaben', async () => {
      const h = await start(layout);
      assert.equal(await h.page.locator('[data-task="t3"] .ticon.ini').first().textContent(), 'NU');
    });
    test('gepinnte Profile werden gleichzeitig angezeigt, Entpinnen zeigt nur eines', async () => {
      const h = await start(layout);
      const sel = layout === 'mobile' ? '.mcard' : '.ph';
      assert.equal(await h.page.locator(sel).count(), 2);
      await h.page.locator('.pinbtn').nth(1).click();
      assert.equal(await h.page.locator(sel).count(), 1);
    });
    test('Woche Montag bis Sonntag, heute hervorgehoben, Wochennavigation', async () => {
      const h = await start(layout);
      const heads = layout === 'mobile' ? '.dchip' : '.dh';
      assert.equal(await h.page.locator(heads).count(), layout === 'mobile' ? 7 : 14);
      assert.equal(await h.page.locator(layout === 'mobile' ? '.dchip.today .dn' : '.dh.today').first().innerText().then((t) => t.replace(/\s+/g, ' ')), layout === 'mobile' ? '18' : 'Mi 18.11.');
      assert.match(await h.page.locator('#weeklabel').innerText(), /KW 47/);
      await h.page.locator('#nextw').click();
      assert.match(await h.page.locator('#weeklabel').innerText(), /KW 48/);
      await h.page.locator('#todayw').click();
      assert.match(await h.page.locator('#weeklabel').innerText(), /KW 47/);
    });
  });
}

/* ===== Entsperrung darf nach geschützten Dialogen nicht „hängen bleiben“ ===== */
async function assertRelocksAfter(h) {
  for (let i = 0; i < 4; i++) { await h.page.clock.fastForward('00:40'); await h.page.mouse.click(5, 5); await h.page.waitForTimeout(50); }
  await settleTick(h);
  assert.equal(await h.page.locator('#lockind button').count(), 0, 'Entsperrung muss nach 2 Minuten enden');
  const before = await completions(h);
  await (await cell(h, 't1', 'pa', PAST)).click();
  assert.ok(await padVisible(h), 'Vortag muss wieder nach dem PIN fragen');
  assert.deepEqual(await completions(h), before);
}
for (const layout of Object.keys(LAYOUTS)) {
  describe(`Sperre nach geschützten Dialogen [${layout}]`, () => {
    test('Einstellungen schließen', async () => {
      const h = await start(layout);
      await h.page.locator('#gear').click(); await enterPin(h);
      await h.page.getByRole('button', { name: 'Fertig' }).click();
      await settleTick(h);
      await assertRelocksAfter(h);
    });
    test('Aufgabenmaske bearbeiten und speichern', async () => {
      const h = await start(layout);
      await openMask(h, 't1');
      await h.page.getByRole('button', { name: /Bearbeiten/ }).click(); await enterPin(h);
      await h.page.locator('.dlg-foot').getByRole('button', { name: 'Speichern' }).click();
      await settleTick(h);
      await assertRelocksAfter(h);
    });
    test('Aufgabenmaske nur ansehen und schließen', async () => {
      const h = await start(layout);
      await openMask(h, 't1');
      await h.page.getByRole('button', { name: /Bearbeiten/ }).click(); await enterPin(h);
      await h.page.locator('.dlg-foot').getByRole('button', { name: 'Abbrechen' }).click();
      await h.page.locator('.dlg-foot').getByRole('button', { name: 'Schließen' }).click();
      await settleTick(h);
      await assertRelocksAfter(h);
    });
    test('Neue Aufgabe abbrechen', async () => {
      const h = await start(layout);
      await h.page.getByRole('button', { name: '+ Neue Aufgabe' }).click(); await enterPin(h);
      await h.page.locator('.dlg-foot').getByRole('button', { name: 'Abbrechen' }).click();
      await settleTick(h);
      await assertRelocksAfter(h);
    });
    test('Auszahlung abbrechen', async () => {
      const h = await start(layout, seed({ completions: [done('pa', 't1', TODAY, 0.5)] }));
      await h.page.locator('.pf button').first().click(); await enterPin(h);
      await h.page.locator('.dlg-foot').getByRole('button', { name: 'Abbrechen' }).click();
      await settleTick(h);
      await assertRelocksAfter(h);
    });
    test('Löschen einer Aufgabe', async () => {
      const h = await start(layout);
      await openMask(h, 't3');
      await h.page.getByRole('button', { name: /Bearbeiten/ }).click(); await enterPin(h);
      await h.page.locator('.dlg-foot').getByRole('button', { name: 'Löschen' }).click();
      await h.page.locator('.dialog.small .dlg-foot').getByRole('button', { name: 'Löschen' }).click();
      await settleTick(h);
      await assertRelocksAfter(h);
    });
  });
}

/* ================================== PIN-geschützte Bereiche (4.6 / 4.8 / 5) */
for (const layout of Object.keys(LAYOUTS)) {
  describe(`PIN-Schutz [${layout}]`, () => {
    test('Aufgabenmaske öffnet im Lesemodus, Bearbeiten nur mit PIN', async () => {
      const h = await start(layout);
      await openMask(h, 't1');
      assert.equal(await h.page.locator('.dialog input.inp').first().isDisabled(), true, 'Felder im Lesemodus gesperrt');
      await h.page.getByRole('button', { name: /Bearbeiten/ }).click();
      assert.ok(await padVisible(h));
      await enterPin(h, '9999');
      assert.equal(await h.page.locator('.dialog input.inp').first().isDisabled(), true, 'falscher PIN: weiter gesperrt');
      await enterPin(h, PIN);
      assert.equal(await h.page.locator('.dialog input.inp').first().isDisabled(), false);
      await h.page.locator('.dialog input.inp').first().fill('Zimmer neu');
      await h.page.locator('.dlg-foot').getByRole('button', { name: 'Speichern' }).click();
      assert.equal(await h.page.evaluate(() => window.__hp.getData().tasks[0].title), 'Zimmer neu');
    });
    test('Maske fällt nach Ablauf der Entsperrung in den Lesemodus zurück', async () => {
      const h = await start(layout);
      await openMask(h, 't1');
      await h.page.getByRole('button', { name: /Bearbeiten/ }).click();
      await enterPin(h);
      await settleTick(h);
      await h.page.clock.fastForward('02:05');
      await settleTick(h);
      assert.equal(await h.page.locator('.dialog input.inp').first().isDisabled(), true);
      assert.match(await h.page.locator('.dialog .notice').textContent(), /abgelaufen/);
    });
    test('Neue Aufgabe anlegen verlangt den PIN und prüft den Namen', async () => {
      const h = await start(layout);
      await h.page.getByRole('button', { name: '+ Neue Aufgabe' }).click();
      assert.ok(await padVisible(h));
      await enterPin(h);
      await h.page.locator('.dlg-foot').getByRole('button', { name: 'Speichern' }).click();
      assert.match(await h.page.locator('.errors').textContent(), /Name/);
      assert.equal(await h.page.evaluate(() => window.__hp.getData().tasks.length), 3);
    });
    test('Löschen fragt nach, entfernt die Aufgabe, Erledigungen zählen weiter', async () => {
      const h = await start(layout, seed({ completions: [done('pa', 't1', TODAY, 0.5)] }));
      await openMask(h, 't1');
      await h.page.getByRole('button', { name: /Bearbeiten/ }).click();
      await enterPin(h);
      await h.page.locator('.dlg-foot').getByRole('button', { name: 'Löschen' }).click();
      await h.page.locator('.dialog.small .dlg-foot').getByRole('button', { name: 'Löschen' }).click();
      const r = await h.page.evaluate(() => ({ tasks: window.__hp.getData().tasks.map((t) => t.id), a: window.__hp.getData().assignments.filter((a) => a.taskId === 't1').length }));
      assert.deepEqual(r.tasks, ['t2', 't3']);
      assert.equal(r.a, 0);
      assert.equal(await balance(h, 'pa'), 50);
    });
    test('Auszahlen: PIN nötig, Betrag wird abgezogen und protokolliert', async () => {
      const h = await start(layout, seed({ completions: [done('pa', 't1', TODAY, 0.5), done('pa', 't2', TODAY, 0.3)] }));
      await h.page.locator('.pf button').first().click();
      assert.ok(await padVisible(h));
      await enterPin(h);
      await h.page.locator('.dialog input.inp').fill('0,30');
      await h.page.locator('.dlg-foot').getByRole('button', { name: 'Auszahlen' }).click();
      const p = await h.page.evaluate(() => window.__hp.getData().profiles[0].payouts);
      assert.equal(p.length, 1);
      assert.equal(p[0].amount, 0.3);
      assert.match(p[0].date, /^2026-11-18T\d\d:\d\d:\d\d$/);
      assert.equal(await balance(h, 'pa'), 50);
    });
    test('Auszahlen: mehr als das Guthaben wird abgelehnt', async () => {
      const h = await start(layout, seed({ completions: [done('pa', 't1', TODAY, 0.5)] }));
      await h.page.locator('.pf button').first().click();
      await enterPin(h);
      await h.page.locator('.dialog input.inp').fill('9,99');
      await h.page.locator('.dlg-foot').getByRole('button', { name: 'Auszahlen' }).click();
      assert.equal(await h.page.evaluate(() => window.__hp.getData().profiles[0].payouts.length), 0);
      assert.equal(await balance(h, 'pa'), 50);
    });
    test('Einstellungen nur mit PIN', async () => {
      const h = await start(layout);
      await h.page.locator('#gear').click();
      assert.ok(await padVisible(h));
      await enterPin(h, '9999');
      assert.equal(await h.page.locator('.dialog .sec').count(), 0, 'falscher PIN: Einstellungen bleiben verborgen');
      await enterPin(h, PIN);
      assert.ok((await h.page.locator('.dialog .sec').count()) > 0, 'richtiger PIN: Einstellungen sichtbar');
    });
    test('Standardaufgaben ergänzen: fehlende kommen dazu, vorhandene bleiben', async () => {
      const h = await start(layout);
      await h.page.locator('#gear').click();
      await enterPin(h);
      await h.page.getByRole('button', { name: 'Standardaufgaben ergänzen' }).click();
      const titles = await h.page.evaluate(() => window.__hp.getData().tasks.map((t) => t.title));
      for (const t of ['Spülmaschine', 'Staubsaugen', 'Waschmaschine', 'Trockner', 'Zimmer aufräumen', 'Hase füttern', 'Zähne putzen', 'Haare kämmen', 'Hausaufgaben', 'Schultasche packen', 'Tisch decken', 'Tisch abwischen']) {
        assert.equal(titles.filter((x) => x === t).length, 1, t + ' genau einmal');
      }
      const icon = await h.page.evaluate(() => window.__hp.getData().tasks.find((t) => t.title === 'Zimmer aufräumen').icon);
      assert.equal(icon, '🧹');
    });
  });
}
