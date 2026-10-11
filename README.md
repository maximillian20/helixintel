# Global Security Intelligence

This repository contains a demo-ready web application for political-risk, security, and human-rights monitoring.

## Quick start

1. Install Node.js LTS.
2. Install dependencies:
   npm install
3. Start the development stack:
   npm run dev
4. Open the frontend at http://localhost:5173
5. API health check: http://localhost:3001/api/health

## Demo mode

The platform is configured to run without external API keys. All operational data is seeded from the demo dataset and clearly labelled as DEMO DATA � NOT REAL-TIME.

## Deploy

The production build is a single Node service: Express serves `/api/*` and the built `dist/` folder.

```bash
npm ci
npm run build
NODE_ENV=production npm start
```

Environment variables: see `.env.example`. Set `SOURCE_DB_PATH` to a persistent disk path to keep the SQLite store across deploys. A `Dockerfile` and `render.yaml` are included.

## Public data sources and credentials

| Source | Access | Server setting |
| --- | --- | --- |
| BBC News World, UN News | Free RSS | none |
| GDACS (disasters, with alert levels and coordinates) | Free RSS, CC BY 4.0 | none |
| GDELT DOC 2.0 (news headlines) | Free API | optional `GDELT_QUERY` |
| CISA Known Exploited Vulnerabilities | Free JSON | none |
| ReliefWeb | Free, needs a pre-approved app name (https://apidoc.reliefweb.int/) | `RELIEFWEB_APPNAME` |
| US EIA oil spot prices | Free key (https://www.eia.gov/opendata/register.php) | `EIA_API_KEY` |
| ENTSO-E Transparency Platform | Free token by email request to transparency@entsoe.eu | `ENTSOE_API_TOKEN` (parser not yet implemented) |

Credentials are read only on the server. A source without its credential is shown as "Setup required" on the Sources page and is never called.
Fast sources are checked every 15 minutes (`SOURCE_POLL_INTERVAL_MS`), CISA every 6 hours, ReliefWeb and ENTSO-E hourly, EIA every 12 hours.

## Incidents, country assessments and threat indicators

These three screens use only stored public-source records and what you enter yourself. Nothing is pre-filled with sample content.

- **Incidents**: create from any feed item ("Create incident", "Add to existing incident"), link several reports, edit, assign owners, track actions, print or download a brief. Every change is recorded with the actor name (set it from the round button in the header) and a timestamp.
- **Country assessments**: analyst-assigned ratings for six categories, each requiring a written rationale and linked evidence. Every save is a new version. There is no automated country score: no defensible method is configured, so automated scores are shown as Unassessed.
- **Threat indicators**: four indicators calculated from GDACS, CISA KEV and the news sources, compared with the previous eight complete weeks. History starts when the app first reads a source, so most indicators show "Insufficient history" for the first weeks (CISA KEV and GDACS backfill sooner).
- **Privacy**: there are no user accounts. Incidents, assessments, watchlists and alerts are private to the browser that created them, and the server enforces this on every request.
- **Persistence**: data is stored in the SQLite file (`SOURCE_DB_PATH`). On Render's free tier the file is reset on each redeploy unless a persistent disk is attached.

## Market impact and correlations

The **Market Impact** screen connects events (de-duplicated reports and your incidents) with stocks, indices and crypto-assets. It shows only real stored prices; with no provider data it says so and invents nothing.

| Prices | Needs | Notes |
| --- | --- | --- |
| Crypto (BTC, ETH, SOL, XRP, ADA, DOGE, LTC, LINK; hourly and daily) | nothing | Coinbase Exchange public candles, USD pairs. Display terms for a public site are not confirmed. |
| US stocks and ETFs (daily, split/dividend adjusted) | `TIINGO_API_TOKEN` | Tiingo's free plan is for internal, non-commercial use. A public site needs a Tiingo commercial licence. Free limits are about 50 requests/hour and 1,000/day; the app spaces requests. |
| S&P 500, Nasdaq Composite, Dow Jones, Brent, WTI (daily) | `FRED_API_KEY` | FRED terms and the third-party limits on index series were not verified; check them before public use. |

- Without a key the affected assets show **Setup required**; failed refreshes show **Stale** (last stored prices kept) or **Unavailable**; end-of-day data is labelled **Delayed**. Listings with no free source (London, Taiwan, Amsterdam shares) are listed as **Unsupported** so they cannot be confused with the US-listed ADRs.
- Fetching runs in the background every minute, only for watched assets, assets with confirmed links and their benchmarks, incrementally, with per-provider spacing and exponential backoff. A changed Tiingo adjusted history triggers a full refetch. Set `MARKET_SYNC_DISABLED=1` to stop fetching.
- **Method**: anchor = earliest public report; reference = last completed bar close at or before it; measured = completed bar nearest to anchor + 1h/24h/7d, and a window is *Pending* until a bar at or after its end exists. Stocks and indices have daily data only, so their 1h window is *Unsupported*. "Benchmark-adjusted return" is asset minus benchmark over the same two bar times. NYSE holidays and early closes are computed from the published rules; ad hoc closures are not modelled.
- **Links** come from named entities, sector keywords and country exposure rules, each with its explanation. You can confirm, reject or add links; suggestions and your decisions are stored separately.
- **Associations and correlations** use only classifications frozen when the app first saw an event, so history accumulates from deployment and shows *Insufficient history* until enough distinct, non-overlapping events exist. Results are labelled *Preliminary association* or *Historically observed association* (n of at least 20 and a Holm-corrected sign test below 0.05). Correlation needs 60 aligned days and 10 event days.
- Alerts (watchlist tab) are optional, deduplicated per event and asset, and suppressed during a per-asset cooldown. Nothing here is advice or a forecast.
