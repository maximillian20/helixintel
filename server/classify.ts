import {
  GLOBAL_CODE,
  UNKNOWN_CODE,
  findCountryCodes,
  hasGlobalScope,
} from '../src/data/countries';
import type { ConfidenceLevel, CountryStatus, Severity } from '../src/data/feedTypes';

/** Bump when the rules change; stored assessments with another version are recomputed automatically. */
export const CLASSIFIER_VERSION = 'rules-1';

type Rule = {
  id: string;
  label: string;
  /** 1 = context only, 2 = significant, 3 = serious violence or disaster, 4 = catastrophic. */
  impact: 1 | 2 | 3 | 4;
  pattern: RegExp;
  /** Ignored when the text is clearly about sport or entertainment (e.g. "attack" in football). */
  ambiguous?: boolean;
};

const rules: Rule[] = [
  // Impact 4: catastrophic
  { id: 'atrocity', label: 'mass-atrocity language', impact: 4, pattern: /\b(genocide|massacres?|mass graves?|ethnic cleansing)\b/i },
  {
    id: 'wmd',
    label: 'nuclear, chemical or biological incident',
    impact: 4,
    pattern: /\b(?:nuclear|chemical|biological|radiological)\s+(?:attack|strike|incident|leak|accident|disaster|meltdown|weapons?\s+(?:used|attack))\b|\bdirty bomb\b|\bnuclear (?:power )?(?:plant|station|facility|site|reactor)s?\b[^.]*\b(?:attack(?:ed)?|strike|struck|shell(?:ing|ed)|drone|fire|hit|explosion)\b|\b(?:attack(?:ed)?|strikes?|struck|shell(?:ing|ed)|drone|fire|hits?|explosion)\b[^.]*\bnuclear (?:power )?(?:plant|station|facility|site|reactor)s?\b/i,
  },
  { id: 'war-declaration', label: 'declaration of war or full-scale invasion', impact: 4, pattern: /\b(declares? war|declared war|declaration of war|full-scale (?:invasion|war))\b/i },
  { id: 'power-seizure', label: 'seizure of power', impact: 4, pattern: /\b(?:seiz(?:es|ed|e)|takes?|took) power\b|\bcoup (?:succeeds|succeeded)\b/i },
  { id: 'famine-declared', label: 'famine declared', impact: 4, pattern: /\bfamine\b[^.]*\b(?:declared|confirmed)\b|\b(?:declared|confirms?) famine\b/i },

  // Impact 3: serious violence or disaster
  {
    id: 'armed-attack',
    label: 'armed attack or strike',
    impact: 3,
    pattern: /\b(?:air ?strikes?|missile (?:strike|attack|barrage)s?|drone (?:strike|attack)s?|rocket (?:attack|fire|barrage)s?|shell(?:ing|ed)|bomb(?:ing|ings|ed)|car bombs?|suicide (?:bomb|attack)\w*|explosions?|gunmen|gunman|gunfire|shot dead|stabbing|terror(?:ist)? attacks?|ambush(?:ed)?|assassinat\w+|deadly (?:attack|strike)s?)\b/i,
  },
  {
    id: 'armed-attack',
    label: 'armed attack or strike',
    impact: 3,
    ambiguous: true,
    pattern: /\bstrikes? (?:on|against|kills?|killed|hits?|targeting|targets)\b|(?<!heart |panic |asthma |anxiety |cyber )\battack(?:s|ed|ers?)?\b/i,
  },
  { id: 'hostage-taking', label: 'hostage-taking or abduction', impact: 3, pattern: /\b(hostages?|kidnap\w*|abduct\w*)\b/i },
  { id: 'coup', label: 'coup or military takeover', impact: 3, pattern: /\b(?:coup|military takeover)\b/i },
  {
    id: 'armed-clashes',
    label: 'armed clashes or siege',
    impact: 3,
    ambiguous: true,
    pattern: /\b(?:deadly|fierce|armed|violent|heavy)\s+(?:clashes|fighting)\b|\bclashes?\b[^.]*\b(?:killed|dead|injured|wounded)\b|\b(?:fighting|battles?)\s+(?:in|near|around|erupts|rages|continues)\b|\b(?:siege|besieged)\b|\b(?:military|ground|new|major|launch\w*)\s+offensive\b/i,
  },
  { id: 'famine', label: 'famine or starvation', impact: 3, pattern: /\b(?:famine|starvation)\b/i },
  { id: 'mass-displacement', label: 'mass displacement', impact: 3, pattern: /\b(?:hundreds of thousands|millions)\s+(?:of people\s+)?(?:displaced|flee|fled|fleeing|homeless)\b|\bmass (?:displacement|exodus)\b/i },

  // Impact 2: significant
  {
    id: 'natural-hazard',
    label: 'natural hazard',
    impact: 2,
    pattern: /\b(earthquakes?|tsunamis?|hurricanes?|typhoons?|cyclones?|tornado(?:es)?|floods?|flooding|wildfires?|bushfires?|landslides?|mudslides?|volcan\w+|eruption|heatwave|drought|avalanche)\b/i,
  },
  { id: 'hunger', label: 'food insecurity or hunger crisis', impact: 2, pattern: /\b(?:hunger crisis|acute hunger|food insecurity|food shortages?|malnutrition|malnourished|hunger worsens|facing hunger)\b/i },
  { id: 'health-emergency', label: 'health emergency', impact: 2, pattern: /\b(outbreaks?|epidemics?|cholera|ebola|marburg|mpox|bird flu|h5n1|polio|public health emergency)\b|\b(?:declares?|declared|new)\s+(?:a\s+)?pandemic\b/i },
  {
    id: 'unrest',
    label: 'civil unrest',
    impact: 2,
    pattern: /\b(riots?|rioters?|unrest|looting|tear gas|water cannon|crackdown|curfew|martial law|state of emergency|violent protests?|clashes with police)\b|\b(?:protesters?|demonstrators?)\s+(?:clash\w*|killed|injured|shot|arrested|detained)\b|\b(?:protesters?|demonstrators?)\s+clash\w*\s+with\s+police\b/i,
  },
  { id: 'evacuation', label: 'evacuation, displacement or humanitarian crisis', impact: 2, pattern: /\b(evacuat\w+|displaced|fleeing|forced to flee|humanitarian (?:crisis|catastrophe|emergency)|refugee crisis|blockade)\b/i },
  {
    id: 'escalation',
    label: 'escalation or military threat',
    impact: 2,
    pattern: /\b(retaliat\w+|escalat\w+|ultimatum|mobili[sz]\w+|military buildup|missile tests?|test-?fires?)\b|\bthreaten(?:s|ed|ing)?\s+(?:to\s+)?(?:attack|strike|invade|war|retaliat\w+)\b|\bwarns?\s+of\s+(?:attack|war|escalation|retaliation|strikes)\b|\b(?:ceasefire|truce)\s+(?:collapse\w*|broken|violat\w+|ends)\b/i,
  },
  {
    id: 'repression',
    label: 'repression or rights abuses',
    impact: 2,
    pattern: /\b(tortur\w+|executions?|executed|death sentence|(?:forced|enforced) disappearances?|persecut\w+|internet shutdown|sexual violence|war crimes?|crimes against humanity|rights groups?)\b|\b(?:journalists?|opposition|activists?|protesters?|dissidents?|critics?)\s+(?:were\s+|was\s+|been\s+)?(?:arrested|detained|jailed|sentenced)\b|\bjail\w*\s+(?:\w+\s+)?(?:journalists?|activists?|dissidents?)\b/i,
  },
  { id: 'cyber', label: 'cyber incident', impact: 2, pattern: /\b(cyber-?attacks?|ransomware|data breach|hackers?|hacked)\b/i },
  { id: 'extremism', label: 'extremist or armed-group activity', impact: 2, pattern: /\b(terror\w*|extremis\w+|jihadist\w*|insurgen\w+|militants?|armed groups?|rebels?|paramilitar\w+)\b/i },

  // Impact 1: context only
  {
    id: 'conflict-context',
    label: 'conflict context',
    impact: 1,
    pattern: /\b(war|conflict|invasion|invaded|occupation|ceasefire|truce|frontline|front line|troops|soldiers|military|army|armed forces|weapons|arms (?:deal|sales|shipments?|supplies)|missiles?|nato)\b/i,
  },
  {
    id: 'diplomacy',
    label: 'diplomatic or sanctions development',
    impact: 1,
    pattern: /\b(sanctions?|embargo|(?:peace|ceasefire|truce|nuclear|security|border|prisoner|hostage)\s+(?:talks|negotiations|deal|agreement|plan)|expel\w*\s+(?:diplomats?|ambassador)|ambassador\s+(?:summoned|recalled|expelled)|diplomatic\s+(?:row|crisis|tensions?|dispute)|border\s+(?:dispute|tensions?)|tensions?\s+(?:rise|rises|mount|mounts|escalate\w*|grow\w*|flare\w*))\b/i,
  },
  {
    id: 'political',
    label: 'political instability',
    impact: 1,
    pattern: /\bnew (?:president|prime minister|leader)\b|\b(?:calls? for|demands?)\b[^.]*\b(?:resign|step down)\b|\b(?:snap election|no-confidence|impeach\w*|ousted|government collapses?|disputed election|election (?:fraud|violence|dispute))\b/i,
  },
  { id: 'protest', label: 'protest activity', impact: 1, pattern: /\b(protests?|protesters?|demonstrat\w+)\b/i },
  { id: 'migration', label: 'migration or asylum', impact: 1, pattern: /\b(migrants?|asylum|refugees?)\b/i },
];

const ruleImpacts = new Map(rules.map((rule) => [rule.id, rule.impact]));
const ruleLabels = new Map(rules.map((rule) => [rule.id, rule.label]));
export function ruleImpact(ruleId: string) {
  return ruleImpacts.get(ruleId) ?? 0;
}
export function ruleLabel(ruleId: string) {
  return ruleLabels.get(ruleId) ?? ruleId;
}

const sportOrEntertainment = /\b(football|soccer|cricket|rugby|tennis|golf|premier league|champions league|world cup|olympics?|paralympics?|nba|nfl|formula 1|grand prix|striker|midfielder|goalkeeper|quarterback|cup final|tournament|box office|film|movie|trailer|album|singer|actor|actress|celebrity|netflix|tv series|fashion|recipe|concert)\b/i;
const negation = /\b(no (?:one |people )?(?:was |were )?(?:injured|hurt|killed)|no casualties|no injuries|foil(?:s|ed|ing)?|thwart(?:s|ed|ing)?|averted|failed attack|drill|simulated)\b/i;
const hedging = /\b(unconfirmed|unverified|alleged(?:ly)?|reportedly|claims?|claimed|rumou?rs?|purported)\b/i;
const urgency = /\b(breaking|live|developing|ongoing|continues|continued|rises|mounting|surges?|escalat\w+|imminent|urgent|emergency|evacuat\w+|fleeing|trapped|rescue\w*|search for survivors|on alert|overnight|renewed|fresh|intensif\w+|hours after)\b/i;
const infrastructure = /\b(capital|airport|power (?:plant|station|grid|outage)|nationwide|countrywide|across the country|parliament|government (?:building|headquarters)|presidential palace|embassy|consulate|hospital|refugee camp|border crossing|pipeline|refinery)\b|\b(?:thousands|hundreds of thousands|millions)\b/i;
const wideScope = /\b(worldwide|global|across the (?:region|world|continent)|region-wide|regional (?:war|conflict|escalation)|several countries|multiple countries|neighbouring countries|middle east)\b/i;

const numberWords = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|dozens?|scores|hundreds|thousands|several|many';
const NUM = `(\\d[\\d,]*|${numberWords})`;
const wordValues: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  dozen: 24, dozens: 24, scores: 40, hundreds: 200, thousands: 2000, several: 3, many: 5,
};

function parseCount(token: string) {
  const value = token.toLowerCase();
  if (/^\d/.test(value)) return Number(value.replace(/,/g, ''));
  return wordValues[value] ?? 0;
}

const deathPatterns = [
  new RegExp(`\\b${NUM}\\b(?:\\s+(?:more|other|further|additional))?\\s+(?:[a-z-]+\\s+){0,2}?(?:dead|killed|died|deaths|fatalities)\\b`, 'gi'),
  new RegExp(`death toll(?:\\s+[a-z]+){0,3}?\\s+${NUM}\\b`, 'gi'),
  new RegExp(`\\bkill(?:s|ed|ing)?\\s+(?:at least\\s+|more than\\s+|over\\s+|nearly\\s+|about\\s+)?${NUM}\\b`, 'gi'),
];
const injuredPatterns = [
  new RegExp(`\\b${NUM}\\b\\s+(?:[a-z-]+\\s+){0,2}?(?:injured|wounded|hurt)\\b`, 'gi'),
  new RegExp(`\\b(?:injur(?:es|ed|ing)|wound(?:s|ed|ing))\\s+${NUM}\\b`, 'gi'),
];
const generalDeath = /\b(kills?|killed|killing|dead|died|deaths?|fatalities|slain|shot dead)\b/i;
const generalInjury = /\b(injured|wounded|injuries)\b/i;

function largestCount(text: string, patterns: RegExp[]) {
  let best = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const count = parseCount(match[1] ?? '');
      if (count > best && count < 10_000_000) best = count;
    }
  }
  return best;
}

export type Assessment = {
  severity: Severity;
  impact: number;
  scope: number;
  urgency: number;
  /** Rule ids that matched, e.g. "armed-attack". */
  categories: string[];
  categoryLabels: string[];
  /** Number of matched indicators with impact 2 or higher. */
  strongCount: number;
  deaths: number | null;
  deathsStated: boolean;
  injured: number | null;
  hedged: boolean;
  negated: boolean;
  rationale: string;
  countryCodes: string[];
  countryStatus: CountryStatus;
  version: string;
};

function casualtyImpact(deaths: number, injured: number) {
  if (deaths >= 100) return 4;
  if (deaths >= 10) return 3;
  if (deaths >= 1) return 2;
  if (injured >= 1) return 2;
  return 0;
}

function severityFor(impact: number, points: number): Severity {
  if (impact <= 0) return 'Unassessed';
  if (impact >= 4) return 'Critical';
  if (impact === 3) return points >= 6 ? 'Critical' : 'High';
  if (impact === 2) return points >= 4 ? 'High' : 'Moderate';
  return points >= 3 ? 'Moderate' : 'Watch';
}

function capitalise(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function assessItem(input: { headline: string; summary: string }): Assessment {
  const headline = input.headline.trim();
  const summary = input.summary.trim();
  const text = `${headline}. ${summary}`;
  const sport = sportOrEntertainment.test(text);

  // "No injuries reported" / "no deaths" must not be counted as casualties.
  const countable = text.replace(/\bno (?:\w+ ){0,2}?(?:injur\w*|deaths?|fatalit\w*|casualt\w*|one (?:was )?(?:injured|killed))\b/gi, ' ');
  let deaths = largestCount(countable, deathPatterns);
  const deathsStated = deaths > 0;
  // In sport or entertainment stories, violent wording is usually figurative. Only an explicit death toll keeps indicators.
  const matchedRules = rules.filter((rule) => !(rule.ambiguous && sport) && rule.pattern.test(text));
  const matched = [...new Map((sport && !deathsStated ? [] : matchedRules).map((rule) => [rule.id, rule])).values()];
  const ruleMax = matched.reduce((max, rule) => Math.max(max, rule.impact), 0);

  if (!deathsStated && generalDeath.test(countable)) deaths = 1;
  let injured = largestCount(countable, injuredPatterns);
  if (injured === 0 && generalInjury.test(countable)) injured = 1;

  // Casualty figures only count when the story also matches a conflict, hazard or unrest indicator,
  // so unrelated reports ("man found dead at home") are not treated as security events.
  let impact = matched.length > 0 ? Math.max(ruleMax, casualtyImpact(deaths, injured)) : 0;
  // Strong earthquakes and tsunami warnings are more serious than the generic natural-hazard level.
  const magnitude = Number(/\bmagnitude[\s-]*(\d+(?:\.\d+)?)/i.exec(text)?.[1] ?? 0);
  if (matched.some((rule) => rule.id === 'natural-hazard') && (magnitude >= 7 || /\btsunami warning\b/i.test(text))) impact = Math.max(impact, 3);
  const negated = negation.test(text);
  if (negated && impact >= 2) impact = Math.max(1, impact - 1);

  const headlineCodes = findCountryCodes(headline);
  const allCodes = [...new Set([...headlineCodes, ...findCountryCodes(summary)])];

  let scope = 0;
  if (impact >= 2) {
    if (wideScope.test(text) || headlineCodes.length >= 3) scope = 2;
    else if (infrastructure.test(text) || allCodes.length >= 2) scope = 1;
  }
  const urgent = impact >= 1 && urgency.test(text) ? 1 : 0;

  const severity = severityFor(impact, impact + scope + urgent);
  const strong = matched.filter((rule) => rule.impact >= 2);

  const countryCodes = [...allCodes];
  if (hasGlobalScope(text)) countryCodes.push(GLOBAL_CODE);
  if (countryCodes.length === 0) countryCodes.push(UNKNOWN_CODE);
  const countryStatus: CountryStatus = allCodes.length > 0
    ? 'identified'
    : countryCodes.includes(GLOBAL_CODE) ? 'global' : 'unknown';

  const topRule = [...matched].sort((a, b) => b.impact - a.impact)[0];
  const scopeLabel = ['local or unspecified', 'national infrastructure or more than one country', 'regional or global'][scope];
  const casualtyText = deaths > 0
    ? `${deathsStated ? `${deaths >= 1000 ? 'about ' : ''}${deaths} reported dead` : 'deaths reported'}`
    : injured > 0 ? 'injuries reported' : '';

  let rationale: string;
  if (severity === 'Unassessed') {
    rationale = 'No conflict, violence, disaster, unrest or human-rights indicators were found in the headline or summary, so no severity is assigned.';
  } else {
    const parts = [
      `${topRule ? capitalise(topRule.label) : 'Security-relevant report'} (impact ${impact}/4)`,
      casualtyText,
      `scope: ${scopeLabel}`,
      urgent ? 'urgency: ongoing or time-critical wording' : 'urgency: no time-critical wording',
    ].filter(Boolean);
    rationale = `${parts.join('; ')}.${negated ? ' Reported as foiled or without casualties, so impact was reduced one level.' : ''} Assessed from the headline and summary only.`;
  }

  return {
    severity,
    impact,
    scope,
    urgency: urgent,
    categories: matched.map((rule) => rule.id),
    categoryLabels: matched.map((rule) => rule.label),
    strongCount: strong.length,
    deaths: deaths > 0 ? deaths : null,
    deathsStated,
    injured: injured > 0 ? injured : null,
    hedged: hedging.test(text),
    negated,
    rationale,
    countryCodes,
    countryStatus,
    version: CLASSIFIER_VERSION,
  };
}

export function assessmentConfidence(input: {
  severity: Severity;
  strongCount: number;
  figuresStated: boolean;
  corroboratingReports: number;
  hedged: boolean;
  officialHumanitarianSource: boolean;
}): ConfidenceLevel {
  if (input.severity === 'Unassessed') return 'Not assessed';
  if (input.hedged) return 'Low';
  let score = input.strongCount >= 1 ? 1 : 0;
  if (input.figuresStated) score += 1;
  if (input.corroboratingReports >= 1) score += 1;
  if (input.officialHumanitarianSource) score += 1;
  if (score >= 2) return 'High';
  if (score === 1) return 'Medium';
  return 'Low';
}
