import type { AssetInfo } from '../src/data/marketTypes';

/**
 * Reference data: identifiers and venue details for assets the module can follow. This is metadata, not prices.
 * Sector tags and aliases are the app's own curated mapping used only to explain suggested links.
 */
type Row = Omit<AssetInfo, 'class' | 'instrument' | 'granularities' | 'adjustment' | 'timezone' | 'calendar' | 'provider' | 'providerSymbol' | 'benchmarkId' | 'note' | 'companyKey' | 'currency'> & {
  companyKey?: string;
  aliases: string[];
  currency?: string;
  provider?: AssetInfo['provider'];
  note?: string;
  instrument?: AssetInfo['instrument'];
};

export type CatalogEntry = AssetInfo & { aliases: string[] };

const us = (symbol: string, name: string, exchange: string, mic: string, sectors: string[], aliases: string[], extra: Partial<Row> = {}): CatalogEntry => ({
  id: `stock:${symbol}:${mic}`, class: 'stock', instrument: extra.instrument ?? 'equity', symbol, name, companyKey: extra.companyKey ?? symbol.toLowerCase(),
  exchange, mic, currency: 'USD', timezone: 'America/New_York', calendar: 'XNYS', provider: 'tiingo', providerSymbol: symbol,
  adjustment: 'split-dividend adjusted', granularities: ['1d'], sectors, benchmarkId: symbol === 'SPY' ? null : 'stock:SPY:ARCX', note: extra.note ?? null, aliases,
});

const unsupported = (id: string, symbol: string, name: string, exchange: string, mic: string, currency: string, timezone: string, companyKey: string, sectors: string[], aliases: string[], note: string): CatalogEntry => ({
  id, class: 'stock', instrument: 'equity', symbol, name, companyKey, exchange, mic, currency, timezone, calendar: 'XNYS', provider: 'none', providerSymbol: symbol,
  adjustment: 'none', granularities: [], sectors, benchmarkId: null, note, aliases,
});

const index = (id: string, symbol: string, name: string, series: string, sectors: string[], aliases: string[], opts: { spot?: boolean; benchmark?: string | null } = {}): CatalogEntry => ({
  id, class: 'index', instrument: opts.spot ? 'commodity-spot' : 'equity-index', symbol, name, companyKey: null,
  exchange: opts.spot ? 'U.S. EIA daily spot price (via FRED)' : 'Index level (via FRED)', mic: null, currency: 'USD',
  timezone: opts.spot ? 'UTC' : 'America/New_York', calendar: opts.spot ? 'DAILY_SPOT' : 'XNYS', provider: 'fred', providerSymbol: series,
  adjustment: opts.spot ? 'not adjusted (spot price)' : 'index level (not adjusted)', granularities: ['1d'], sectors, benchmarkId: opts.benchmark ?? null,
  note: opts.spot ? 'Daily spot assessment; the exact time of measurement is not published, so each value is treated as known at the end of its UTC day.' : null, aliases,
});

const crypto = (base: string, name: string, aliases: string[]): CatalogEntry => ({
  id: `crypto:${base}-USD:COINBASE`, class: 'crypto', instrument: 'crypto', symbol: base, name, companyKey: null,
  exchange: 'Coinbase Exchange (BASE-USD pair)', mic: null, currency: 'USD', timezone: 'UTC', calendar: '24x7', provider: 'coinbase', providerSymbol: `${base}-USD`,
  adjustment: 'not applicable (crypto)', granularities: ['1h', '1d'], sectors: ['crypto'], benchmarkId: base === 'BTC' ? null : 'crypto:BTC-USD:COINBASE',
  note: 'Price of the Coinbase Exchange USD pair, not a global average.', aliases,
});

export const CATALOG: CatalogEntry[] = [
  us('SPY', 'SPDR S&P 500 ETF Trust', 'NYSE Arca', 'ARCX', ['broad-market'], ['spdr s&p 500', 'spy etf'], { instrument: 'etf', note: 'Used as the benchmark for US-listed stocks. It is a fund tracking the S&P 500, not the index itself.' }),
  us('XOM', 'Exxon Mobil Corporation', 'NYSE', 'XNYS', ['oil-gas'], ['exxon mobil', 'exxonmobil', 'exxon']),
  us('CVX', 'Chevron Corporation', 'NYSE', 'XNYS', ['oil-gas'], ['chevron']),
  us('COP', 'ConocoPhillips', 'NYSE', 'XNYS', ['oil-gas'], ['conocophillips']),
  us('OXY', 'Occidental Petroleum Corporation', 'NYSE', 'XNYS', ['oil-gas'], ['occidental petroleum', 'occidental']),
  us('SLB', 'SLB (Schlumberger)', 'NYSE', 'XNYS', ['oil-gas'], ['schlumberger', 'slb']),
  us('SHEL', 'Shell plc (ADR)', 'NYSE', 'XNYS', ['oil-gas'], ['shell plc', 'royal dutch shell'], { companyKey: 'shell', note: 'US-listed American Depositary Receipt in USD; it is a different listing from the London shares.' }),
  us('BP', 'BP p.l.c. (ADR)', 'NYSE', 'XNYS', ['oil-gas'], ['bp plc', 'british petroleum'], { companyKey: 'bp', note: 'US-listed American Depositary Receipt in USD.' }),
  us('TTE', 'TotalEnergies SE (ADR)', 'NYSE', 'XNYS', ['oil-gas'], ['totalenergies', 'total energies'], { companyKey: 'totalenergies', note: 'US-listed American Depositary Receipt in USD.' }),
  us('LMT', 'Lockheed Martin Corporation', 'NYSE', 'XNYS', ['defense'], ['lockheed martin', 'lockheed']),
  us('RTX', 'RTX Corporation', 'NYSE', 'XNYS', ['defense'], ['raytheon', 'rtx corp']),
  us('NOC', 'Northrop Grumman Corporation', 'NYSE', 'XNYS', ['defense'], ['northrop grumman', 'northrop']),
  us('GD', 'General Dynamics Corporation', 'NYSE', 'XNYS', ['defense'], ['general dynamics']),
  us('LHX', 'L3Harris Technologies', 'NYSE', 'XNYS', ['defense'], ['l3harris']),
  us('ZIM', 'ZIM Integrated Shipping Services', 'NYSE', 'XNYS', ['shipping'], ['zim integrated', 'zim shipping']),
  us('FDX', 'FedEx Corporation', 'NYSE', 'XNYS', ['shipping'], ['fedex']),
  us('UPS', 'United Parcel Service', 'NYSE', 'XNYS', ['shipping'], ['united parcel service']),
  us('DAL', 'Delta Air Lines', 'NYSE', 'XNYS', ['airlines'], ['delta air lines', 'delta airlines']),
  us('UAL', 'United Airlines Holdings', 'Nasdaq', 'XNAS', ['airlines'], ['united airlines']),
  us('AAL', 'American Airlines Group', 'Nasdaq', 'XNAS', ['airlines'], ['american airlines']),
  us('CRWD', 'CrowdStrike Holdings', 'Nasdaq', 'XNAS', ['cyber'], ['crowdstrike']),
  us('PANW', 'Palo Alto Networks', 'Nasdaq', 'XNAS', ['cyber'], ['palo alto networks']),
  us('FTNT', 'Fortinet', 'Nasdaq', 'XNAS', ['cyber'], ['fortinet']),
  us('ZS', 'Zscaler', 'Nasdaq', 'XNAS', ['cyber'], ['zscaler']),
  us('TSM', 'Taiwan Semiconductor Manufacturing (ADR)', 'NYSE', 'XNYS', ['semiconductors'], ['tsmc', 'taiwan semiconductor'], { companyKey: 'tsmc', note: 'US-listed American Depositary Receipt in USD; the Taiwan-listed shares are a separate listing.' }),
  us('NVDA', 'NVIDIA Corporation', 'Nasdaq', 'XNAS', ['semiconductors'], ['nvidia']),
  us('ASML', 'ASML Holding N.V. (NY registry shares)', 'Nasdaq', 'XNAS', ['semiconductors'], ['asml'], { companyKey: 'asml', note: 'New York registry shares in USD; the Euronext Amsterdam shares are a separate listing.' }),
  us('MOS', 'The Mosaic Company', 'NYSE', 'XNYS', ['agriculture'], ['mosaic company']),
  us('NTR', 'Nutrien', 'NYSE', 'XNYS', ['agriculture'], ['nutrien']),
  us('CF', 'CF Industries Holdings', 'NYSE', 'XNYS', ['agriculture'], ['cf industries']),
  us('ADM', 'Archer-Daniels-Midland', 'NYSE', 'XNYS', ['agriculture'], ['archer-daniels-midland', 'archer daniels midland']),
  us('NEM', 'Newmont Corporation', 'NYSE', 'XNYS', ['gold'], ['newmont']),
  unsupported('stock:SHEL:XLON', 'SHEL', 'Shell plc (London ordinary shares)', 'London Stock Exchange', 'XLON', 'GBP', 'Europe/London', 'shell', ['oil-gas'], ['shell plc', 'royal dutch shell'], 'No free price provider with display rights is configured for London-listed shares.'),
  unsupported('stock:2330:XTAI', '2330', 'Taiwan Semiconductor Manufacturing (Taiwan shares)', 'Taiwan Stock Exchange', 'XTAI', 'TWD', 'Asia/Taipei', 'tsmc', ['semiconductors'], ['tsmc', 'taiwan semiconductor'], 'No free price provider with display rights is configured for Taiwan-listed shares.'),
  unsupported('stock:ASML:XAMS', 'ASML', 'ASML Holding N.V. (Euronext Amsterdam)', 'Euronext Amsterdam', 'XAMS', 'EUR', 'Europe/Amsterdam', 'asml', ['semiconductors'], ['asml'], 'No free price provider with display rights is configured for Euronext-listed shares.'),
  index('index:SP500', 'SP500', 'S&P 500', 'SP500', ['broad-market'], ['s&p 500', 's&p500']),
  index('index:NASDAQCOM', 'NASDAQCOM', 'Nasdaq Composite', 'NASDAQCOM', ['broad-market'], ['nasdaq composite'], { benchmark: 'index:SP500' }),
  index('index:DJIA', 'DJIA', 'Dow Jones Industrial Average', 'DJIA', ['broad-market'], ['dow jones industrial', 'dow jones'], { benchmark: 'index:SP500' }),
  index('index:BRENT', 'BRENT', 'Crude oil, Brent (Europe spot price)', 'DCOILBRENTEU', ['oil-benchmark'], ['brent crude', 'brent oil', 'brent'], { spot: true }),
  index('index:WTI', 'WTI', 'Crude oil, WTI (Cushing spot price)', 'DCOILWTICO', ['oil-benchmark'], ['west texas intermediate', 'wti crude', 'wti'], { spot: true }),
  crypto('BTC', 'Bitcoin', ['bitcoin', 'btc']),
  crypto('ETH', 'Ethereum', ['ethereum', 'ether']),
  crypto('SOL', 'Solana', ['solana']),
  crypto('XRP', 'XRP', ['xrp']),
  crypto('ADA', 'Cardano', ['cardano']),
  crypto('DOGE', 'Dogecoin', ['dogecoin']),
  crypto('LTC', 'Litecoin', ['litecoin']),
  crypto('LINK', 'Chainlink', ['chainlink']),
];

export const catalogById = new Map(CATALOG.map((entry) => [entry.id, entry]));

export function stripAliases(entry: CatalogEntry): AssetInfo {
  const { aliases: _aliases, ...info } = entry;
  return info;
}

export function searchCatalog(query: string, assetClass?: string) {
  const q = query.trim().toLowerCase();
  return CATALOG.filter((entry) => {
    if (assetClass && entry.class !== assetClass) return false;
    if (!q) return true;
    return `${entry.symbol} ${entry.name} ${entry.exchange} ${entry.mic ?? ''} ${entry.aliases.join(' ')}`.toLowerCase().includes(q);
  });
}
