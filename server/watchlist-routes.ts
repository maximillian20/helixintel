import type { Express, Request, Response } from 'express';
import { countryName } from '../src/data/countries';
import { RATING_RANK, type Rating } from '../src/data/workspaceTypes';
import type { WatchlistResponse } from '../src/data/watchlistTypes';
import type { AnalysisStore } from './analysis-store';
import { getDefinition } from './indicators';
import type { PlaceStore } from './map-service';

type Deps = {
  app: Express;
  analysis: AnalysisStore;
  places: PlaceStore;
  requireClientId: (req: Request, res: Response) => string | null;
};

/** Everything this browser is watching, built only from saved watches, saved places and stored alerts. */
export function buildWatchlist(analysis: AnalysisStore, places: PlaceStore, clientId: string): WatchlistResponse {
  const since = analysis.watchedSince(clientId);
  const latest = analysis.latestAssessments(clientId);
  const open = analysis.listIncidents(clientId).filter((incident) => incident.status !== 'Closed');
  const countries = analysis.getWatchedCountries(clientId).map((code) => {
    const version = latest.get(code);
    let highest: Rating | null = null;
    if (version) {
      for (const entry of Object.values(version.categories)) {
        if (entry.rating === 'Unassessed') continue;
        if (highest === null || RATING_RANK[entry.rating as Rating] > RATING_RANK[highest]) highest = entry.rating as Rating;
      }
    }
    return {
      code, name: countryName(code), watchedSince: since.get(code) ?? '',
      highestRating: highest, assessedAt: version?.assessedAt ?? null,
      openIncidents: open.filter((incident) => incident.countries.some((country) => country.code === code)).length,
    };
  });

  const indicators = analysis.watchedIndicators(clientId).flatMap((watch) => {
    const def = getDefinition(watch.indicatorId);
    if (!def) return [];
    const state = analysis.getIndicatorState(clientId, watch.indicatorId, watch.geo);
    const settings = analysis.getIndicatorSettings(clientId, watch.indicatorId, watch.geo);
    return [{
      id: def.id, name: def.name, geo: watch.geo, geoName: watch.geo === 'ALL' ? 'All countries' : countryName(watch.geo),
      lastLevel: state?.lastLevel ?? null, lastAlertAt: state?.lastAlertAt ?? null, mode: settings.mode, cooldownHours: settings.cooldownHours,
    }];
  });

  const placeRows = places.list(clientId).map((place) => ({ id: place.id, name: place.name, kind: place.kind, alert: place.alert, lastAlertAt: places.lastAlert(clientId, place.id) }));
  const { items, unread } = analysis.listAlerts(clientId, 50);
  return { countries, indicators, places: placeRows, alerts: items, unread };
}

export function registerWatchlistRoutes({ app, analysis, places, requireClientId }: Deps) {
  app.get('/api/workspace/watchlist', (req, res) => {
    const clientId = requireClientId(req, res);
    if (!clientId) return;
    try {
      res.set('Cache-Control', 'no-store');
      res.json(buildWatchlist(analysis, places, clientId));
    } catch (error) {
      console.error('Watchlist request failed', error);
      res.status(500).json({ error: 'The request could not be completed.' });
    }
  });
}
