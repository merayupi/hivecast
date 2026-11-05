import { usePolling } from '../lib/hooks';
import { api } from '../lib/api';
import type { AgentRosterEntry, TrustDisclosure } from '../lib/types';
import { Panel, Chip, EmptyState, ErrorNote } from './ui';

/** The eight algorithmic identities + supported roles (never fake participants). */
export function AgentsPanel() {
  const { data, error, loading } = usePolling(() => api.agents(), 60_000, []);

  if (loading) return <p className="muted-line">Loading agents…</p>;
  if (error) return <ErrorNote message={error} />;
  if (!data || data.length === 0) return <EmptyState title="No agents" detail="The operator roster is unavailable." />;

  return (
    <table className="ledger-table">
      <thead>
        <tr>
          <th>Identity</th>
          <th>Account</th>
          <th>Supported domains</th>
          <th>Role</th>
        </tr>
      </thead>
      <tbody>
        {data.map((a) => (
          <tr key={a.agentId}>
            <td className="num">{a.agentId}</td>
            <td className="num">{a.accountId || '—'}</td>
            <td>{a.domains.map((d) => <Chip key={d} tone={d === 'price' ? 'vermilion' : 'ink'}>{d}</Chip>)}</td>
            <td className="num">{a.role}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Visible trust boundary: Operator powers, delivery limits, claim/withdraw. */
export function DisclosurePanel() {
  const { data, error, loading } = usePolling(() => api.disclosure(), 60_000, []);

  if (loading) return <p className="muted-line">Loading disclosure…</p>;
  if (error) return <ErrorNote message={error} />;
  if (!data) return <EmptyState title="No disclosure" detail="Trust disclosure is unavailable." />;

  return (
    <div className="disclosure">
      <DisclosureBlock title="Operator powers" items={data.operator_powers} tone="bad" />
      <DisclosureBlock title="Delivery limits" items={data.delivery_limits} tone="warn" />
      <DisclosureBlock title="Claim / withdraw" items={data.claim_withdrawal} tone="ok" />
      <p className="muted-line small-caps">
        This is a non-commercial educational testnet demo. Binance NEAR/USDT is not fiat USD; the Kudus IFS 9 km
        grid is a model output, not a weather-station reading.
      </p>
    </div>
  );
}

function DisclosureBlock({ title, items, tone }: { title: string; items: string[]; tone: 'ok' | 'warn' | 'bad' }) {
  return (
    <Panel title={title}>
      <ul className="disclosure-list">
        {items.map((item) => (
          <li key={item} className="disclosure-row rule-b">
            <Chip tone={tone}>·</Chip>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function AgentRoleNote() {
  return (
    <p className="muted-line small-caps">
      All eight accounts are controlled by one Operator. Six relevant strategies per domain; unsupported
      specialists abstain and are never presented as participants in the wrong domain.
    </p>
  );
}

export type { AgentRosterEntry };
