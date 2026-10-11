import { CATALOG, catalogById, type CatalogEntry } from './market-catalog';
import { countryName } from '../src/data/countries';
import type { LinkExplanation, Relevance, WhyMatters } from '../src/data/marketTypes';

/**
 * Rule-based link suggestions. These are hypotheses about exposure, not findings.
 * The exposure table below is the app's own curated mapping and is shown to the user through each link's explanation.
 */
export const LINK_RULES_VERSION = 'v1';

export type LinkInput = { text: string; categories: string[]; countries: string[]; severity: string };
export type LinkSuggestion = { assetId: string; ruleId: string; relevance: Relevance; explanation: LinkExplanation };

const CATEGORY_GROUPS: Record<string, string[]> = {
  conflict: ['armed-attack', 'armed-clashes', 'escalation', 'war-declaration', 'hostage-taking', 'conflict-context', 'wmd', 'atrocity', 'extremism', 'coup', 'power-seizure'],
  political: ['diplomacy', 'political', 'protest', 'unrest', 'repression', 'migration'],
  humanitarian: ['famine', 'famine-declared', 'hunger', 'mass-displacement', 'evacuation', 'health-emergency'],
  cyber: ['cyber'],
  'natural-hazard': ['natural-hazard'],
};
export const MARKET_CATEGORIES = [...Object.keys(CATEGORY_GROUPS), 'other'];

/** Single market category for grouping, from the classifier's rule ids (or the source's own label as a fallback). */
export function marketCategory(ruleIds: string[], fallbackLabel = ''): string {
  for (const id of ruleIds) for (const [group, ids] of Object.entries(CATEGORY_GROUPS)) if (ids.includes(id)) return group;
  const label = fallbackLabel.toLowerCase();
  if (/vulnerab|cyber|ransom/.test(label)) return 'cyber';
  if (/earthquake|cyclone|flood|volcan|drought|wildfire|tsunami|natural/.test(label)) return 'natural-hazard';
  return 'other';
}

type Sector = {
  id: string;
  label: string;
  /** Market categories that alone connect an event to the sector. */
  categories: string[];
  /** Categories that connect an event only when it is in one of the listed countries. */
  geoCategories: string[];
  countries: string[];
  keywords: string[];
  /** When false, a country plus category is not enough: a keyword (or a sufficient category) is required. */
  geoAlone?: boolean;
  assets?: string[];
  pathway: string;
};

const SECTORS: Sector[] = [
  { id: 'oil-gas', label: 'oil and gas', categories: [], geoCategories: ['conflict', 'political', 'natural-hazard'],
    countries: ['SA', 'IR', 'IQ', 'AE', 'KW', 'QA', 'LY', 'NG', 'RU', 'KZ', 'VE', 'DZ', 'OM', 'YE'],
    keywords: ['oil', 'crude', 'pipeline', 'refinery', 'hormuz', 'opec', 'lng', 'gas field', 'tanker', 'oilfield', 'oil terminal'],
    pathway: 'Disruption to production, transport or sanctions in oil- and gas-producing regions can change supply expectations and therefore energy prices, which producers and oil-price benchmarks are exposed to.' },
  { id: 'oil-benchmark', label: 'oil benchmark', categories: [], geoCategories: ['conflict', 'political', 'natural-hazard'],
    countries: ['SA', 'IR', 'IQ', 'AE', 'KW', 'QA', 'LY', 'NG', 'RU', 'KZ', 'VE', 'DZ', 'OM', 'YE'],
    keywords: ['oil', 'crude', 'pipeline', 'refinery', 'hormuz', 'opec', 'tanker', 'oilfield', 'oil terminal'],
    pathway: 'Spot oil prices respond to changes in expected supply from producing regions or shipping routes.' },
  { id: 'defense', label: 'defence', categories: ['conflict'], geoCategories: [], countries: [],
    keywords: ['missile', 'airstrike', 'drone strike', 'military buildup', 'rearmament', 'defence spending', 'defense spending', 'arms'],
    pathway: 'Armed conflict and military escalation can change expected defence procurement and government spending, which defence contractors derive revenue from.' },
  { id: 'shipping', geoAlone: false, label: 'shipping and logistics', categories: [], geoCategories: ['conflict', 'political', 'natural-hazard'],
    countries: ['YE', 'EG', 'SO', 'PA', 'IR', 'OM', 'DJ'],
    keywords: ['shipping', 'red sea', 'suez', 'houthi', 'strait', 'port closure', 'container', 'vessel', 'maritime', 'panama canal', 'blockade'],
    pathway: 'Disruption to sea lanes or ports can change freight rates, transit times and costs for carriers and logistics firms.' },
  { id: 'airlines', geoAlone: false, label: 'airlines', categories: [], geoCategories: ['conflict', 'natural-hazard'],
    countries: ['UA', 'RU', 'IR', 'IQ', 'IL', 'SY', 'AF'],
    keywords: ['airspace', 'flights suspended', 'flight ban', 'airport closed', 'airline', 'aviation'],
    pathway: 'Airspace closures and airport disruption can force reroutes or cancellations and raise fuel and operating costs for airlines.' },
  { id: 'cyber', label: 'cybersecurity', categories: ['cyber'], geoCategories: [], countries: [],
    keywords: ['ransomware', 'data breach', 'zero-day', 'cyberattack', 'cyber attack', 'exploited vulnerabilit'],
    pathway: 'Large cyber incidents can change expected demand for security products and services.' },
  { id: 'semiconductors', geoAlone: false, label: 'semiconductors', categories: [], geoCategories: ['conflict', 'political', 'natural-hazard'],
    countries: ['TW', 'KR', 'JP', 'CN'],
    keywords: ['semiconductor', 'chip', 'taiwan strait', 'wafer', 'chipmaking', 'export controls'],
    pathway: 'Events affecting major chip-producing regions or trade controls can change expected supply for semiconductor firms.' },
  { id: 'agriculture', geoAlone: false, label: 'agriculture and fertiliser', categories: [], geoCategories: ['conflict', 'natural-hazard', 'humanitarian'],
    countries: ['UA', 'RU', 'BY', 'IN', 'BR', 'AR', 'US', 'AU', 'CA'],
    keywords: ['grain', 'wheat', 'fertilizer', 'fertiliser', 'crop', 'harvest', 'black sea', 'potash'],
    pathway: 'Conflict, drought or trade restrictions in major farming regions can change expected crop and fertiliser supply.' },
  { id: 'crypto', label: 'crypto-assets', categories: [], geoCategories: [], countries: [],
    keywords: ['crypto', 'bitcoin', 'stablecoin', 'exchange hack', 'defi', 'cryptocurrency', 'blockchain'],
    assets: ['crypto:BTC-USD:COINBASE', 'crypto:ETH-USD:COINBASE'],
    pathway: 'Security incidents or regulatory actions involving crypto platforms can change risk appetite toward crypto-assets.' },
  { id: 'gold', label: 'gold mining', categories: [], geoCategories: [], countries: [], keywords: ['gold price', 'gold mine', 'gold reserves'],
    pathway: 'Events affecting gold supply or demand may change expectations for gold producers.' },
];

const COMMON_ALTERNATIVES = [
  'Other news or scheduled data released around the same time (earnings, central-bank decisions, economic releases).',
  'A general market-wide move that affected many assets at once.',
  'Asset-specific developments unrelated to this event.',
];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patternCache = new Map<string, RegExp>();
function matcher(term: string) {
  let re = patternCache.get(term);
  if (!re) { re = new RegExp(`(^|[^\\p{L}\\p{N}])${escape(term)}($|[^\\p{L}\\p{N}])`, 'iu'); patternCache.set(term, re); }
  return re;
}
const hasTerm = (text: string, term: string) => matcher(term).test(text);
const RANK: Record<Relevance, number> = { Direct: 0, 'Sector and geography': 1, Sector: 2, 'Broad market': 3, 'Analyst-added': 4 };

export function suggestLinks(input: LinkInput, max = 24): LinkSuggestion[] {
  const out = new Map<string, LinkSuggestion>();
  const text = input.text;
  const category = marketCategory(input.categories);
  const put = (entry: CatalogEntry, suggestion: Omit<LinkSuggestion, 'assetId'>) => {
    const existing = out.get(entry.id);
    if (!existing || RANK[suggestion.relevance] < RANK[existing.relevance]) out.set(entry.id, { assetId: entry.id, ...suggestion });
  };

  // 1. Explicit entity mentions (names and aliases only; ticker symbols are not matched because many are ordinary words).
  for (const entry of CATALOG) {
    const term = [entry.name.replace(/\s*\(.*\)$/, ''), ...entry.aliases].find((candidate) => candidate.length >= 3 && hasTerm(text, candidate));
    if (!term) continue;
    put(entry, {
      ruleId: 'entity-mention', relevance: 'Direct',
      explanation: {
        ruleId: 'entity-mention', relevance: 'Direct',
        basis: `The report text names "${term}".`,
        pathway: entry.class === 'crypto' ? 'A report that names this crypto-asset directly may bear on its use, security or regulation.' : entry.class === 'index' ? 'A report that names this benchmark directly refers to the market or commodity it measures.' : 'A report that names the company directly may bear on its operations, assets, customers or regulation.',
        alternatives: ['The name appears in passing and the report is not about the company.', ...COMMON_ALTERNATIVES],
      },
    });
  }

  // 2. Sector exposure with category, keyword and geographic evidence.
  for (const sector of SECTORS) {
    const keyword = sector.keywords.find((term) => hasTerm(text, term));
    const sufficient = sector.categories.includes(category);
    const country = input.countries.find((code) => sector.countries.includes(code));
    const geoCombo = Boolean(country) && sector.geoAlone !== false && sector.geoCategories.includes(category);
    if (!keyword && !sufficient && !geoCombo) continue;
    const geoSupported = Boolean(country) && sector.geoCategories.includes(category);
    const relevance: Relevance = country && (keyword || geoCombo || sufficient) && (geoSupported || sufficient || sector.geoCategories.length === 0) ? 'Sector and geography' : 'Sector';
    const basisParts: string[] = [];
    if (sufficient) basisParts.push(`the event category is "${category}"`);
    if (keyword) basisParts.push(`the text mentions "${keyword}"`);
    if (country) basisParts.push(`${countryName(country)} is listed in this app's exposure table for ${sector.label}`);
    const basis = `${sector.label[0].toUpperCase()}${sector.label.slice(1)} exposure: ${basisParts.join('; ')}.`;
    const ids = sector.assets ?? CATALOG.filter((entry) => entry.sectors.includes(sector.id)).map((entry) => entry.id);
    for (const id of ids) {
      const entry = catalogById.get(id);
      if (!entry) continue;
      put(entry, {
        ruleId: `sector:${sector.id}`, relevance,
        explanation: { ruleId: `sector:${sector.id}`, relevance, basis, pathway: sector.pathway, alternatives: ['Other participants in the same sector may be affected differently; this asset may have little direct exposure.', ...COMMON_ALTERNATIVES] },
      });
    }
  }

  // 3. Market context for the most severe events only.
  if (input.severity === 'Critical') {
    const sp = catalogById.get('index:SP500');
    if (sp) put(sp, {
      ruleId: 'broad-market', relevance: 'Broad market',
      explanation: { ruleId: 'broad-market', relevance: 'Broad market', basis: 'The event is rated Critical. The S&P 500 is shown only as general market context, not as a specific exposure.', pathway: 'Very severe events can change overall risk appetite, which broad indices reflect.', alternatives: COMMON_ALTERNATIVES },
    });
  }

  return [...out.values()].sort((a, b) => RANK[a.relevance] - RANK[b.relevance]).slice(0, max);
}

export const CAUSATION_NOTE = 'A price change that follows a report is an observation, not evidence that the report caused it. Many things move prices at the same time.';

export function whyMatters(args: {
  explanation: LinkExplanation | null; origin: 'suggested' | 'user'; severity: string; source: string; memberCount: number;
  category: string; countries: string[]; anchorAt: string; sessionNote: string;
}): WhyMatters {
  const supporting: string[] = [];
  if (args.explanation) supporting.push(args.explanation.basis);
  else supporting.push('You added this link yourself; the app has no rule-based evidence for it.');
  supporting.push(`Event category "${args.category}"${args.countries.length > 0 ? ` in ${args.countries.join(', ')}` : ''}, severity rated ${args.severity} (severity describes the event, not market impact).`);
  supporting.push(`Earliest public report: ${args.source} at ${args.anchorAt}${args.memberCount > 1 ? `, with ${args.memberCount - 1} further de-duplicated report(s)` : ''}.`);
  return {
    supporting,
    pathway: args.explanation?.pathway ?? 'No exposure pathway is recorded for a manually added link. Add your own reasoning to your notes.',
    alternatives: args.explanation?.alternatives ?? COMMON_ALTERNATIVES,
    caution: `${CAUSATION_NOTE} ${args.sessionNote}`,
  };
}
