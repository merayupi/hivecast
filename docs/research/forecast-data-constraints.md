# Forecast Data Constraints — NEAR/USD & Kudus Precipitation

Scope: verify public, unauthenticated sources for (a) 60 days of hourly NEAR/USD and
(b) 60 days of daily precipitation in Kudus plus weather forecasts, record licensing /
redistribution caveats, and evaluate a no-lookahead replay. No data is bundled in the repo
yet; this note records what each source actually provides and the decisions the user must make.

Probe date: 2026-11-05. All endpoints hit read-only with no keys.

---

## 1. NEAR price (hourly, 60 days)

### 1.1 USD vs USDT is a real fork, not a cosmetic one

The plan says "NEAR/USD", but the three candidate vendors denominate differently:

| Source | Instrument | What it is | Observed (2026-11-05) |
| --- | --- | --- | --- |
| Binance | `NEARUSDT` | Tether stablecoin pair | 4.048 |
| Binance | `NEARUSDC` | USD Coin pair (exists) | 4.045 |
| Binance | `NEARFDUSD` | First Digital USD pair (exists, thin) | 0.977 |
| CoinGecko | `vs_currency=usd` | Aggregated USD index (many pairs, incl. stablecoin-quoted) | 4.0455 (hourly close, partial) |

Facts and implications:

- Binance spot has **no fiat USD pair for NEAR** — only stablecoin pairs (`NEARUSDT`,
  `NEARUSDC`, `NEARFDUSD`). `NEARUSDP` (Paxos USD) returns HTTP 400 (pair absent).
- The stablecoin pairs themselves disagree (4.048 vs 4.045), and `NEARFDUSD` trades far
  off par (0.977), i.e. stablecoin quote ≠ USD and low-liquidity quotes can be misleading.
  Use `NEARUSDT` (deepest) or `NEARUSDC`, not `NEARFDUSD`.
- CoinGecko `usd` is **not** a single fiat market. Its published price is a volume-weighted
  average over up to 600 pairs (fiat *and* stablecoin), outlier-filtered (MAD) and normalized
  via a Bitcoin Price Index. Source:
  [CoinGecko Price Aggregation Methodology](https://www.coingecko.com/en/api/price-aggregation-methodology).

**Decision (user):** pick one exact instrument + timestamp + source to put in the contract.
If "USD" means "fiat USD", CoinGecko `usd` is the only direct option (aggregated). If
reproducibility matters more, Binance `NEARUSDT` klines are per-exchange, exact, and
deterministic. The two differ by ~0.1–0.3%; a binary "price up/down" outcome will occasionally
flip on that choice, so it must be pinned before any round.

### 1.2 Endpoints, schema, timestamps

**Binance `/api/v3/klines`** — spot klines.

- Params: `symbol`, `interval` (`1h`), `startTime`/`endTime` (ms, UTC), `limit` (default 500,
  **max 1000**). Source:
  [Market data endpoints — Kline/Candlestick data](https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market#klines).
- Response: array of 12-element tuples
  `[openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBase, takerQuote, ignore]`.
  `openTime`/`closeTime` in **ms, UTC**, hour-aligned. `openTime` uniquely identifies the kline.
- 60 days = 1440 hourly candles ⇒ **2 requests** (`limit=1000` + `limit=440`); each request
  costs weight 2 (trivial vs. rate limits). No key needed; `data.binance.vision` also serves
  bulk monthly CSV/parquet archives if offline bundle is preferred.
- Probe: `GET /api/v3/klines?symbol=NEARUSDT&interval=1h&limit=3` → **200**, 3 tuples, e.g.
  `openTime=1793840400000`, `close=4.038`.

**CoinGecko `/api/v3/coins/{id}/market_chart`** — `id=near`, `vs_currency=usd`.

- Auto-granularity: 2–90 days ⇒ **hourly**; `interval=hourly` covers past 100 days; hourly
  history available from 30 Jan 2018. Source:
  [Coin Historical Chart Data by ID](https://docs.coingecko.com/reference/coins-id-market-chart).
- Response: `{prices, market_caps, total_volumes}` each as `[ms_timestamp, value]` pairs, **ms UTC**.
- Probe: `days=60&interval=hourly` → **200**, 1441 points. First point at 04:00 UTC on day -60;
  **last point is the current live price (not hour-aligned)** — drop the trailing partial point
  before replay.

### 1.3 Licensing / redistribution caveats (price data)

**Binance.**

- The downloadable historical datasets (`data.binance.vision`) are **CC BY-NC-SA 4.0**,
  **non-commercial only**; "commercial utilization requires a separate, written enterprise
  data license." Prohibited: licensing/selling/renting/commercially exploiting the data,
  integrating it into commercial financial products, paid newsletters, or trading bots.
  Attribution required on derivative works. Source:
  [Binance Vision Dataset Terms v1.0 (2026-08-26)](https://data.binance.vision/Binance_Vision-Terms_of_Use.pdf)
  and [binance/binance-public-data TERMS_AND_CONDITIONS.md](https://github.com/binance/binance-public-data/blob/master/TERMS_AND_CONDITIONS.md).
- The live REST API is governed by the
  [Binance Terms of Use](https://www.binance.com/en/terms) (proprietary; no redistribution
  license in the free tier). Both are "as is", no accuracy warranty.

**CoinGecko.**

- Free **Demo** plan: 10k call credits/month, 100 req/min, **1 year** hourly history,
  **attribution required**, **no commercial license**. Paid **Basic** ($35/mo) = 2 years +
  commercial license; Analyst+ = from 2018. Source:
  [CoinGecko API pricing](https://www.coingecko.com/en/api/pricing).
- API Terms (v5 Sep 2025): must display "Powered by CoinGecko" (≥ font 10); may charge for
  your own product but **may not sell/rent/sub-license/redistribute/syndicate the API access**;
  caching discouraged, refresh ≤ 24h, delete on termination; **may not use the API to promote
  gambling**. Source: [CoinGecko API Terms of Service](https://www.coingecko.com/en/api_terms)
  (clauses 4.1.6, 4.1.7.2, 4.4, 6.1).

**Flag:** HiveCast is forecast *wagering*. CoinGecko clause 4.1.7.2 (no use to "promote
gambling") and Binance's non-commercial CC BY-NC-SA are the two licensing risks that most
directly constrain which vendor may back a monetized (`buy_forecast`) product vs a purely
internal hackathon sim.

---

## 2. Kudus precipitation (daily) + weather forecasts

Kudus, Central Java: `lat=-6.8049, lon=110.8397`. Timezone `Asia/Jakarta` (WIB, UTC+7, **no
DST**); Open-Meteo returns `utc_offset_seconds=25200` and applies **daily boundaries in the
requested timezone**. `precipitation` is the **preceding-hour sum** (mm, 0.1 mm precision);
daily `precipitation_sum` is the 24-h sum over the local day. Source:
[Historical Weather API docs](https://open-meteo.com/en/docs/historical-weather-api).

### 2.1 The critical distinction: observed vs forecast-as-it-was

Open-Meteo exposes four historical products that are easy to confuse:

| API | Host / path | Content | As-of availability (not "is it a forecast?") |
| --- | --- | --- | --- |
| Historical Weather (Archive) | `archive-api.open-meteo.com/v1/archive` | Reanalysis / model **analysis** (ERA5/ERA5-Land/IFS 9 km) — gridded model output, **not** station observations | `valid_time` in the past ≠ available at cutoff; reanalysis is published with delay and **revised** — needs `available_at` provenance or it is a retrospective benchmark |
| Historical Forecast | `historical-forecast-api.open-meteo.com/v1/forecast` | Stitched **first hours of each model run** ≈ analysis (tracks reality) | Can contain genuine forecast segments but does **not** prove as-of availability — unproven ⇒ exclude or label retrospective |
| Previous Runs | `previous-runs-api.open-meteo.com/v1/forecast` | Forecasts at **fixed lead times** `_previous_day1..7` | `_day1` is a **rolling lead per valid hour** (each hour's value ≈ 24 h before *that hour*) — summing a whole target day does **not** establish the vector existed at one earlier cutoff |
| Single Runs | (single-runs API) | Full horizon of one model run, by **init time** | **Recommendation**: pick one specific `run` whose init time AND documented publication/availability precede cutoff; if publication is unprovable, mark `[INFERENCE]` and exclude |

Sources: [Historical Forecast API docs](https://open-meteo.com/en/docs/historical-forecast-api),
[Previous Runs API docs](https://open-meteo.com/en/docs/previous-runs-api).

Implication for the plan's `meteo` persona: nothing here is "a forecast that was provably
available at one past cutoff" unless you pin a concrete run + publication time. Reanalysis and
stitched Historical Forecast both fail the as-of test by default (reanalysis because it is
revised after the fact, Historical Forecast because it does not record per-value availability).
A strict no-lookahead pipeline must carry an `available_at` field on every input or be
explicitly labeled a retrospective benchmark.

### 2.2 Endpoints, schema, timestamps

- **Archive (source truth — pinned model/grid, not physical truth):**
  `archive-api.open-meteo.com/v1/archive?...&daily=precipitation_sum,rain_sum&timezone=Asia/Jakarta`.
  Probe (2026-10-01..05) → **200**, `precipitation_sum=[0.0, 0.4, 0.0, 4.9, 2.9]` mm,
  `timezone=Asia/Jakarta`. ERA5 updates with a **5-day delay**; **IFS 9 km has no delay** and is
  the model Open-Meteo uses for the most recent days. Values are gridded model analysis, not
  station gauge readings; and the API may re-serve a revised value for a past date (reanalysis
  updates). "Truth" is therefore the *pinned model + captured response at resolution time*, not
  an immutable physical observation.
- **Forecast (live, for forward-looking use):**
  `api.open-meteo.com/v1/forecast?...&daily=precipitation_sum&timezone=Asia/Jakarta`.
  Probe → **200**, 7 days (today + 6), `timezone=Asia/Jakarta`, `utc_offset_seconds=25200`.
- **Previous Runs (no-lookahead forecast):**
  lead-time variables are **hourly only**. Probe:
  `hourly=precipitation,precipitation_previous_day1,precipitation_previous_day2` → **200**
  (48 hourly values each). **Daily** `precipitation_sum_previous_day1` → **HTTP 400**
  ("Cannot initialize ForecastVariableDaily"). So the daily no-lookahead forecast must be
  **computed** by summing hourly `precipitation_previous_day1` over the Jakarta day.
  Most models archived from **Jan 2024** (GFS 2 m temp Mar 2021, JMA 2018).

### 2.3 Licensing / redistribution (weather)

- API data is **CC BY 4.0** with attribution (a "Weather data by Open-Meteo.com" link next to
  any display). Source: [Open-Meteo Licence](https://open-meteo.com/en/licence).
- **Free tier is non-commercial only** (≤ 10k calls/day, 5k/hr, 600/min). Commercial use
  requires a paid API subscription. Source: [Open-Meteo Terms](https://open-meteo.com/en/terms).

---

## 3. Probe observations (recorded, 2026-11-05)

| Endpoint | Status | Key observation |
| --- | --- | --- |
| Binance `NEARUSDT` 1h klines | 200 | 12-field tuples, `openTime` ms UTC hour-aligned |
| Binance `NEARUSDT` / `NEARUSDC` / `NEARFDUSD` ticker | 200 / 200 / 200 | 4.048 / 4.045 / 0.977; `NEARUSDP` → 400 |
| CoinGecko `near` `market_chart` 60d hourly | 200 (no key) | 1441 pts, ms UTC; last pt is live/partial |
| Open-Meteo forecast daily `precipitation_sum` | 200 | 7 days, `Asia/Jakarta`, `utc_offset_seconds=25200` |
| Open-Meteo archive daily `precipitation_sum` | 200 | 5 days reanalysis, Jakarta boundaries |
| Open-Meteo previous-runs hourly `precipitation_previous_day1` | 200 | lead-time forecast present |
| Open-Meteo previous-runs daily `precipitation_sum_previous_day1` | 400 | daily lead-time var unsupported |

Environment caveat: the `archive-api` / `historical-forecast-api` / `previous-runs-api` hosts
failed TLS verification under this machine's Python CA bundle ("certificate has expired"), but
succeeded with `curl` (system CA store, `ssl_verify_result=0`). This is a local CA-bundle
artifact, **not** a provider defect; a production fetcher should use a current CA bundle.

---

## 4. No-lookahead replay evaluation

Strict rule for *every* input: a value is usable for a decision taken at time `T` only if we can
prove it was **published/available before `T`** — `valid_time < T` is not enough. Where that
proof is missing, mark the input `[INFERENCE]` and either exclude it or label the whole run a
**retrospective benchmark** (not a strict point-in-time replay).

**NEAR candles — period end is not publication time.**

- Binance returns both `openTime` and `closeTime` per candle. An hourly candle whose `openTime`
  precedes cutoff can finish after it (`closeTime = openTime + 3,599,999 ms` in millisecond mode).
  Require `closeTime < cutoff`, not merely `openTime < cutoff`. This is necessary but does not
  prove publication before cutoff: strict point-in-time replay also needs availability evidence.
- CoinGecko hourly points are `[timestamp, price]` pairs with no explicit close-time; the trailing
  point is the live/partial value and must be dropped. Because CoinGecko does not expose a
  finalized-at timestamp, treat each hourly point as available only at/after its `timestamp` and
  exclude the in-flight tail. `[INFERENCE]` if the exact publication lag matters.
- For `persistence` / `momentum` / `meanrev`, use only completed candles preceding the round
  cutoff. Distinguish the observed period end from a documented or inferred publication time.

**Weather — "past date" ≠ "available at cutoff".**

- **Reanalysis (Archive) for a *past* date is still not automatically safe**: ERA5/ERA5-Land are
  published with delay and **revised** after the fact; a past `valid_time` does not prove the value
  observed today was the value available at the replay cutoff. Using it for a target day is
  hindsight; using it for a *past* day in a strategy is fine only if the strategy's information
  cutoff is set after that revision, or the run is labeled retrospective.
- **Historical Forecast is not blanket "hindsight" either**: it is stitched from genuine model-run
  first-hours, but the API does not record when each segment became available, so it cannot prove
  as-of availability. Treat any Historical Forecast value as `[INFERENCE]` and exclude it from a
  strict no-lookahead benchmark.
- **Previous Runs `_previous_day1` is a rolling lead, not a single snapshot.** Values for 00:00
  and 23:00 target times have nominal production times about 23 hours apart. A sum of all 24
  hourly values does not by itself prove that the vector was available at one commit cutoff.
  Whether it was available depends on that cutoff and publication latency; it is not inherently
  impossible. Check every input's availability, or label the result retrospective.
- **Recommended no-lookahead construction:** pick a **specific Single Run** (one `run` =
  initialization datetime) and require BOTH (a) `run` init time `< cutoff` AND (b) documented
  publication/availability `< cutoff` (model archive latency is not documented by Open-Meteo as a
  per-run field). If (b) cannot be proven, mark the run `[INFERENCE]` and either exclude it or
  relabel the benchmark. No bundled "meteo forecast vector" exists in the repo; do not fabricate
  one that assumes a whole target-day vector was available at one earlier cutoff.

**Resolution truth caveat:** the source truth is a **pinned model/grid** (e.g. Archive IFS 9 km,
Kudus cell) **plus the captured API response at resolution time**, not an immutable physical
truth. Open-Meteo's recent-day values are gridded model analysis, not a Kudus weather-station
gauge; there is no free, unauthenticated, guaranteed official station feed via Open-Meteo, and
reanalysis may revise a past date after resolution. Pin the exact source + variable + day
boundary (`Asia/Jakarta`) + resolution capture time in the contract, and record the response so
revisions after resolution cannot silently change the outcome.

---

## 5. Source choices (open decisions for the user)

1. **NEAR instrument.** USD (CoinGecko aggregated) vs USDT/USDC (Binance). Recommend:
   CoinGecko `usd` if "USD" semantics matter; Binance `NEARUSDT` for deterministic, per-exchange
   reproducibility. Must be fixed before rounds because up/down outcomes can flip on this ~0.1%.
2. **Vendor licensing.** Binance historical data is CC BY-NC-SA (non-commercial); CoinGecko
   free Demo has no commercial license + a gambling clause; Open-Meteo free is non-commercial
   CC BY 4.0. A monetized `buy_forecast` product likely needs a paid/enterprise tier (or an
   internal-only hackathon scope with attribution).
3. **Weather resolution source + threshold.** Define "rainy day" (e.g. `precipitation_sum > 0`
   vs `>= 1 mm`) and the exact day boundary (`Asia/Jakarta`, UTC+7). Archive API is the free
   source-truth source (pinned IFS 9 km grid cell; ERA5 has 5-day delay). "Truth" = pinned
   model/grid + captured response at resolution time, not physical station truth.
4. **`meteo` input for replay.** A strictly point-in-time forecast requires a **specific Single
   Run** whose init AND documented publication precede cutoff (mark `[INFERENCE]` + exclude if
   publication is unprovable). `previous_day1` hourly sums are a **rolling lead** → only
   retrospective; Archive/Historical-Forecast for the target day are not as-of inputs.
5. **Bundling.** No historical data bundle exists yet; decide fetch-on-demand vs build a bundle
   (Binance klines 1440 candles = 2 requests; CoinGecko 60d hourly = 1 call; Open-Meteo archive
   60d daily = 1 call, hourly no-lookahead = ~60–120 calls).

---

## Citations (primary)

- Binance klines: https://developers.binance.com/en/docs/catalog/core-trading-spot-trading/api/rest-api/market#klines
- Binance Vision Dataset Terms: https://data.binance.vision/Binance_Vision-Terms_of_Use.pdf ; https://github.com/binance/binance-public-data/blob/master/TERMS_AND_CONDITIONS.md
- Binance Terms of Use: https://www.binance.com/en/terms
- CoinGecko market_chart: https://docs.coingecko.com/reference/coins-id-market-chart
- CoinGecko API Terms: https://www.coingecko.com/en/api_terms
- CoinGecko pricing: https://www.coingecko.com/en/api/pricing
- CoinGecko price aggregation: https://www.coingecko.com/en/api/price-aggregation-methodology
- Open-Meteo Historical Weather API: https://open-meteo.com/en/docs/historical-weather-api
- Open-Meteo Historical Forecast API: https://open-meteo.com/en/docs/historical-forecast-api
- Open-Meteo Previous Runs API: https://open-meteo.com/en/docs/previous-runs-api
- Open-Meteo Terms: https://open-meteo.com/en/terms
- Open-Meteo Licence: https://open-meteo.com/en/licence
