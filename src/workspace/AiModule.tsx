import { useEffect, useState } from 'react';
import { aiFetch, useAiRun, useAiStatus } from '../data/aiApi.ts';
import type { AiAnswerDto, AiAuditEntry, AiOutputSummary, AiSettingsDto, FollowUp } from '../data/aiTypes.ts';
import { SEVERITIES } from '../data/feedTypes.ts';
import { AiStatusBanner, AnswerView, ErrorNote } from './aiParts.tsx';
import { Notice, ago, fmt, usePersistentState, type Navigate } from './shared.tsx';

const EXAMPLES = [
  'What changed in the Red Sea during the last 24 hours?',
  'Which high-severity reports remain unreviewed?',
  'Which incidents could affect the places or assets I track?',
  'Summarise the situation for my watched countries.',
];

type Tab = 'Ask' | 'Briefing' | 'History' | 'Settings';
const KIND_LABEL: Record<string, string> = {
  ask: 'Question', 'incident-assist': 'Incident assist', 'country-assist': 'Country assist', briefing: 'Briefing',
  'indicator-explain': 'Indicator', 'market-explain': 'Market', 'sib-draft': 'Bulletin draft',
};

export function AiModule({ focusId, onNavigate }: { focusId?: string; onNavigate: Navigate }) {
  const { status, error, reload } = useAiStatus();
  const [tab, setTab] = useState<Tab>(focusId?.startsWith('AI-') ? 'History' : 'Ask');
  const [openId, setOpenId] = useState<string | null>(focusId?.startsWith('AI-') ? focusId : null);
  const ready = status?.state === 'ready' && status.userEnabled;
  return (
    <div className="ws-module ai-module">
      <AiStatusBanner status={status} error={error} />
      <div className="ws-tabs" role="tablist" aria-label="Ask Helix sections">
        {(['Ask', 'Briefing', 'History', 'Settings'] as Tab[]).map((name) => (
          <button key={name} role="tab" aria-selected={tab === name} className={tab === name ? 'selected' : ''} onClick={() => setTab(name)}>{name}</button>
        ))}
      </div>
      {tab === 'Ask' && <AskPanel ready={ready} onNavigate={onNavigate} onFailure={reload} />}
      {tab === 'Briefing' && <BriefingPanel ready={ready} onNavigate={onNavigate} onFailure={reload} />}
      {tab === 'History' && <HistoryPanel openId={openId} setOpenId={setOpenId} onNavigate={onNavigate} />}
      {tab === 'Settings' && <SettingsPanel status={status} onChanged={reload} />}
    </div>
  );
}

function AskPanel({ ready, onNavigate, onFailure }: { ready: boolean; onNavigate: Navigate; onFailure: () => void }) {
  const [form, setForm] = usePersistentState('ai-ask', { question: '', days: 0, severity: '', review: '', watchlistOnly: false });
  const { data, error, running, run, cancel } = useAiRun<AiAnswerDto>();

  async function ask(question: string, refresh = false) {
    const text = question.trim();
    if (!text) return;
    setForm({ ...form, question: text });
    const scope: Record<string, unknown> = {};
    if (form.days > 0) scope.days = form.days;
    if (form.severity) scope.severity = form.severity;
    if (form.review) scope.review = form.review;
    if (form.watchlistOnly) scope.watchlistOnly = true;
    const result = await run('POST', '/ask', { question: text, scope: Object.keys(scope).length ? scope : undefined, refresh });
    if (!result) onFailure();
  }

  function followUp(item: FollowUp) {
    if (item.question) void ask(item.question);
    else if (item.target) onNavigate(item.target.view as Parameters<Navigate>[0], item.target.id);
  }

  return (
    <section className="panel ai-ask">
      <form className="ws-form" onSubmit={(event) => { event.preventDefault(); void ask(form.question); }}>
        <label>Your question
          <textarea rows={3} maxLength={400} value={form.question} placeholder="For example: What changed in the Red Sea during the last 24 hours?" onChange={(event) => setForm({ ...form, question: event.target.value })} />
        </label>
        <div className="ai-scope" aria-label="Limit what the answer may use">
          <label>Time<select value={form.days} onChange={(event) => setForm({ ...form, days: Number(event.target.value) })}>
            <option value={0}>Any time (or as worded)</option><option value={1}>Last 24 hours</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option>
          </select></label>
          <label>Minimum severity<select value={form.severity} onChange={(event) => setForm({ ...form, severity: event.target.value })}>
            <option value="">Any</option>{SEVERITIES.filter((value) => value !== 'Unassessed').map((value) => <option key={value} value={value}>{value}</option>)}
          </select></label>
          <label>Review state<select value={form.review} onChange={(event) => setForm({ ...form, review: event.target.value })}>
            <option value="">Any</option><option value="Unreviewed">Unreviewed</option><option value="Reviewed">Reviewed</option>
          </select></label>
          <label className="ai-check"><input type="checkbox" checked={form.watchlistOnly} onChange={(event) => setForm({ ...form, watchlistOnly: event.target.checked })} /> Watchlist only</label>
        </div>
        <p className="muted-note">These limits are applied before anything is retrieved, so records outside them can never appear in an answer. Only records this browser may access are searched.</p>
        <div className="ws-form-actions">
          {!running && <button className="primary-button" disabled={!ready || !form.question.trim()} title={ready ? undefined : 'AI setup required'}>Ask Helix</button>}
          {running && <button type="button" className="outline-button" onClick={cancel}>Cancel</button>}
          {running && <span className="muted-note" role="status">Working on your computer's model. Small models can take a minute or more.</span>}
        </div>
      </form>
      <div className="ai-examples">
        {EXAMPLES.map((text) => <button key={text} type="button" className="chip-button" disabled={!ready || running} onClick={() => void ask(text)}>{text}</button>)}
      </div>
      <ErrorNote error={error} />
      {data && (
        <div className="ai-result">
          <h3>{data.title}</h3>
          <AnswerView answer={data} onNavigate={onNavigate}>
            {data.followUps.length > 0 && (
              <section className="ai-section"><h4>Next steps</h4>
                <div className="ai-examples">{data.followUps.map((item) => <button key={item.label} type="button" className="chip-button" disabled={running || (Boolean(item.question) && !ready)} onClick={() => followUp(item)}>{item.label}</button>)}</div>
              </section>
            )}
          </AnswerView>
          <div className="ws-form-actions"><button className="ghost-button small" disabled={!ready || running} onClick={() => void ask(data.question ?? form.question, true)}>Regenerate</button></div>
        </div>
      )}
    </section>
  );
}

type BriefingResult = { generated: boolean; message: string; reviewCount: number; answer: AiAnswerDto | null };

function BriefingPanel({ ready, onNavigate, onFailure }: { ready: boolean; onNavigate: Navigate; onFailure: () => void }) {
  const { data, error, running, run, cancel } = useAiRun<BriefingResult>();
  const [latest, setLatest] = useState<AiAnswerDto | null>(null);
  useEffect(() => {
    void aiFetch<{ items: AiOutputSummary[] }>('GET', '/outputs?limit=40').then(async (list) => {
      const last = list.items.find((item) => item.kind === 'briefing');
      if (last) setLatest(await aiFetch<AiAnswerDto>('GET', `/outputs/${last.id}`));
    }).catch(() => undefined);
  }, []);
  const shown = data?.answer ?? latest;
  return (
    <section className="panel">
      <div className="panel-header"><h3>Your briefing</h3></div>
      <p className="muted-note">A briefing covers what is new or changed for your watched countries, saved places and watchlist since the last briefing. If nothing changed, nothing is generated and nothing is repeated.</p>
      <div className="ws-form-actions">
        {!running && <button className="primary-button" disabled={!ready} title={ready ? undefined : 'AI setup required'} onClick={async () => { if (!(await run('POST', '/briefing'))) onFailure(); }}>Brief me now</button>}
        {running && <button className="outline-button" onClick={cancel}>Cancel</button>}
      </div>
      <ErrorNote error={error} />
      {data && !data.generated && <Notice>{data.message}</Notice>}
      {data?.reviewCount ? <p className="muted-note">{data.reviewCount} report{data.reviewCount === 1 ? '' : 's'} still awaiting your review. <button className="link-button" onClick={() => onNavigate('Intelligence Feed')}>Open the feed</button></p> : null}
      {shown ? <AnswerView answer={shown} onNavigate={onNavigate} /> : <p className="muted-note">No briefing yet.</p>}
    </section>
  );
}

function HistoryPanel({ openId, setOpenId, onNavigate }: { openId: string | null; setOpenId: (id: string | null) => void; onNavigate: Navigate }) {
  const [items, setItems] = useState<AiOutputSummary[] | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [error, setError] = useState('');
  const [opened, setOpened] = useState<AiAnswerDto | null>(null);
  const load = () => aiFetch<{ items: AiOutputSummary[] }>('GET', `/outputs?includeDismissed=${showDismissed}`).then((r) => { setItems(r.items); setError(''); }).catch((e: Error) => setError(e.message));
  useEffect(() => { void load(); }, [showDismissed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!openId) { setOpened(null); return; }
    aiFetch<AiAnswerDto>('GET', `/outputs/${openId}`).then(setOpened).catch((e: Error) => setError(e.message));
  }, [openId]);
  async function dismiss(id: string, dismissed: boolean) {
    try { await aiFetch('POST', `/outputs/${id}/dismiss`, { dismissed }); if (openId === id) setOpenId(null); void load(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not update.'); }
  }
  return (
    <section className="panel">
      <div className="panel-header"><h3>Saved AI results</h3>
        <label className="ai-check"><input type="checkbox" checked={showDismissed} onChange={(event) => setShowDismissed(event.target.checked)} /> Show dismissed</label></div>
      {error && <Notice kind="error">{error}</Notice>}
      {items && items.length === 0 && <p className="muted-note">Nothing yet. Results you generate are kept here so you can reopen their sources.</p>}
      <ul className="ai-history">
        {(items ?? []).map((item) => (
          <li key={item.id} className={item.status}>
            <button className="link-button" onClick={() => setOpenId(item.id === openId ? null : item.id)}>{item.title}</button>
            <small className="muted-note">{KIND_LABEL[item.kind] ?? item.kind} · {ago(item.generatedAt)} · {item.model}{item.status === 'dismissed' ? ' · dismissed' : ''}</small>
            <button className="ghost-button small" onClick={() => void dismiss(item.id, item.status !== 'dismissed')}>{item.status === 'dismissed' ? 'Restore' : 'Dismiss'}</button>
          </li>
        ))}
      </ul>
      {opened && <AnswerView answer={opened} onNavigate={onNavigate} />}
    </section>
  );
}

function SettingsPanel({ status, onChanged }: { status: ReturnType<typeof useAiStatus>['status']; onChanged: () => void }) {
  const [settings, setSettings] = useState<AiSettingsDto | null>(null);
  const [audit, setAudit] = useState<AiAuditEntry[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void aiFetch<AiSettingsDto>('GET', '/settings').then(setSettings).catch((e: Error) => setError(e.message));
    void aiFetch<{ items: AiAuditEntry[] }>('GET', '/audit').then((r) => setAudit(r.items)).catch(() => undefined);
  }, []);
  async function save(patch: object) {
    try { setSettings(await aiFetch<AiSettingsDto>('PUT', '/settings', patch)); setError(''); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
  }
  return (
    <>
      <section className="panel">
        <div className="panel-header"><h3>AI settings for this browser</h3></div>
        {error && <Notice kind="error">{error}</Notice>}
        {settings && (
          <div className="ws-form">
            <label className="ai-check"><input type="checkbox" checked={settings.enabled} onChange={(event) => void save({ enabled: event.target.checked })} /> Use AI features in this browser</label>
            <p className="muted-note">Switching this off stops every AI request from this browser. Saved results stay visible; nothing else in the app changes.</p>
            <label>Scheduled briefing
              <select value={settings.briefing.schedule} onChange={(event) => void save({ briefing: { schedule: event.target.value } })}>
                <option value="off">Off (only when I ask)</option><option value="daily">Daily</option><option value="weekly">Weekly (Mondays)</option>
              </select>
            </label>
            {settings.briefing.schedule !== 'off' && (
              <label>Time (UTC)<select value={settings.briefing.hourUtc} onChange={(event) => void save({ briefing: { hourUtc: Number(event.target.value) } })}>
                {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}
              </select></label>
            )}
            {settings.briefing.schedule !== 'off' && <p className="muted-note">Scheduled briefings only run while the AI computer is online, are generated at most once per slot, and skip the model entirely when nothing has changed. Last attempt: {settings.briefing.lastRunAt ? fmt(settings.briefing.lastRunAt) : 'none yet'}.</p>}
          </div>
        )}
      </section>
      {status && (
        <section className="panel">
          <div className="panel-header"><h3>Model and usage</h3></div>
          <dl className="ai-facts">
            <div><dt>Model</dt><dd>{status.model}{status.modelDigest ? ` (${status.modelDigest})` : ''}</dd></div>
            <div><dt>Service</dt><dd>{status.provider === 'cloudflare' ? 'Cloudflare Workers AI, free plan (hosted; stops at its daily allowance and never charges)' : 'Ollama on a computer you own'} · {status.endpoint ?? 'not configured'}</dd></div>
            {status.usage && <div><dt>Used today (UTC)</dt><dd>{status.usage.requests} requests, {status.usage.promptTokens.toLocaleString()} tokens in, {status.usage.completionTokens.toLocaleString()} out, counted by this server since it started. The free allowance is 10,000 neurons per day; Cloudflare's own dashboard shows the exact figure.</dd></div>}
            <div><dt>Private records</dt><dd>{status.privateRecords ? 'May be used in prompts (the model is under your control).' : 'Not sent. Incident and country assistants, bulletins from them and saved places are off for this service.'}</dd></div>
            <div><dt>Queue</dt><dd>{status.queue.running} running, {status.queue.waiting} waiting (limit {status.queue.limit}, {status.queue.concurrency} at a time)</dd></div>
            <div><dt>Generated / reused / failed</dt><dd>{status.counters.generated} / {status.counters.cacheHits} / {status.counters.failures} (timeouts {status.counters.timeouts}, invalid {status.counters.rejectedInvalid})</dd></div>
            <div><dt>Paid AI calls</dt><dd>{status.paidProviderCalls}. The app only contacts the one endpoint above and refuses paid-provider addresses.</dd></div>
            <div><dt>Automatic report summaries</dt><dd>{status.autoEnrich === 'off' ? 'Off' : status.autoEnrich === 'all' ? 'All new reports' : 'New Critical and High reports'}, only while the model is idle</dd></div>
          </dl>
        </section>
      )}
      <section className="panel">
        <div className="panel-header"><h3>AI activity log</h3></div>
        {audit && audit.length === 0 && <p className="muted-note">No AI activity yet.</p>}
        <ul className="ai-audit">
          {(audit ?? []).map((entry) => <li key={entry.id}><strong>{entry.action}</strong> · {entry.actor} · {fmt(entry.at)}<br /><small className="muted-note">{entry.subject}: {entry.detail}</small></li>)}
        </ul>
      </section>
    </>
  );
}
