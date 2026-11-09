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

const load = (name) => readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8');
const questions = JSON.parse(load('questions')).questions;

/** Map a runner route to its recorded response (status, body). */
function fixtureFor(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/^\/api/, '');
  const ok = (body) => ({ status: 200, body });
  if (p === '/config') return ok(load('config'));
  if (p === '/agents') return ok(load('agents'));
  if (p === '/disclosure') return ok(load('disclosure'));
  if (p === '/analytics/leaderboard') return ok(load('leaderboard'));
  if (p === '/analytics/economics') return ok(load('economics'));
  if (p === '/activity') return ok(load('activity'));
  if (p === '/questions') {
    const from = Number(u.searchParams.get('from_index') ?? '0');
    return ok(from === 0 ? load('questions') : JSON.stringify({ questions: [] }));
  }
  let m = p.match(/^\/questions\/(\d+)\/comparison$/);
  if (m && existsSync(path.join(FIXTURES, `comparison-${m[1]}.json`))) return ok(load(`comparison-${m[1]}`));
  m = p.match(/^\/questions\/(\d+)\/rationale$/);
  if (m && existsSync(path.join(FIXTURES, `rationale-${m[1]}.json`))) {
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
];

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
      const page = await ctx.newPage();
      await page.route('**/api/**', (route) =>
        s.down
          ? route.abort('connectionrefused')
          : route.fulfill({ ...fixtureFor(route.request().url()), contentType: 'application/json' }),
      );
      await page.goto(`${BASE}/${s.query}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
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
  const page = await ctx.newPage();
  await page.route('**/api/**', (route) => route.fulfill({ ...fixtureFor(route.request().url()), contentType: 'application/json' }));
  await page.goto(`${BASE}/?round=4`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: 'Replay' }).click();
  await page.waitForTimeout(1100);
  await page.locator('canvas').screenshot({ path: path.join(OUT, 'settled-coins-in-flight-stage.png') });
  console.log('settled-coins-in-flight-stage.png  (q4 coins mid-flight)');
  await ctx.close();
} finally {
  await browser.close();
}
