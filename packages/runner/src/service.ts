/**
 * Public HTTP service — health, config, public questions, and leaderboard.
 *
 * Deliberately narrow: it never exposes administrative signing, private
 * forecasts, salts, or frozen snapshot aggregates. Private snapshot delivery
 * is ticket #5 (authenticated access), which will consume `Runtime` directly.
 */

import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import type { Runtime } from './runtime.js';

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

export function createPublicService(runtime: Runtime): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const parts = url.pathname.split('/').filter(Boolean);

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { status: 'ok', domain: 'hivecast-runner' });
      }

      if (req.method === 'GET' && url.pathname === '/config') {
        return send(res, 200, runtime.getPublicConfig());
      }

      if (req.method === 'GET' && url.pathname === '/questions') {
        const fromIndex = Number(url.searchParams.get('from_index') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? '20');
        const questions = await runtime.listPublicQuestions(fromIndex, limit);
        return send(res, 200, { questions });
      }

      if (req.method === 'GET' && parts[0] === 'questions' && parts[1] && parts[2] === 'leaderboard') {
        const questionId = Number(parts[1]);
        if (!Number.isInteger(questionId)) return send(res, 400, { error: 'invalid question_id' });
        const board = await runtime.listLeaderboard(questionId);
        return send(res, 200, { question_id: questionId, entries: board });
      }

      if (req.method === 'GET' && parts[0] === 'questions' && parts[1]) {
        const questionId = Number(parts[1]);
        if (!Number.isInteger(questionId)) return send(res, 400, { error: 'invalid question_id' });
        const q = await runtime.getPublicQuestion(questionId);
        if (!q) return send(res, 404, { error: 'not found' });
        return send(res, 200, q);
      }

      return send(res, 404, { error: 'not found' });
    } catch (err) {
      return send(res, 500, { error: (err as Error).message });
    }
  });
}
