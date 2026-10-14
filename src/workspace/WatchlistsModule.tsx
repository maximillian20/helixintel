import { useState } from 'react';
import { useWorkspaceData, wsFetch } from '../data/workspaceApi.ts';
import type { WatchlistResponse } from '../data/watchlistTypes.ts';
import { Notice, Pill, ago, fmt, type Navigate } from './shared.tsx';

const ALERT_TONE = { critical: 'Critical', warning: 'Elevated', info: 'Stable' } as const;

export function WatchlistsModule({ onNavigate }: { onNavigate: Navigate }) {
  const list = useWorkspaceData<WatchlistResponse>('/watchlist');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const data = list.data;

  async function stop(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError('');
    try {
      await action();
      await list.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not change that watch.');
    } finally {
      setBusy('');
    }
  }

  const total = data ? data.countries.length + data.indicators.length + data.places.filter((place) => place.alert.enabled).length : 0;

  return (
    <div className="module-view">
      <div className="module-header">
        <div>
          <div className="eyebrow">Watchlists and alerts</div>
          <h2>What you are watching</h2>
          <p className="muted-note">One place to see every country, indicator and map area you have asked to be alerted about, and the alerts they have produced. Alerts appear in the bell at the top of the page; this app does not send email or chat messages.</p>
        </div>
      </div>

      {error && <Notice kind="error">{error}</Notice>}
      {list.error && <Notice kind={data ? 'stale' : 'error'}>Could not refresh: {list.error}.{data ? ` Showing the version loaded at ${fmt(list.lastLoadedAt)}.` : ''}</Notice>}
      {list.loading && !data && <p role="status">Loading your watches…</p>}

      {data && total === 0 && (
        <Notice>
          You are not watching anything yet. Start from <button className="link-button" onClick={() => onNavigate('Country Assessments')}>Country Assessments</button> (Watch a country),{' '}
          <button className="link-button" onClick={() => onNavigate('Threat Indicators')}>Threat Indicators</button> (Watch an indicator) or{' '}
          <button className="link-button" onClick={() => onNavigate('Map')}>Map</button> (save a place and switch alerts on).
        </Notice>
      )}

      {data && (
        <div className="watch-grid">
          <div className="watchlist-stack">
            <div className="panel">
              <div className="panel-header"><h3>Watched countries ({data.countries.length})</h3></div>
              {data.countries.length === 0 ? <p className="muted-note">No countries watched.</p> : data.countries.map((country) => (
                <div key={country.code} className="watch-card" data-testid="watch-country">
                  <div className="watch-head">
                    <strong>{country.name}</strong>
                    {country.highestRating ? <Pill value={country.highestRating} label={`Highest rating: ${country.highestRating}`} /> : <span className="badge neutral">No assessment saved</span>}
                  </div>
                  <div className="detail-row">
                    <span>{country.openIncidents} open incident{country.openIncidents === 1 ? '' : 's'}</span>
                    <span>{country.assessedAt ? `Assessed ${ago(country.assessedAt)}` : `Watching since ${ago(country.watchedSince)}`}</span>
                  </div>
                  <div className="wl-actions">
                    <button className="outline-button" onClick={() => onNavigate('Country Assessments', country.code)}>Open</button>
                    <button className="outline-button" disabled={busy === `c:${country.code}`} onClick={() => void stop(`c:${country.code}`, () => wsFetch('PUT', `/countries/${country.code}/watch`, { watched: false }))}>Stop watching</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="panel">
              <div className="panel-header"><h3>Watched indicators ({data.indicators.length})</h3></div>
              {data.indicators.length === 0 ? <p className="muted-note">No indicators watched.</p> : data.indicators.map((indicator) => (
                <div key={`${indicator.id}|${indicator.geo}`} className="watch-card" data-testid="watch-indicator">
                  <div className="watch-head">
                    <strong>{indicator.name}</strong>
                    {indicator.lastLevel ? <Pill value={indicator.lastLevel[0].toUpperCase() + indicator.lastLevel.slice(1)} label={`Last check: ${indicator.lastLevel}`} /> : <span className="badge neutral">Not checked yet</span>}
                  </div>
                  <div className="detail-row">
                    <span>{indicator.geoName}</span>
                    <span>{indicator.lastAlertAt ? `Last alert ${ago(indicator.lastAlertAt)}` : 'No alert sent yet'}</span>
                  </div>
                  <small>Thresholds: {indicator.mode === 'fixed' ? 'fixed by you' : 'automatic'}; quiet for {indicator.cooldownHours} h after an alert.</small>
                  <div className="wl-actions">
                    <button className="outline-button" onClick={() => onNavigate('Threat Indicators', `${indicator.id}|${indicator.geo}`)}>Open</button>
                    <button className="outline-button" disabled={busy === `i:${indicator.id}|${indicator.geo}`} onClick={() => void stop(`i:${indicator.id}|${indicator.geo}`, () => wsFetch('PUT', `/indicators/${indicator.id}/settings?geo=${indicator.geo}`, { watched: false }))}>Stop watching</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="panel">
              <div className="panel-header"><h3>Map places ({data.places.length})</h3></div>
              {data.places.length === 0 ? <p className="muted-note">No places saved on the map.</p> : data.places.map((place) => (
                <div key={place.id} className="watch-card" data-testid="watch-place">
                  <div className="watch-head">
                    <strong>{place.name}</strong>
                    <span className={`badge ${place.alert.enabled ? 'success' : 'neutral'}`}>{place.alert.enabled ? 'Alerts on' : 'Alerts off'}</span>
                  </div>
                  <div className="detail-row">
                    <span>{place.alert.enabled ? `${place.alert.minSeverity === 'Any' ? 'Any severity' : `${place.alert.minSeverity} or higher`}${place.alert.categories.length ? `, ${place.alert.categories.join(', ')}` : ', all categories'}` : 'Saved for reference'}</span>
                    <span>{place.lastAlertAt ? `Last alert ${ago(place.lastAlertAt)}` : 'No alert yet'}</span>
                  </div>
                  <div className="wl-actions">
                    <button className="outline-button" onClick={() => onNavigate('Map')}>Open Map to edit</button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header"><h3>Alert feed{data.unread > 0 ? ` (${data.unread} unread)` : ''}</h3></div>
            <p className="muted-note">The same alerts as the bell{data.alerts.length > 0 ? `; your latest ${data.alerts.length} are shown` : ''}.</p>
            {data.alerts.length === 0 ? <p>No alerts yet. They are created when something you watch changes; nothing is shown until then.</p> : (
              <div className="alert-stack">
                {data.alerts.map((alert) => (
                  <div key={alert.id} className="alert-item" data-testid="watch-alert">
                    <div className="watch-head">
                      <strong>{alert.title}</strong>
                      <Pill value={ALERT_TONE[alert.severity]} label={alert.severity} />
                    </div>
                    <p>{alert.detail}</p>
                    <div className="detail-row">
                      <span>{fmt(alert.createdAt)}</span>
                      {alert.link ? <button className="link-button" onClick={() => onNavigate(alert.link!.view as Parameters<Navigate>[0], alert.link!.id)}>Open</button> : <span />}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
