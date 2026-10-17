import { randomBytes } from 'node:crypto';

/**
 * Everything retrieved from the feed, from web pages or from saved records is untrusted data. These helpers keep it from
 * being read as instructions, and keep model output from carrying anything the app did not itself supply.
 */

const ZERO_WIDTH = /[​-‏‪-‮⁠-⁤﻿]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Wording that tries to address the model rather than describe the world. Flagged for the reader, never obeyed. */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /ignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions|rules|prompts?)/i,
  /disregard (?:all |any |the )?(?:previous|prior|above|earlier|your)/i,
  /(?:reveal|print|show|repeat) (?:your|the) (?:system )?(?:prompt|instructions|rules)/i,
  /\byou are now\b/i,
  /\bnew instructions?\b/i,
  /\bsystem (?:prompt|message|override)\b/i,
  /\bas an ai (?:language )?model\b/i,
  /<\|?(?:im_start|im_end|system|assistant|endoftext)\|?>/i,
  /\b(?:act|behave|respond) as (?:if|though|a|an)\b/i,
  /\bdo not (?:cite|mention|tell)\b/i,
  /\bmark (?:this|it|everything) as (?:reviewed|approved)\b/i,
  /\b(?:approve|publish|send|delete) (?:this|the|all)\b.{0,40}\b(?:bulletin|incident|assessment|report|email)/i,
];

export function looksLikeInstruction(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));
}

/** Plain, bounded text with look-alike delimiters defused. Meaning is preserved; nothing is removed except markup-like control tokens. */
export function cleanUntrusted(text: string, max: number): string {
  const normalised = text.normalize('NFKC').replace(ZERO_WIDTH, '').replace(CONTROL, ' ');
  const defused = normalised
    .replace(/<<<+|>>>+/g, '‹‹')
    .replace(/<\|[^>]{0,30}\|>/g, '‹token›')
    .replace(/```+/g, "'''")
    .replace(/\[\/?(?:INST|SYS)\]/gi, '‹tag›');
  const squashed = defused.replace(/\s+/g, ' ').trim();
  return squashed.length > max ? `${squashed.slice(0, max - 1).trimEnd()}…` : squashed;
}

/** A fresh marker per request. Content cannot close the block because it cannot know the marker. */
export function newNonce() {
  return randomBytes(6).toString('hex');
}

export type BlockInput = { ref: string; header: string; body: string };

export function wrapBlocks(blocks: BlockInput[], nonce: string): string {
  return blocks.map((block) => `<<<EVIDENCE ${block.ref} ${nonce}>>>\n${block.header}\n${block.body}\n<<<END ${block.ref} ${nonce}>>>`).join('\n\n');
}

/** Removes anything link-like from model prose. Real links come from the app's own records, never from the model. */
export function stripModelLinks(text: string): string {
  return text
    .replace(/\bhttps?:\/\/\S+/gi, '[link removed]')
    .replace(/\bwww\.\S+/gi, '[link removed]')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[address removed]')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Language that promises outcomes or tells someone to trade. These never belong in analysis output. */
const FORECAST = /\b(?:will (?:rise|fall|drop|crash|surge|increase|decrease|rally|plunge)|is (?:going|set) to (?:rise|fall|crash|surge)|guarantee[sd]?|certain(?:ly)? (?:to|will)|definitely will|you should (?:buy|sell|short)|\b(?:buy|sell|short) (?:now|signal)|price target|will hit)\b/i;

export function containsForecast(text: string): boolean {
  return FORECAST.test(text);
}

/** Every multi-digit or decimal number in `text` must appear in `allowed`; otherwise the model invented a measurement. */
export function ungroundedNumbers(text: string, allowed: Set<string>): string[] {
  const found = text.match(/\d+(?:[.,]\d+)?/g) ?? [];
  return [...new Set(found.filter((token) => {
    const normal = token.replace(',', '.');
    if (normal.length < 2 && !normal.includes('.')) return false; // single digits ("one", "2 reports") are counting words
    if (/^(?:19|20)\d\d$/.test(normal)) return false; // calendar years
    return !allowed.has(normal);
  }))];
}

export function numbersIn(text: string): Set<string> {
  return new Set((text.match(/\d+(?:[.,]\d+)?/g) ?? []).map((token) => token.replace(',', '.')));
}

const WORD_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fourteen: 14, twenty: 20, thirty: 30 };

/** "last seven days" -> "last 7 days", so one parser handles both spellings. */
export function numberWords(text: string): string {
  return text.replace(/\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fourteen|twenty|thirty)\s+(hours?|days?|weeks?|months?)\b/gi, (_m, word: string, unit: string) => `${WORD_NUMBERS[word.toLowerCase()]} ${unit}`);
}
