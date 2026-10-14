import type { Severity } from './feedTypes';
import type { AlertDto, Rating } from './workspaceTypes';
import type { PlaceAlertRule, PlaceKind } from './mapTypes';

export type WatchedCountry = {
  code: string;
  name: string;
  watchedSince: string;
  /** Highest category rating in your latest saved assessment; null when none has been saved. */
  highestRating: Rating | null;
  assessedAt: string | null;
  openIncidents: number;
};

export type WatchedIndicator = {
  id: string;
  name: string;
  geo: string;
  geoName: string;
  /** Level at the last background check (the server re-checks every few minutes); null until the first check. */
  lastLevel: string | null;
  lastAlertAt: string | null;
  mode: 'auto' | 'fixed';
  cooldownHours: number;
};

export type WatchedPlace = {
  id: string;
  name: string;
  kind: PlaceKind;
  alert: PlaceAlertRule;
  lastAlertAt: string | null;
};

export type WatchlistResponse = {
  countries: WatchedCountry[];
  indicators: WatchedIndicator[];
  places: WatchedPlace[];
  alerts: AlertDto[];
  unread: number;
};

export type { Severity };
