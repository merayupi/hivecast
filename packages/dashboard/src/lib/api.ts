/**
 * Typed client for the runner public HTTP service. Browser requests go through
 * the Vite `/api` proxy (see vite.config.ts); cookies (the HttpOnly session)
 * travel with `credentials: 'include'`.
 */

import type {
  ActivityPage,
  AgentRosterEntry,
  ApiError,
  BalanceView,
  ChallengeDto,
  EconomicsReport,
  ForecastDeliveryDto,
  GlobalLeaderboard,
  LlmRationale,
  PendingWithdrawalView,
  PublicConfig,
  QuestionComparison,
  QuestionView,
  ReplayReport,
  SessionDto,
  TrustDisclosure,
} from './types';

const BASE = import.meta.env?.VITE_API_BASE ?? '/api'; // env is undefined under node:test

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  } catch (err) {
    throw new ApiClientError(0, 'network', `API unreachable: ${(err as Error).message}`);
  }
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as ApiError & Record<string, unknown>;
  if (!res.ok) {
    throw new ApiClientError(res.status, String(body.error ?? 'error'), body.message ?? String(body.error ?? res.status));
  }
  return body as unknown as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  config: () => get<PublicConfig>('/config'),
  disclosure: () => get<TrustDisclosure>('/disclosure'),
  agents: async () => (await get<{ agents: AgentRosterEntry[] }>('/agents')).agents,
  questions: (fromIndex = 0, limit = 50) => get<{ questions: QuestionView[] }>(`/questions?from_index=${fromIndex}&limit=${limit}`),
  /** Every Question on chain, paged (100 per request, at most 2,000). */
  allQuestions: async (): Promise<QuestionView[]> => {
    const out: QuestionView[] = [];
    for (let page = 0; page < 20; page += 1) {
      const { questions } = await get<{ questions: QuestionView[] }>(`/questions?from_index=${page * 100}&limit=100`);
      out.push(...questions);
      if (questions.length < 100) break;
    }
    return out;
  },
  question: (id: number) => get<QuestionView>(`/questions/${id}`),
  comparison: (id: number) => get<QuestionComparison>(`/questions/${id}/comparison`),
  leaderboard: () => get<GlobalLeaderboard>('/analytics/leaderboard'),
  economics: () => get<EconomicsReport>('/analytics/economics'),
  simulation: () => get<ReplayReport>('/simulation/report'),
  activity: (limit = 50, before?: string) =>
    get<ActivityPage>(`/activity?limit=${limit}${before ? `&before=${encodeURIComponent(before)}` : ''}`),
  balance: (accountId: string) => get<BalanceView>(`/account/${accountId}/balance`),
  pendingWithdrawals: async (accountId: string) =>
    (await get<{ pending_withdrawals: PendingWithdrawalView[] }>(`/account/${accountId}/pending-withdrawals`)).pending_withdrawals,
  receipt: async (questionId: number, accountId: string) => {
    try {
      return await get<{ question_id: number; account_id: string; price: string; refunded: boolean }>(
        `/questions/${questionId}/receipt/${accountId}`,
      );
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) return null;
      throw err;
    }
  },
  challenge: (accountId: string) => post<ChallengeDto>('/auth/challenge', { account_id: accountId }),
  verify: (input: { challenge_id: string; account_id: string; public_key: string; signature: string }) =>
    post<SessionDto>('/auth/verify', input),
  logout: () => post<void>('/auth/logout', {}),
  forecast: (id: number) => get<ForecastDeliveryDto>(`/forecast/${id}`),
  /** llm-news rationale: `hidden` before its Reveal, `absent` when it did not take part. */
  rationale: async (
    id: number,
  ): Promise<{ state: 'ok'; data: LlmRationale } | { state: 'hidden' } | { state: 'absent' }> => {
    try {
      return { state: 'ok', data: await get<LlmRationale>(`/questions/${id}/rationale`) };
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 403) return { state: 'hidden' };
      if (err instanceof ApiClientError && err.status === 404) return { state: 'absent' };
      throw err;
    }
  },
};
