export type Severity = 'Critical' | 'High' | 'Moderate' | 'Watch' | 'Monitoring';

export type Metric = {
  label: string;
  value: string;
  change: string;
  tone: 'critical' | 'warning' | 'positive' | 'neutral';
};

export const dashboardMetrics: Metric[] = [
  { label: 'Critical incidents in last 24h', value: '18', change: '+6 vs yesterday', tone: 'critical' },
  { label: 'High-severity incidents in last 7d', value: '64', change: '+11 this week', tone: 'warning' },
  { label: 'Countries with deteriorating risk', value: '12', change: '3 new entries', tone: 'warning' },
  { label: 'Active threat indicators', value: '41', change: '7 worsening', tone: 'neutral' },
  { label: 'Open SIBs', value: '9', change: '2 require sign-off', tone: 'neutral' },
  { label: 'Human-rights alerts', value: '14', change: '+4 from last update', tone: 'warning' },
  { label: 'Countries on watchlist', value: '27', change: '9 in elevated risk', tone: 'warning' },
  { label: 'Sources currently unavailable', value: '3', change: '2 under review', tone: 'neutral' },
];

export const trendData = [
  { date: 'Jan', volume: 58, severity: 36, political: 42, rights: 28 },
  { date: 'Feb', volume: 62, severity: 41, political: 46, rights: 30 },
  { date: 'Mar', volume: 71, severity: 53, political: 57, rights: 32 },
  { date: 'Apr', volume: 76, severity: 55, political: 60, rights: 34 },
  { date: 'May', volume: 81, severity: 64, political: 59, rights: 38 },
  { date: 'Jun', volume: 88, severity: 69, political: 63, rights: 43 },
  { date: 'Jul', volume: 94, severity: 74, political: 67, rights: 47 },
];

export const priorityIntelligence = [
  {
    title: 'Red Sea maritime disruption escalates',
    summary: 'Shipping lanes face continued disruption as naval escorts and drone incidents increase in the Bab el-Mandeb corridor.',
    severity: 'Critical',
    reliability: 'A',
    location: 'Red Sea / Gulf of Aden',
    sources: 4,
  },
  {
    title: 'Iran-linked security posture tightens around Gulf facilities',
    summary: 'Reported military mobilisations and rapid security deployments coincide with heightened political rhetoric and inspections of critical infrastructure.',
    severity: 'High',
    reliability: 'B',
    location: 'Persian Gulf / UAE / Oman',
    sources: 3,
  },
  {
    title: 'Ukraine grid and logistics disruption persists',
    summary: 'Civilian infrastructure remains under pressure following repeated strikes and service interruptions affecting transport and utilities.',
    severity: 'High',
    reliability: 'A',
    location: 'Ukraine / South East Europe',
    sources: 5,
  },
  {
    title: 'Election-related unrest remains elevated in several West African states',
    summary: 'Security teams reported protest patterns and police mobilisations in areas tied to delayed results and contested local governance outcomes.',
    severity: 'Moderate',
    reliability: 'B',
    location: 'West Africa',
    sources: 2,
  },
];

export const intelligenceFeed = [
  {
    headline: 'Iran warns of regional escalation after drone and missile activity near Gulf shipping lanes',
    summary: 'Official statements and public reporting refer to increased aerial activity and heightened border security measures in the Persian Gulf region.',
    source: 'Reuters',
    sourceType: 'Newswire',
    date: '2026-10-06T18:20:00Z',
    location: 'Strait of Hormuz',
    country: 'Iran',
    region: 'Middle East',
    type: 'Military activity',
    severity: 'High',
    reliability: 'B',
    confidence: 'Medium',
    entities: 'IRGC, naval units, commercial shipping',
    relevance: 'High',
    watchlist: true,
    reviewStatus: 'Reviewed',
    url: 'https://example.com/source/iran-drone-gulf',
  },
  {
    headline: 'Power outage impacts southern Iraq industrial zones',
    summary: 'Regional transmission disruption affected several industrial and logistics facilities, with local officials reporting restoration work under way.',
    source: 'Ministry of Electricity',
    sourceType: 'Government advisory',
    date: '2026-10-05T13:00:00Z',
    location: 'Basra',
    country: 'Iraq',
    region: 'Middle East',
    type: 'Infrastructure disruption',
    severity: 'Moderate',
    reliability: 'A',
    confidence: 'High',
    entities: 'Basra transmission network, local power authorities',
    relevance: 'High',
    watchlist: true,
    reviewStatus: 'Needs review',
    url: 'https://example.com/source/iraq-power',
  },
  {
    headline: 'Human-rights organisations report detention of journalists in border province',
    summary: 'NGO and media reporting indicates increased detentions tied to coverage of protest activity and cross-border security operations.',
    source: 'Human Rights Watch',
    sourceType: 'NGO report',
    date: '2026-10-04T08:45:00Z',
    location: 'Syria',
    country: 'Syria',
    region: 'Middle East',
    type: 'Human-rights violation',
    severity: 'High',
    reliability: 'B',
    confidence: 'Medium',
    entities: 'Journalists, local authorities',
    relevance: 'Medium',
    watchlist: false,
    reviewStatus: 'Pending',
    url: 'https://example.com/source/hrw-syria-journalists',
  },
];

export const countryAssessments = [
  {
    country: 'Iran',
    risk: 'Severe',
    trend: 'Deteriorating',
    confidence: 'High',
    summary: 'Security and political risk remain elevated amid cross-border pressure and ongoing strategic messaging.',
  },
  {
    country: 'Israel',
    risk: 'High',
    trend: 'Watch',
    confidence: 'High',
    summary: 'Regional escalation risk remains significant, especially in maritime and air defence contexts.',
  },
  {
    country: 'Lebanon',
    risk: 'High',
    trend: 'Deteriorating',
    confidence: 'Medium',
    summary: 'Security environment remains fragile due to cross-border incidents and economic pressure.',
  },
  {
    country: 'Yemen',
    risk: 'Severe',
    trend: 'Watch',
    confidence: 'Medium',
    summary: 'Humanitarian and infrastructure risk continue to shape operational constraints and supply-chain exposure.',
  },
];

export const incidentDetails = [
  {
    id: 'INC-2048',
    title: 'Maritime security incident near Bab el-Mandeb',
    severity: 'Critical',
    status: 'Monitoring',
    date: '2026-10-06T18:30:00Z',
    location: 'Bab el-Mandeb',
    country: 'Yemen',
    region: 'Red Sea',
    coordinates: '12.7 N, 43.1 E',
    type: 'Maritime security',
    description: 'Commercial shipping activity in the Red Sea corridor was disrupted after reports of weapons fire and heightened escort activity.',
    trigger: 'Reported drone and missile activity linked to maritime transit and security force response.',
    actors: 'Commercial vessels, armed escorts, state and non-state security actors',
    operationalImpact: 'Rerouting, delay risk, insurance exposure and elevated transit cost assumptions.',
    businessImpact: 'Supply-chain volatility affecting regional logistics and energy shipments.',
    rightsImpact: 'Limited direct evidence of civilian harm; monitoring remains active.',
    recommendedActions: [
      'Review route plans and port contingency arrangements.',
      'Increase personnel and travel security awareness for Red Sea transit.',
      'Monitor naval and commercial escort advisories for 72-hour escalation windows.'
    ],
    timeline: [
      { label: 'Initial report', value: '06 Oct 2026 / 17:10 UTC', detail: 'Vessel operators reported unusual inbound activity in the corridor.' },
      { label: 'Security response', value: '06 Oct 2026 / 18:25 UTC', detail: 'Escorts and air-defence monitoring increased in the operational area.' },
      { label: 'Current status', value: 'Ongoing', detail: 'Monitoring continues; escalation indicators remain elevated.' }
    ],
    sources: ['Reuters', 'IMO notice', 'Commercial shipping advisory'],
    confidence: 'Medium',
    reviewHistory: 'Reviewed by Operations and Security Desk at 18:45 UTC'
  },
  {
    id: 'INC-2057',
    title: 'Drone activity reported near Gulf shipping lanes',
    severity: 'High',
    status: 'Worsening',
    date: '2026-10-05T14:05:00Z',
    location: 'Strait of Hormuz',
    country: 'Iran',
    region: 'Persian Gulf',
    coordinates: '26.3 N, 56.1 E',
    type: 'Aerial activity',
    description: 'Public reporting described increased drone and missile activity near strategic shipping lanes in the Gulf of Oman corridor.',
    trigger: 'Regional security rhetoric combined with logistics and military posturing.',
    actors: 'Iranian military entities, regional air defence, commercial transit operators',
    operationalImpact: 'Heightened risk for air and maritime operations and emergency-response planning.',
    businessImpact: 'Potential disruption to petroleum, port activity and regional transport throughput.',
    rightsImpact: 'No confirmed direct civilian harm at this stage.',
    recommendedActions: [
      'Review travel and movement risk for expatriate personnel.',
      'Reassess critical asset exposure in coastal and port facilities.',
      'Prepare continuity measures for service providers and cargo operators.'
    ],
    timeline: [
      { label: 'Initial warning', value: '05 Oct 2026 / 13:40 UTC', detail: 'Regional reports flagged unusual drone movement in the corridor.' },
      { label: 'Assessment update', value: '05 Oct 2026 / 14:05 UTC', detail: 'Intensity and direction-of-travel indicators were noted to be worsening.' },
      { label: 'Current status', value: 'Escalating', detail: 'Monitoring remains active with increased analyst attention.' }
    ],
    sources: ['Reuters', 'Military observer reporting', 'Regional advisories'],
    confidence: 'Medium',
    reviewHistory: 'Escalation note added by regional analyst at 14:20 UTC'
  }
];

export const countryAssessmentDetails = [
  {
    country: 'Iran',
    risk: 'Severe',
    trend: 'Deteriorating',
    confidence: 'High',
    score: 84,
    summary: 'Security and political conditions remain elevated amid regional security pressure, maritime disruption and country-level strategic messaging.',
    sections: [
      { heading: 'Political risk', text: 'Political risk remains elevated as strategic messaging, regional posturing and internal security response measures continue to influence the operating environment.' },
      { heading: 'Security environment', text: 'Security conditions remain volatile across coastal and strategic infrastructure zones, with elevated monitoring for maritime, air and border risks.' },
      { heading: 'Business continuity', text: 'Critical infrastructure and transport routes remain vulnerable to disruption, especially where commercial operations intersect with security-sensitive facilities.' }
    ],
    indicators: ['Military mobilisation', 'Airspace and maritime alerts', 'Border restrictions', 'Infrastructure scrutiny'],
    scenarios: ['Localized escalation', 'Cross-border disruption', 'Prolonged maritime pressure']
  },
  {
    country: 'Israel',
    risk: 'High',
    trend: 'Watch',
    confidence: 'High',
    score: 76,
    summary: 'Regional tensions and defensive posture continue to influence the risk environment, particularly in maritime and air security contexts.',
    sections: [
      { heading: 'Security environment', text: 'Air defence and maritime deterrence remain active, creating elevated sensitivity around strategic transit and critical infrastructure.' },
      { heading: 'Regional spill-over', text: 'Regional dynamics continue to affect commercial and diplomatic assumptions as security posture stays elevated.' },
      { heading: 'Operational exposure', text: 'Personnel and assets linked to transport, energy and logistics remain under review for route and access risk.' }
    ],
    indicators: ['Air defence readiness', 'Maritime disruption', 'Diplomatic messaging', 'Transit risk'],
    scenarios: ['Regional escalation', 'Targeted disruption', 'Limited but sustained tension']
  }
];

export const threatIndicators = [
  {
    id: 'TI-031',
    name: 'Maritime transit advisories',
    category: 'Security posture',
    geography: 'Red Sea corridor',
    country: 'Yemen',
    status: 'Worsening',
    level: 'Elevated',
    currentValue: 8,
    baselineValue: 3,
    unit: 'advisories / 7 days',
    confidence: 'Medium',
    reliability: 'B',
    firstObserved: '2026-09-30T08:00:00Z',
    lastUpdated: '2026-10-06T18:40:00Z',
    trend: [26, 34, 31, 42, 55, 63, 78],
    rationale: 'Advisory volume is above the illustrative baseline and coincides with reported route changes and increased escort activity. The signal alone does not establish intent or confirm an incident.',
    sources: [
      { name: 'Commercial shipping advisory', type: 'Industry notice', reliability: 'B' },
      { name: 'IMO public notice channel', type: 'Public advisory', reliability: 'A' },
      { name: 'Regional news reporting', type: 'Newswire', reliability: 'B' },
    ],
    watchlisted: true,
  },
  {
    id: 'TI-027',
    name: 'Airspace restriction notices',
    category: 'Transport access',
    geography: 'Persian Gulf',
    country: 'Iran',
    status: 'Elevated',
    level: 'High',
    currentValue: 5,
    baselineValue: 2,
    unit: 'notices / 7 days',
    confidence: 'Medium',
    reliability: 'B',
    firstObserved: '2026-10-02T06:30:00Z',
    lastUpdated: '2026-10-06T16:15:00Z',
    trend: [22, 28, 37, 35, 48, 62, 66],
    rationale: 'The number of public restriction notices is above the illustrative baseline. Notices can reflect precautionary or routine activity; correlate with official aviation and carrier updates before operational decisions.',
    sources: [
      { name: 'Regional aviation notice digest', type: 'Public notice', reliability: 'B' },
      { name: 'Airline service advisories', type: 'Operator update', reliability: 'B' },
    ],
    watchlisted: true,
  },
  {
    id: 'TI-019',
    name: 'Civilian infrastructure service interruptions',
    category: 'Infrastructure',
    geography: 'Basra governorate',
    country: 'Iraq',
    status: 'Stable',
    level: 'Moderate',
    currentValue: 3,
    baselineValue: 3,
    unit: 'reported events / 7 days',
    confidence: 'High',
    reliability: 'A',
    firstObserved: '2026-09-24T11:00:00Z',
    lastUpdated: '2026-10-05T13:00:00Z',
    trend: [43, 38, 35, 40, 32, 34, 33],
    rationale: 'Recent reporting remains close to the illustrative baseline. Track restoration updates and distinguish localized service issues from wider network disruption.',
    sources: [
      { name: 'Ministry of Electricity update', type: 'Government advisory', reliability: 'A' },
      { name: 'Local utility service notice', type: 'Operator update', reliability: 'B' },
    ],
    watchlisted: false,
  },
  {
    id: 'TI-014',
    name: 'Detention reports involving media workers',
    category: 'Human rights',
    geography: 'Northern Syria',
    country: 'Syria',
    status: 'Worsening',
    level: 'High',
    currentValue: 6,
    baselineValue: 2,
    unit: 'reports / 30 days',
    confidence: 'Low',
    reliability: 'C',
    firstObserved: '2026-09-18T09:00:00Z',
    lastUpdated: '2026-10-04T08:45:00Z',
    trend: [18, 20, 26, 31, 44, 60, 72],
    rationale: 'Several public reports describe detentions involving journalists, but independent corroboration and case-level details remain limited. Treat as an early-warning signal, not a verified incident count.',
    sources: [
      { name: 'Human-rights organization report', type: 'NGO report', reliability: 'B' },
      { name: 'Regional media coverage', type: 'News reporting', reliability: 'C' },
    ],
    watchlisted: true,
  },
];

export const regionMarkers = [
  { name: 'Iran', latitude: 32.4, longitude: 53.7, tone: 'critical', detail: 'Elevated security posture and transport-access signals in the demo dataset.' },
  { name: 'Israel', latitude: 31.0, longitude: 34.9, tone: 'warning', detail: 'Regional escalation and air-defence monitoring signals in the demo dataset.' },
  { name: 'Iraq', latitude: 33.2, longitude: 43.7, tone: 'warning', detail: 'Infrastructure and service-continuity signals in the demo dataset.' },
  { name: 'Saudi Arabia', latitude: 23.9, longitude: 45.1, tone: 'neutral', detail: 'Regional watch area; no specific incident represented by this marker.' },
  { name: 'Yemen', latitude: 15.6, longitude: 48.5, tone: 'critical', detail: 'Maritime transit and humanitarian monitoring signals in the demo dataset.' },
  { name: 'Qatar', latitude: 25.4, longitude: 51.2, tone: 'warning', detail: 'Gulf transport and regional security monitoring area.' },
  { name: 'Ukraine', latitude: 48.4, longitude: 31.2, tone: 'warning', detail: 'Infrastructure resilience and transport-disruption signals in the demo dataset.' },
  { name: 'Taiwan', latitude: 23.7, longitude: 121.0, tone: 'warning', detail: 'Regional security monitoring area; no specific incident represented by this marker.' },
  { name: 'Red Sea', latitude: 20.0, longitude: 38.0, tone: 'critical', detail: 'Maritime advisories and route-disruption monitoring signals in the demo dataset.' },
];

export const analystSummary = [
  'What has changed? Regional military and maritime activity has increased alongside heightened government messaging and security deployments in the Gulf.',
  'What is most important? Security teams should prioritise maritime and critical-infrastructure exposure across the Red Sea and Strait of Hormuz corridor.',
  'What should be monitored? Airspace closures, vessel advisories, border restrictions and counterparty security posture indicators remain key early warnings.',
  'What may affect people, locations and assets? Expatriates, port and logistics nodes, energy infrastructure and key commercial facilities remain at elevated risk.',
  'What is still unknown? Independent confirmation of intent and precise impact data remain limited in several reported incidents.',
];

export const alertRules = [
  'Critical incident in monitored region',
  'Three or more independent reports of military movement within 72 hours',
  'New sanctions or diplomatic expulsion',
  'Human-rights alert affecting foreign nationals',
];

export const incidents = [
  {
    id: 'INC-2048',
    title: 'Maritime security incident near Bab el-Mandeb',
    severity: 'Critical',
    status: 'Monitoring',
    date: '2026-10-06',
    location: 'Red Sea',
  },
  {
    id: 'INC-2057',
    title: 'Drone activity reported near Gulf shipping lanes',
    severity: 'High',
    status: 'Worsening',
    date: '2026-10-05',
    location: 'Persian Gulf',
  },
  {
    id: 'INC-2061',
    title: 'Power disruption at critical Iraq industrial site',
    severity: 'Moderate',
    status: 'Stable',
    date: '2026-10-04',
    location: 'Basra',
  },
];
