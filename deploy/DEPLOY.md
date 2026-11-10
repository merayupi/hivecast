# Deploying HiveCast on a public domain (testnet)

The public site is two pieces on one origin:

- the **dashboard**: static files from `packages/dashboard/dist`;
- the **runner**: two Node processes, the public HTTP service (`npm run service`)
  and the agent scheduler (`npm run cli -- run`). Both read the same private
  SQLite file.

A reverse proxy serves the dashboard and forwards `/api/*` to the service on
`127.0.0.1:8787`. Same origin means the HttpOnly session cookie works without
CORS.

Everything stays on NEAR **testnet**. Visitors use testnet wallets and free
testnet NEAR.

## What you need

- A small Linux VPS (1 vCPU / 1 GB is enough) with a domain pointed at it.
- Node.js **22.5+** (the runner uses `node:sqlite`).
- [Caddy](https://caddyserver.com/) for HTTPS and the reverse proxy.
- The operator and agent **testnet** keys (`<account>.json` files, near CLI
  layout). These never go in the repository.

## Steps

```bash
# 1. Code and dependencies
sudo useradd --system --home /opt/hivecast hivecast
sudo git clone https://github.com/merayupi/hivecast.git /opt/hivecast
cd /opt/hivecast && sudo -u hivecast npm ci

# 2. Build the dashboard (calls /api on the same origin by default)
sudo -u hivecast npm run build --workspace @hivecast/dashboard

# 3. Private config, keys, and state
sudo mkdir -p /etc/hivecast/near-credentials/testnet /var/lib/hivecast
sudo cp deploy/hivecast.config.production.example.json /etc/hivecast/hivecast.config.json
#    edit: allowedOrigins -> ["https://<your-domain>"], keep cookieSecure: true
#    copy your testnet key files into /etc/hivecast/near-credentials/testnet/
#    LLM agent key (NEAR AI Cloud), kept out of the config file:
echo 'NEARAI_API_KEY=<your key>' | sudo tee /etc/hivecast/hivecast.env >/dev/null
sudo chown -R hivecast /etc/hivecast /var/lib/hivecast
sudo chmod 700 /etc/hivecast/near-credentials
sudo chmod 600 /etc/hivecast/hivecast.env

# 4. Runner processes
sudo cp deploy/hivecast-service.service deploy/hivecast-runner.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hivecast-service hivecast-runner

# 5. HTTPS + reverse proxy
#    edit deploy/Caddyfile: replace hivecast.example.com with your domain
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

## Updating a running deployment

```bash
cd /opt/hivecast && sudo -u hivecast git pull origin main
sudo -u hivecast npm ci                                         # only when package-lock.json changed
sudo -u hivecast npm run build --workspace @hivecast/dashboard  # dashboard changes
sudo systemctl restart hivecast-service hivecast-runner         # runner or config changes
```

Caddy serves the new `dist` at once; no reload is needed.

## Check it

- `https://<your-domain>/api/health` returns JSON.
- `https://<your-domain>/` shows Rounds; the **REPLAY** tab draws the
  bankroll race.
- `https://<your-domain>/api/agents` lists nine agents, the last one
  `llm-news`. Eight means the LLM agent is not configured: the config needs
  both `agentAccounts["llm-news"]` and the `llm` block, plus `NEARAI_API_KEY`
  in `/etc/hivecast/hivecast.env`.
- Connect a Meteor testnet wallet, buy access to a Round marked **on sale**
  (price Rounds: the 30 minutes before every UTC hour), sign the login message, and
  read the forecast.
- `journalctl -u hivecast-runner -f` shows the scheduler committing,
  resolving, and settling.

## Things to keep an eye on

- **RPC rate limits.** Public RPC endpoints limit requests per IP. When the
  primary `rpcUrl` answers 429 or 5xx, or is unreachable, the runner and the
  service move to the next entry of `rpcFallbackUrls` and stay there for five
  minutes before trying the primary again. `journalctl -u hivecast-service -u
  hivecast-runner | grep '\[rpc\]'` shows every switch (hosts only, never a
  key). Without fallbacks a rate-limited primary means 503s on the site and
  missed commits. An RPC provider API key in the URL is safe to use: logs and
  public error bodies carry the host only.
- **LLM credits.** The `llm-news` agent makes at most 3 NEAR AI Cloud calls per
  hourly price Round (usually 1). `journalctl -u hivecast-runner | grep llm-news`
  shows each forecast with its token count. Remove the `llm` block to switch it off.
- **Operator gas.** The operator and agent accounts pay testnet gas for every
  Round. Top them up from the faucet before a demo.
- **Hourly price Rounds** keep the live page busy. Weather Rounds run once a day.
- **The dashboard alone is not enough.** Without the runner, the page shows
  honest "unavailable" states instead of Rounds.
- **Trust boundary.** The operator knows private forecasts, records the Outcome,
  and holds the deploy key. The **GUIDE** tab says so to every visitor.
