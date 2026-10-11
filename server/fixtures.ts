// Test fixtures mirroring the documented structure of each provider's response. They are used only by tests.
export const gdacsXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:geo="http://www.w3.org/2003/01/geo/wgs84_pos#" xmlns:gdacs="http://www.gdacs.org" xmlns:georss="http://www.georss.org/georss">
<channel><title>GDACS RSS information</title><pubDate>Sun, 11 Oct 2026 05:45:03 GMT</pubDate>
<item>
  <title>Orange earthquake (Magnitude 6.8M, Depth:10km) in Philippines, 10/10/2026 04:14 UTC</title>
  <description>Potentially affects 1.2 million people (MMI &gt;= VII)</description>
  <link>https://www.gdacs.org/report.aspx?eventtype=EQ&amp;eventid=1570467&amp;episodeid=1738851</link>
  <pubDate>Sat, 10 Oct 2026 04:32:21 GMT</pubDate>
  <gdacs:datemodified>Sat, 10 Oct 2026 06:20:05 GMT</gdacs:datemodified>
  <gdacs:eventtype>EQ</gdacs:eventtype><gdacs:eventid>1570467</gdacs:eventid>
  <gdacs:alertlevel>Orange</gdacs:alertlevel><gdacs:alertscore>1.4</gdacs:alertscore>
  <gdacs:severity unit="M" value="6.8">Magnitude 6.8M, Depth:10km</gdacs:severity>
  <gdacs:population unit="(in MMI&gt;=VII)" value="1200000">1.2 million people in MMI VII or higher</gdacs:population>
  <gdacs:country>Philippines</gdacs:country><gdacs:iso3>PHL</gdacs:iso3>
  <geo:Point><geo:lat>10.5</geo:lat><geo:long>125.9</geo:long></geo:Point>
</item>
<item>
  <title>Green forest fire notification in Australia</title>
  <description>Fire started 10/10/2026, until 10/10/2026</description>
  <link>https://www.gdacs.org/report.aspx?eventtype=WF&amp;eventid=1032709</link>
  <pubDate>Sun, 11 Oct 2026 03:00:37 GMT</pubDate>
  <gdacs:eventtype>WF</gdacs:eventtype><gdacs:eventid>1032709</gdacs:eventid>
  <gdacs:alertlevel>Green</gdacs:alertlevel><gdacs:alertscore>1</gdacs:alertscore>
  <gdacs:severity unit="ha" value="5961">Green impact for forestfire in 5961 ha</gdacs:severity>
  <gdacs:country>Australia</gdacs:country>
  <georss:point>-20.949 130.189</georss:point>
</item>
<item>
  <title>Red tropical cyclone with no publication date</title>
  <gdacs:eventtype>TC</gdacs:eventtype><gdacs:eventid>1</gdacs:eventid><gdacs:alertlevel>Red</gdacs:alertlevel>
</item>
</channel></rss>`;

export const kevJson = (now: Date) => JSON.stringify({
  title: 'CISA Catalog of Known Exploited Vulnerabilities', catalogVersion: 'fixture', count: 3,
  vulnerabilities: [
    { cveID: 'CVE-2026-1111', vendorProject: 'ExampleCorp', product: 'Gateway', vulnerabilityName: 'ExampleCorp Gateway Command Injection', dateAdded: new Date(now.getTime() - 2 * 86400000).toISOString().slice(0, 10), shortDescription: 'Allows remote command execution.', requiredAction: 'Apply mitigations.', dueDate: '2026-11-01', knownRansomwareCampaignUse: 'Known' },
    { cveID: 'CVE-2026-2222', vendorProject: 'Sample', product: 'Router', vulnerabilityName: 'Sample Router Auth Bypass', dateAdded: new Date(now.getTime() - 5 * 86400000).toISOString().slice(0, 10), shortDescription: 'Authentication bypass.', requiredAction: 'Update firmware.', dueDate: '2026-11-05', knownRansomwareCampaignUse: 'Unknown' },
    { cveID: 'CVE-2020-0001', vendorProject: 'Old', product: 'Thing', vulnerabilityName: 'Old vulnerability', dateAdded: '2021-11-03', shortDescription: 'Old.', requiredAction: 'Patch.', dueDate: '2021-11-17', knownRansomwareCampaignUse: 'Unknown' },
  ],
});

export const gdeltJson = JSON.stringify({
  articles: [
    { url: 'https://news.example.test/a?utm_source=x', title: 'Airstrike hits market in Sudan', seendate: '20261011T081500Z', domain: 'news.example.test', language: 'English', sourcecountry: 'Qatar' },
    { url: 'https://other.example.test/b', title: 'Airstrike hits market in Sudan', seendate: '20261011T082000Z', domain: 'other.example.test', language: 'English', sourcecountry: 'France' },
    { url: 'https://news.example.test/c', title: 'Coup attempt reported in Niger', seendate: '20261011T083000Z', domain: 'news.example.test', language: 'English', sourcecountry: 'Qatar' },
  ],
});

export const reliefWebJson = JSON.stringify({
  data: [{ id: 1, fields: { title: 'Sudan: Cholera outbreak - Situation Report No. 4', url: 'https://reliefweb.int/report/sudan/cholera-sitrep-4', body: '## Highlights\nCases are rising.', date: { original: '2026-10-09T00:00:00+00:00', created: '2026-10-10T08:00:00+00:00' }, country: [{ name: 'Sudan' }], source: [{ name: 'WHO' }], disaster_type: [{ name: 'Epidemic' }] } }],
});

export const eiaJson = JSON.stringify({
  response: { data: [
    { period: '2026-10-09', series: 'RBRTE', value: '81.25', units: '$/BBL' },
    { period: '2026-10-09', series: 'RWTC', value: '77.1', units: '$/BBL' },
  ] },
});
