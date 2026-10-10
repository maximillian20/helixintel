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
