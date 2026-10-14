# Global Security Intelligence

This repository contains a web application for political-risk, security, and human-rights monitoring.

## Quick start

1. Install Node.js LTS.
2. Install dependencies:
   npm install
3. Start the development stack:
   npm run dev
4. Open the frontend at http://localhost:5173
5. API health check: http://localhost:3001/api/health

## Data

Every figure in the app comes from real public sources or from your own saved work (incidents, assessments, bulletins, watches and places). There is no demo mode and no sample data. If a source is blocked or needs setup, the Sources page says so and the affected screens show that status instead of a made-up value.

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
| BBC News World, UN News, Al Jazeera English, The Guardian World | Free RSS | none |
| UK Foreign Office travel advice | Free Atom feed (Open Government Licence) | none |
| GDACS (disasters, with alert levels and coordinates) | Free RSS, CC BY 4.0 | none |
| GDELT DOC 2.0 (news headlines) | Free API | optional `GDELT_QUERY` |
| CISA Known Exploited Vulnerabilities | Free JSON | none |
| ReliefWeb | Free, needs a pre-approved app name (https://apidoc.reliefweb.int/) | `RELIEFWEB_APPNAME` |
| US EIA oil spot prices | Free key (https://www.eia.gov/opendata/register.php) | `EIA_API_KEY` |

Credentials are read only on the server. A source without its credential is shown as "Setup required" on the Sources page and is never called.
Fast sources are checked every 15 minutes (`SOURCE_POLL_INTERVAL_MS`), CISA every 6 hours, ReliefWeb hourly, EIA every 12 hours.

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

## Map workspace

The **Map** page is an interactive geographic workspace. Everything on it is real data; there is no demo mode or synthetic fallback. A layer whose source is blocked or needs setup shows that status while the other layers keep working.

**Layers** (each can be switched on and off independently): news and agency reports, GDELT news mentions, ReliefWeb, GDACS, USGS earthquakes, NASA EONET events, your incidents, saved places and areas, country risk shading, and aircraft.

| Source | How it is read | Terms and limits |
| --- | --- | --- |
| USGS earthquakes | Summary GeoJSON feeds (`.../feed/v1.0/summary/{level}_{hour,day,week,month}.geojson`), about every 5 minutes. Each fetch uses the smallest feed that covers the time since the last success. Default level M4.5+ (`USGS_FEED_LEVEL`). | US government data; credit USGS. The feed pages state no rate limit; the app makes one request per source per interval. |
| NASA EONET v3 | `/api/v3/events?status=all&days=…`, about every 30 minutes (30 days first, then 7). | No key or limit is stated. NASA says event locations are not official precise data. |
| GDACS, GDELT, ReliefWeb | The existing feed connectors; the map reads their stored records. | ReliefWeb needs `RELIEFWEB_APPNAME` (shown as "Setup required"). GDELT places are reported locations from country mentions in headlines. |
| ADSB.lol aircraft | `GET {ADSB_API_BASE}/v2/point/{lat}/{lon}/{radius_nm}` for the visible area only (max 250 nm). | ODbL licence; attribution required; ADSB.lol asks to be contacted before production use. **The documentation pages could not be opened while this was built, so the request/response format follows the readsb v2 convention and is unverified; check it against https://api.adsb.lol/docs.** Set `ADSB_CONTACT_CONFIRMED=1` after contacting them. OpenSky and Flightradar24 are not used. |
| Base map | OpenStreetMap standard tiles unless `MAP_TILE_URL` is set. | OSM's public tile servers are for light use (https://operations.osmfoundation.org/policies/tiles/); no bulk or offline downloading. For production traffic use a self-hosted or commercial provider and set `MAP_TILE_URL` and `MAP_TILE_ATTRIBUTION`. |
| Country outlines | Natural Earth 110m (public domain) fetched by the server from `MAP_COUNTRY_BOUNDARIES_URL` (default: jsDelivr copy) and cached; if it cannot be loaded the layer falls back to labelled country-centre discs. | The default URL could not be tested from the build environment. |

**Time filtering.** Each record is filtered by its own time: event time for USGS and EONET, publication time for news, GDELT, ReliefWeb and GDACS alerts (a GDACS alert time is when GDACS published it), and the incident date for incidents. Aircraft are live positions only: they ignore the time range, and the layer is disabled when a custom range ends before today.

**Severity and accuracy.** Colours are shared with the feed (Critical `#DC2626`, High `#F97316`, Medium `#F59E0B`, Low `#22C55E`, Unassessed `#94A3B8`). USGS and EONET records are always *Unassessed*: earthquake magnitude, PAGER alert and EONET magnitudes are shown as supplied and never converted. GDACS keeps the feed's documented mapping (Red = Critical, Orange = High, Green = Low), which describes the hazard, not business impact. Markers use source coordinates, analyst-entered incident coordinates, or the country centre (dashed ring, labelled approximate). Records without a usable location are listed separately and never placed.

**Duplicates.** Hazard records from different providers are linked when they have the same hazard type and lie within 100 km and 6 h (earthquakes), 500 km and 5 days (cyclones) or 300 km and 7 days (others). All records are kept; counts show records and distinct events separately.

**Country risk shading** is a separate layer: the highest category rating in the latest saved, evidence-backed country assessment (Low to Severe). Countries without an assessment are not shaded.

**Aircraft.** Only the visible area is queried (movement is debounced), responses are cached and shared between browsers, polling stops when the layer is off or the tab is hidden, and positions fade after 30 s and are removed after 120 s (these thresholds are this app's, not the provider's). Coverage is provider-dependent; a missing aircraft does not mean anything is wrong. Callsign, altitude, speed, heading and similar fields are shown only when supplied, and no airline or route is inferred.

**Saved places and alerts.** Save a location, a radius or a bounding box (kept on the server, per browser). Optional in-app alerts cover new events with provider or analyst coordinates inside the place, filtered by minimum severity and category, deduplicated per place and event, with a cooldown, and never back-filled. They are labelled "geographic match, not confirmed business impact". On Render's free plan the database is lost on redeploy unless a persistent disk is attached.

## Security information bulletins (SIBs)

A bulletin is always created from a real record: an incident (**New bulletin** on the SIBs page or **Create SIB** on an incident) or a saved country assessment. The record's content is copied in as an editable starting point:

- **From an incident:** title, severity, location, summary, linked reports (as the source list), operational and business impacts, assets and open actions. *Impact on employees* is left empty because incidents do not record it.
- **From a country assessment:** the summary, each rated category with its rationale, and the evidence. The pre-filled severity maps the highest category rating (Severe → Critical, High → High, Elevated → Medium, Moderate and Low → Low); change it if you disagree.

Rules: a draft needs a title, a severity other than Unassessed, a location, an executive summary, at least one recommended action and at least one source report before it can be approved. Approved bulletins are locked; **Reopen as draft** removes the approval and the revision number increases on the next approval. If the source incident or assessment changes after drafting, the page says so and offers to replace the source reports (your text is never overwritten). Every create, edit, approval and reopening is kept in an audit trail.

There are no user accounts. The approver is the analyst name set in the browser (top-right circle); approval is refused without one. It records who approved but does not verify identity. Bulletins are private to the browser that created them, like incidents.

Exports use one document model, so they match the preview: **PDF (print)** opens the browser print dialog (choose *Save as PDF*), **Word (.doc)** is an HTML document Word opens and edits, **HTML**, **Email** (a shortened text version in your mail program) and **Copy text**. Drafts are marked "not approved" in every export. Classification choices are Public, Internal, Internal / Restricted and Confidential.
