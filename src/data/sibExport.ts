import type { SibEvidence, SibRecord } from './sibTypes';

/**
 * One document model feeds the on-screen preview and every export, so they cannot drift apart.
 * Empty optional sections are left out; nothing is invented to fill them.
 */
export type SibBlock =
  | { kind: 'text'; heading: string; text: string }
  | { kind: 'list'; heading: string; items: string[]; ordered?: boolean }
  | { kind: 'sources'; heading: string; items: SibEvidence[] };

export type SibDocument = {
  banner: string;
  draftNotice: string | null;
  title: string;
  meta: Array<[string, string]>;
  blocks: SibBlock[];
  footer: string;
};

function day(iso: string | null | undefined) {
  if (!iso) return 'date not recorded';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'date not recorded' : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function stamp(iso: string | null | undefined) {
  if (!iso) return 'not recorded';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'not recorded' : `${date.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC`;
}

export function sibDocument(sib: SibRecord, generatedAt: string): SibDocument {
  const approved = sib.status === 'Approved';
  const blocks: SibBlock[] = [];
  const add = (heading: string, text: string) => { if (text.trim()) blocks.push({ kind: 'text', heading, text: text.trim() }); };
  add('Executive summary', sib.summary);
  add('Current situation', sib.situation);
  add('Impact on employees', sib.employeeImpact);
  add('Impact on operations', sib.operationsImpact);
  if (sib.assets.some((asset) => asset.trim())) blocks.push({ kind: 'list', heading: 'Affected assets and locations', items: sib.assets.filter((asset) => asset.trim()) });
  if (sib.actions.some((action) => action.trim())) blocks.push({ kind: 'list', heading: 'Recommended actions', items: sib.actions.filter((action) => action.trim()), ordered: true });
  if (sib.evidence.length > 0) blocks.push({ kind: 'sources', heading: 'Sources', items: sib.evidence });
  return {
    banner: sib.classification.toUpperCase(),
    draftNotice: approved ? null : 'DRAFT: not approved for distribution',
    title: sib.title || 'Untitled bulletin',
    meta: [
      ['Reference', sib.id],
      ['Severity', sib.severity],
      ['Location', sib.location || 'not stated'],
      ['Based on', sib.source.label],
      ['Status', approved ? `Approved by ${sib.approvedBy ?? 'unrecorded approver'} on ${stamp(sib.approvedAt)} (revision ${sib.revision})` : 'Draft'],
    ],
    blocks,
    footer: `Prepared with Global Security Intelligence. Content as of ${stamp(generatedAt)}. Source reports are third-party publications; the assessment is the analyst's. Verify with the linked sources before acting.`,
  };
}

export function sibToText(doc: SibDocument): string {
  const lines: string[] = [doc.banner];
  if (doc.draftNotice) lines.push(doc.draftNotice);
  lines.push('', doc.title, '');
  for (const [label, value] of doc.meta) lines.push(`${label}: ${value}`);
  for (const block of doc.blocks) {
    lines.push('', block.heading.toUpperCase());
    if (block.kind === 'text') lines.push(block.text);
    else if (block.kind === 'list') block.items.forEach((item, index) => lines.push(block.ordered ? `${index + 1}. ${item}` : `- ${item}`));
    else block.items.forEach((item) => lines.push(`- ${item.headline} (${item.source ?? 'source not recorded'}, ${day(item.publishedAt)})${item.url ? ` ${item.url}` : ''}`));
  }
  lines.push('', doc.footer);
  return lines.join('\n');
}

export function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const safeUrl = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : null);
const paragraphs = (text: string) => text.split(/\n{2,}/).map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('');

const STYLE = `
  body{font-family:Arial,Helvetica,sans-serif;color:#111;max-width:760px;margin:24px auto;padding:0 20px;line-height:1.5;font-size:14px}
  .banner{background:#111;color:#fff;text-align:center;font-weight:700;letter-spacing:.12em;padding:6px;font-size:12px}
  .draft{border:2px solid #b91c1c;color:#b91c1c;text-align:center;font-weight:700;padding:6px;margin-top:10px}
  h1{font-size:24px;margin:18px 0 8px}
  h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid #ccc;padding-bottom:3px;margin:22px 0 8px}
  table.meta{border-collapse:collapse;width:100%;font-size:13px}
  table.meta td{padding:3px 8px 3px 0;vertical-align:top} table.meta td:first-child{color:#555;width:110px}
  ul,ol{padding-left:22px;margin:6px 0} li{margin:3px 0} p{margin:6px 0}
  .src small{color:#555} .footer{margin-top:28px;border-top:1px solid #ccc;padding-top:8px;font-size:11px;color:#555}
  a{color:#1d4ed8;word-break:break-all}
  @media print{body{margin:0;max-width:none}}
`;

/** Full HTML page. All text is escaped; only http(s) links are made clickable. */
export function sibToHtml(doc: SibDocument, options: { word?: boolean } = {}): string {
  const body: string[] = [`<div class="banner">${escapeHtml(doc.banner)}</div>`];
  if (doc.draftNotice) body.push(`<div class="draft">${escapeHtml(doc.draftNotice)}</div>`);
  body.push(`<h1>${escapeHtml(doc.title)}</h1>`);
  body.push(`<table class="meta">${doc.meta.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}</table>`);
  for (const block of doc.blocks) {
    body.push(`<h2>${escapeHtml(block.heading)}</h2>`);
    if (block.kind === 'text') body.push(paragraphs(block.text));
    else if (block.kind === 'list') body.push(`<${block.ordered ? 'ol' : 'ul'}>${block.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${block.ordered ? 'ol' : 'ul'}>`);
    else {
      body.push(`<ul class="src">${block.items.map((item) => {
        const link = safeUrl(item.url);
        const title = link ? `<a href="${escapeHtml(link)}">${escapeHtml(item.headline)}</a>` : escapeHtml(item.headline);
        return `<li>${title}<br><small>${escapeHtml(item.source ?? 'source not recorded')} · ${escapeHtml(day(item.publishedAt))}</small></li>`;
      }).join('')}</ul>`);
    }
  }
  body.push(`<div class="footer">${escapeHtml(doc.footer)}</div>`);
  const head = options.word
    ? '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">'
    : '<!doctype html><html lang="en">';
  return `${head}<head><meta charset="utf-8"><title>${escapeHtml(doc.title)}</title><style>${STYLE}</style></head><body>${body.join('')}</body></html>`;
}

export function sibFilename(sib: Pick<SibRecord, 'id' | 'title'>, extension: string) {
  const slug = sib.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return `${sib.id}${slug ? `-${slug}` : ''}.${extension}`;
}

/** mailto: links have practical length limits, so the body is cut and says so. */
export function sibMailto(doc: SibDocument, maxBody = 1800) {
  let body = sibToText(doc);
  if (body.length > maxBody) body = `${body.slice(0, maxBody)}\n\n[Shortened for email. Use the PDF or HTML export for the full bulletin.]`;
  return `mailto:?subject=${encodeURIComponent(`${doc.banner}: ${doc.title}`)}&body=${encodeURIComponent(body)}`;
}
