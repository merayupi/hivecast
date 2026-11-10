/**
 * Playwright screenshots of every Arena scene state that has a recorded
 * real API response in test/fixtures/. The runner API is replaced by the
 * fixtures via request interception, so the app runs unmodified.
 *
 *   npm run dev --workspace @hivecast/dashboard        # in one terminal
 *   npm run screenshots --workspace @hivecast/dashboard
 *
 * BASE_URL (default http://localhost:5173) selects the dashboard to shoot.
 * Output: packages/dashboard/test/screenshots/<state>-<viewport>.png
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures');
const OUT = path.join(HERE, 'screenshots');
const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
mkdirSync(OUT, { recursive: true });

/**
 * A recorded set: files in `dir` (a folder under fixtures/, e.g. a live
 * snapshot) win; routes that folder did not record fall back to the base set.
 */
function fixtureSet(dir) {
  const file = (name) => {
    const own = dir ? path.join(FIXTURES, dir, `${name}.json`) : null;
    return own && existsSync(own) ? own : path.join(FIXTURES, `${name}.json`);
  };
  const has = (name) => existsSync(file(name));
  const load = (name) => readFileSync(file(name), 'utf8');
  const questions = JSON.parse(load('questions')).questions;
  return { has, load, questions };
}

/** Map a runner route to its recorded response (status, body). */
function fixtureFor(url, set) {
  const { has, load, questions } = set;
  const u = new URL(url);
  const p = u.pathname.replace(/^\/api/, '');
  const ok = (body) => ({ status: 200, body });
  if (p === '/config') return ok(load('config'));
  if (p === '/agents') return ok(load('agents'));
  if (p === '/disclosure') return ok(load('disclosure'));
  if (p === '/analytics/leaderboard') return ok(load('leaderboard'));
  if (p === '/analytics/economics') return ok(load('economics'));
  if (p === '/activity') return ok(load('activity'));
  if (p === '/simulation/report') return ok(load('simulation-report'));
  if (p === '/questions') {
    const from = Number(u.searchParams.get('from_index') ?? '0');
    return ok(from === 0 ? load('questions') : JSON.stringify({ questions: [] }));
  }
  let m = p.match(/^\/questions\/(\d+)\/comparison$/);
  if (m && has(`comparison-${m[1]}`)) return ok(load(`comparison-${m[1]}`));
  m = p.match(/^\/questions\/(\d+)\/rationale$/);
  if (m && has(`rationale-${m[1]}`)) {
    const body = load(`rationale-${m[1]}`);
    const err = JSON.parse(body).error;
    return { status: err === 'not_revealed' ? 403 : err ? 404 : 200, body };
  }
  m = p.match(/^\/questions\/(\d+)$/);
  if (m) {
    const q = questions.find((x) => x.question_id === Number(m[1]));
    return q ? ok(JSON.stringify(q)) : { status: 404, body: '{"error":"not_found"}' };
  }
  return { status: 404, body: '{"error":"not_recorded"}' };
}

const STATES = [
  { name: 'settled-yes', query: '?round=4', note: 'q4 settled, Outcome YES' },
  { name: 'settled-no', query: '?round=3', note: 'q3 settled, Outcome NO' },
  { name: 'cancelled-refunds', query: '?round=5', note: 'q5 cancelled with 6 commitments' },
  { name: 'cancelled-empty', query: '?round=0', note: 'q0 cancelled, no commitments' },
  { name: 'default-pick', query: '', note: 'auto-picked default Round' },
  { name: 'no-data-api-down', query: '', note: 'runner API unreachable', down: true },
  { name: 'season-replay-start', query: '#simulation', note: 'REPLAY: Season Replay at the start' },
  { name: 'season-replay-final', query: '#simulation', note: 'REPLAY: final standings (Play, reduced motion jumps to the end)', click: 'Play' },
  { name: 'rounds-tab', query: '#ledger', note: 'ROUNDS: the Round list as a sheet in the night frame' },
  { name: 'agents-tab', query: '#agents', note: 'AGENTS: one card per roster agent' },
  { name: 'guide-tab', query: '#trust', note: 'GUIDE: how it works, glossary, trust boundary' },
  { name: 'tour-first-visit', query: '', note: 'first visit: the guided tour opens by itself', tour: true },
  // Live snapshots (fixtures/live/<time>-<phases>/), shot at their recording time.
  { name: 'live-scheduled', dir: 'live/t1-open', query: '?round=7', note: 'q7 created, commitment window not open yet' },
  { name: 'live-open', dir: 'live/t1-open', query: '?round=12', note: 'q12 open, 6 commitments sealed' },
  { name: 'live-sealing', dir: 'live/085511-q6closedS-q12closed', query: '?round=12', note: 'q12 closed, snapshot not ready yet' },
  { name: 'live-snapshot-sale', dir: 'live/085541-q6closedS-q12closedS', query: '', note: 'q12 on sale (auto-picked)' },
  { name: 'live-observing', dir: 'live/084928-q6closedS-q12open', query: '?round=6', note: 'q6 event being observed' },
  { name: 'live-resolved', dir: 'live/090120-q6resolvedS-q12closedS', query: '', note: 'q6 resolved, reveals in progress (auto-picked)' },
  { name: 'live-settled', dir: 'live/091629-q6settledS-q12closedS', query: '?round=6', note: 'q6 settled' },
];

/** Marks the guided tour as seen, so it does not cover the page under test. */
const SKIP_TOUR = () => {
  try {
    window.localStorage.setItem('hivecast.tour.v1', 'done');
  } catch {
    // storage unavailable: the app never auto-opens the tour then
  }
};

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
];

// Prefer an installed Chrome/Edge (PW_CHANNEL, default "chrome") so no
// browser download is needed; fall back to Playwright's own Chromium.
const browser = await chromium
  .launch({ channel: process.env.PW_CHANNEL ?? 'chrome' })
  .catch(() => chromium.launch());
try {
  for (const vp of VIEWPORTS) {
    for (const s of STATES) {
      // Reduced motion → the deterministic final frame of each story.
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, reducedMotion: 'reduce' });
      // Every state but the first-visit one starts with the tour already seen.
      if (!s.tour) await ctx.addInitScript(SKIP_TOUR);
      const page = await ctx.newPage();
      const set = fixtureSet(s.dir);
      // Live snapshots are shot at the moment they were recorded, so the
      // schedule-driven states (snapshot sale, observing, ...) match the data.
      if (s.dir) await page.clock.setFixedTime(new Date(JSON.parse(set.load('leaderboard')).generated_at));
      await page.route('**/api/**', (route) =>
        s.down
          ? route.abort('connectionrefused')
          : route.fulfill({ ...fixtureFor(route.request().url(), set), contentType: 'application/json' }),
      );
      await page.goto(`${BASE}/${s.query}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      if (s.click) await page.getByRole('button', { name: s.click, exact: true }).click();
      await page.waitForTimeout(800);
      const file = path.join(OUT, `${s.name}-${vp.name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      console.log(`${s.name}-${vp.name}.png  (${s.note})${overflow > 0 ? `  ⚠ horizontal overflow ${overflow}px` : ''}`);
      await ctx.close();
    }
  }

  // One mid-story frame with motion on: coins in flight on the settled Round.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(SKIP_TOUR);
  const page = await ctx.newPage();
  const base = fixtureSet(null);
  await page.route('**/api/**', (route) => route.fulfill({ ...fixtureFor(route.request().url(), base), contentType: 'application/json' }));
  await page.goto(`${BASE}/?round=4`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: 'Play again' }).click();
  await page.waitForTimeout(1100);
  await page.locator('canvas').screenshot({ path: path.join(OUT, 'settled-coins-in-flight-stage.png') });
  console.log('settled-coins-in-flight-stage.png  (q4 coins mid-flight)');
  await page.goto(`${BASE}/#simulation`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: '16×' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(1800);
  await page.locator('canvas').screenshot({ path: path.join(OUT, 'season-replay-16x-midrace-stage.png') });
  console.log('season-replay-16x-midrace-stage.png  (price season at 16×, mid-race)');
  await ctx.close();
} finally {
  await browser.close();
}
