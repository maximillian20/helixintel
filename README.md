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
