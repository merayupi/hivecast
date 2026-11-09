/**
 * Public HTTP service — health, config, public questions, leaderboard,
 * wallet Round/balance/pending/refund views, Forecast Access auth + delivery.
 *
 * Deliberately narrow: it never exposes administrative signing, private
 * forecasts, salts, the private database, or signing keys. Claim/withdraw
 * remain buyer wallet signed contract calls; this service never impersonates
 * a buyer. Forecast Access requires a one-use NEP-413 ownership challenge and
 * a finalized `has_bought` before any frozen snapshot is delivered.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Runtime } from './runtime.js';
import { AccessError, ACCESS_HTTP_STATUS } from './access/index.js';
import { ChainUnavailableError } from './chain/index.js';
import { ACTIVITY_MAX_LIMIT } from './public-data.js';

const MAX_BODY_BYTES = 64 * 1024;

interface AccessConfigLike {
  cookieName: string;
  cookieSecure: boolean;
  sessionTtlMs: number;
  allowedOrigins: string[];
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  runtime: Runtime,
  extraHeaders?: Record<string, string>,
): void {
  applyCors(res, runtime.config.access);
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  res.end(payload);
}

function applyCors(res: ServerResponse, access: AccessConfigLike): void {
  // The browser Origin is echoed only when allow-listed; credentials are on.
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('vary', 'Origin');
}

function originAllowed(origin: string | null, allowedOrigins: string[]): boolean {
  if (!origin) return true; // non-browser client (CLI/node fetch) — not CSRF-able
  return allowedOrigins.includes(origin);
}

function corsOriginHeader(req: IncomingMessage, allowedOrigins: string[]): string | null {
  const origin = req.headers.origin ?? null;
  if (origin && allowedOrigins.includes(origin)) return origin;
  return null;
}

/** Parse a JSON request body with a hard size cap. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AccessError('invalid_request', 400, 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve({});
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          reject(new AccessError('invalid_request', 400, 'request body must be a JSON object'));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new AccessError('invalid_request', 400, 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/** Parse the session cookie value (or null). */
function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === name) return decodeURIComponent(value);
  }
  return null;
}

function sessionCookieHeader(
  access: AccessConfigLike,
  value: string | null,
): { name: string; header: string } {
  const maxAge = Math.floor(access.sessionTtlMs / 1000);
  const secure = access.cookieSecure ? '; Secure' : '';
  if (value === null) {
    return {
      name: access.cookieName,
      header: `${access.cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`,
    };
  }
  return {
    name: access.cookieName,
    header: `${access.cookieName}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`,
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Parse a question id route segment; `null` when it is not an integer. */
function parseQuestionId(raw: string | undefined): number | null {
  const questionId = Number(raw);
  return Number.isInteger(questionId) ? questionId : null;
}

interface Pagination {
  fromIndex: number;
  limit: number;
}

/** Shared pagination conversion for list routes (empty/missing → defaults). */
function pagination(url: URL): Pagination {
  return {
    fromIndex: Number(url.searchParams.get('from_index') ?? '0'),
    limit: Number(url.searchParams.get('limit') ?? '20'),
  };
}

export function createPublicService(runtime: Runtime): Server {
  return createServer(async (req, res) => {
    try {
      const access = runtime.config.access;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const parts = url.pathname.split('/').filter(Boolean);

      // CORS preflight + response origin header for the Vite proxy.
      const allowedOrigin = corsOriginHeader(req, access.allowedOrigins);
      if (allowedOrigin) {
        res.setHeader('access-control-allow-origin', allowedOrigin);
      }
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-max-age', '600');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, { status: 'ok', domain: 'hivecast-runner' }, runtime);
      }

      if (req.method === 'GET' && url.pathname === '/config') {
        return sendJson(res, 200, runtime.getPublicConfig(), runtime);
      }

      if (req.method === 'GET' && url.pathname === '/disclosure') {
        return sendJson(res, 200, runtime.getAccessDisclosure(), runtime);
      }

      if (req.method === 'GET' && url.pathname === '/agents') {
        return sendJson(res, 200, { agents: runtime.getAgentRoster() }, runtime);
      }

      if (req.method === 'GET' && url.pathname === '/simulation/report') {
        return sendJson(res, 200, runtime.getSimulationReport(), runtime);
      }

      if (req.method === 'GET' && url.pathname === '/analytics/leaderboard') {
        const board = await runtime.getGlobalLeaderboard();
        return sendJson(res, 200, board, runtime);
      }

      if (req.method === 'GET' && url.pathname === '/analytics/economics') {
        const economics = await runtime.getEconomics();
        return sendJson(res, 200, economics, runtime);
      }

      if (req.method === 'GET' && url.pathname === '/activity') {
        const rawLimit = url.searchParams.get('limit');
        const rawBefore = url.searchParams.get('before');
        const limit = rawLimit === null || rawLimit === '' ? 50 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVITY_MAX_LIMIT) {
          return sendJson(res, 400, { error: 'invalid_limit', message: `limit must be 1..${ACTIVITY_MAX_LIMIT}` }, runtime);
        }
        let before: number | null = null;
        if (rawBefore !== null && rawBefore !== '') {
          if (!/^\d{1,15}$/.test(rawBefore)) {
            return sendJson(res, 400, { error: 'invalid_cursor', message: 'before must be a cursor from next_cursor' }, runtime);
          }
          before = Number(rawBefore);
        }
        return sendJson(res, 200, await runtime.getActivity(before, limit), runtime);
      }

      // ---- Public finalized transaction receipt (read-only, keyless) -------

      if (req.method === 'GET' && parts[0] === 'tx' && parts[1]) {
        const txHash = parts[1];
        const accountId = url.searchParams.get('account_id') ?? '';
        if (!accountId) {
          return sendJson(res, 400, { error: 'missing_account_id' }, runtime);
        }
        const view = await runtime.getTxFinalStatus(txHash, accountId);
        if (!view) return sendJson(res, 404, { error: 'not_found' }, runtime);
        return sendJson(res, 200, view, runtime);
      }

      // ---- Forecast Access authentication ---------------------------------

      if (req.method === 'POST' && url.pathname === '/auth/challenge') {
        if (!originAllowed(req.headers.origin ?? null, access.allowedOrigins)) {
          return sendJson(res, 403, { error: 'origin_not_allowed' }, runtime);
        }
        const body = await readJsonBody(req);
        return sendJson(res, 200, runtime.mintAccessChallenge(asString(body.account_id)), runtime);
      }

      if (req.method === 'POST' && url.pathname === '/auth/verify') {
        if (!originAllowed(req.headers.origin ?? null, access.allowedOrigins)) {
          return sendJson(res, 403, { error: 'origin_not_allowed' }, runtime);
        }
        const body = await readJsonBody(req);
        const { sessionId, dto } = await runtime.verifyAccessChallenge({
          challengeId: asString(body.challenge_id),
          accountId: asString(body.account_id),
          publicKey: asString(body.public_key),
          signature: asString(body.signature),
        });
        return sendJson(res, 200, dto, runtime, {
          'set-cookie': sessionCookieHeader(access, sessionId).header,
        });
      }

      if (req.method === 'POST' && url.pathname === '/auth/logout') {
        return sendJson(res, 204, '', runtime, {
          'set-cookie': sessionCookieHeader(access, null).header,
        });
      }

      if (req.method === 'GET' && parts[0] === 'forecast' && parts[1]) {
        const questionId = parseQuestionId(parts[1]);
        if (questionId === null) {
          return sendJson(res, 400, { error: 'invalid_question_id' }, runtime);
        }
        const sessionId = readCookie(req, access.cookieName);
        if (!sessionId) {
          throw new AccessError('unauthenticated', 401, 'no valid session');
        }
        const delivery = await runtime.deliverForecast(questionId, sessionId);
        return sendJson(res, 200, delivery, runtime);
      }

      // ---- Public finalized wallet views (claim/withdraw stay wallet-signed)

      if (req.method === 'GET' && parts[0] === 'account' && parts[1] && parts[2] === 'balance') {
        const balance = await runtime.getAccountBalance(parts[1]);
        if (!balance) return sendJson(res, 404, { error: 'not_found' }, runtime);
        return sendJson(res, 200, balance, runtime);
      }

      if (req.method === 'GET' && parts[0] === 'account' && parts[1] && parts[2] === 'pending-withdrawals') {
        const { fromIndex, limit } = pagination(url);
        const pending = await runtime.listPendingWithdrawals(parts[1], fromIndex, limit);
        return sendJson(res, 200, { account_id: parts[1], pending_withdrawals: pending }, runtime);
      }

      if (req.method === 'GET' && parts[0] === 'questions' && parts[1] && parts[2] === 'buyers') {
        const questionId = parseQuestionId(parts[1]);
        if (questionId === null) {
          return sendJson(res, 400, { error: 'invalid_question_id' }, runtime);
        }
        const { fromIndex, limit } = pagination(url);
        const buyers = await runtime.listBuyers(questionId, fromIndex, limit);
        return sendJson(res, 200, { question_id: questionId, buyers }, runtime);
      }

      if (req.method === 'GET' && parts[0] === 'questions' && parts[1] && parts[2] === 'receipt' && parts[3]) {
        const questionId = parseQuestionId(parts[1]);
        if (questionId === null) {
          return sendJson(res, 400, { error: 'invalid_question_id' }, runtime);
        }
        const receipt = await runtime.getBuyerReceipt(questionId, parts[3]);
        if (!receipt) return sendJson(res, 404, { error: 'not_found' }, runtime);
        return sendJson(res, 200, receipt, runtime);
      }

      if (req.method === 'GET' && url.pathname === '/questions') {
        const { fromIndex, limit } = pagination(url);
        const questions = await runtime.listPublicQuestions(fromIndex, limit);
        return sendJson(res, 200, { questions }, runtime);
      }

      if (req.method === 'GET' && parts[0] === 'questions' && parts[1] && parts[2] === 'leaderboard') {
        const questionId = parseQuestionId(parts[1]);
        if (questionId === null) {
          return sendJson(res, 400, { error: 'invalid_question_id' }, runtime);
        }
        const board = await runtime.listLeaderboard(questionId);
        return sendJson(res, 200, { question_id: questionId, entries: board }, runtime);
      }

      if (req.method === 'GET' && parts[0] === 'questions' && parts[1] && parts[2] === 'rationale') {
        const questionId = parseQuestionId(parts[1]);
        if (questionId === null) {
          return sendJson(res, 400, { error: 'invalid_question_id' }, runtime);
        }
        const r = await runtime.getLlmRationale(questionId);
        if (r.status === 'ok') return sendJson(res, 200, r.rationale, runtime);
        const code = r.status === 'not_revealed' ? 403 : r.status === 'unavailable' ? 503 : 404;
        return sendJson(res, code, { error: r.status }, runtime);
      }

      if (req.method === 'GET' && parts[0] === 'questions' && parts[1] && parts[2] === 'comparison') {
        const questionId = parseQuestionId(parts[1]);
        if (questionId === null) {
          return sendJson(res, 400, { error: 'invalid_question_id' }, runtime);
        }
        const comparison = await runtime.getQuestionComparison(questionId);
        if (!comparison) return sendJson(res, 404, { error: 'not_found' }, runtime);
        return sendJson(res, 200, comparison, runtime);
      }

      if (req.method === 'GET' && parts[0] === 'questions' && parts[1]) {
        const questionId = parseQuestionId(parts[1]);
        if (questionId === null) {
          return sendJson(res, 400, { error: 'invalid_question_id' }, runtime);
        }
        const q = await runtime.getPublicQuestion(questionId);
        if (!q) return sendJson(res, 404, { error: 'not_found' }, runtime);
        return sendJson(res, 200, q, runtime);
      }

      return sendJson(res, 404, { error: 'not_found' }, runtime);
    } catch (err) {
      if (err instanceof AccessError) {
        return sendJson(res, ACCESS_HTTP_STATUS[err.code], { error: err.code, message: err.message }, runtime);
      }
      // Transient chain/RPC availability (e.g. the public RPC endpoint is down
      // or rate-limited) must surface as 503, not a 500 "internal error", and
      // never be conflated with a definitive "not found".
      if (err instanceof ChainUnavailableError) {
        return sendJson(res, 503, { error: 'chain_unavailable', message: (err as Error).message }, runtime);
      }
      return sendJson(res, 500, { error: 'internal_error', message: (err as Error).message }, runtime);
    }
  });
}
