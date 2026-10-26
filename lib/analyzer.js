/**
 * Pure keyword-and-rule mood analyzer. No DOM, no SillyTavern imports, no I/O.
 *
 * Deviations from the spec, all deliberate:
 * - MAX_PHRASE is 7, not 4. Several required phrases are longer than 4 tokens
 *   (for example "im not the only one am i" is 7 tokens), and a 4-token limit
 *   would make them unmatchable.
 * - Tokens have apostrophes removed ("I'm" -> "im") so they match lexicon keys.
 * - Emoticons such as ":)" and ":(" are matched as single tokens.
 */

import { NEGATORS, BOOSTERS, SARCASM_MARKERS } from './lexicon.js';

/** @type {readonly string[]} */
export const EMOTIONS = Object.freeze(['happy', 'love', 'sad', 'jealous', 'anger']);

/** Valence sign per emotion. Used for the valence value and the mixed-signal check. */
export const VALENCE_SIGN = Object.freeze({ happy: 1, love: 1, sad: -1, jealous: -1, anger: -1 });

export const MAX_PHRASE = 7;
export const NEG_WINDOW = 3;
export const DOMINANT_THRESHOLD = 0.35;
export const ACTION_MULT = 1.2;
export const CAPS_MULT = 1.3;
export const ELONG_MULT = 1.3;
export const BOOSTER_CAP = 2.0;

const PUNCT = new Set(['.', '!', '?', ',', ';', ':', '…']);
const SENTENCE_END = new Set(['.', '!', '?']);

/**
 * Token pattern, tried in order: emoticons, words (apostrophes kept inside words),
 * numbers, emoji, then any other single non-space character.
 */
const TOKEN_RE = />:\(|:'\(|:-?\(|:-?\)|:-?d(?![\p{L}\p{N}])|:-?p(?![\p{L}\p{N}])|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|\p{Extended_Pictographic}|\S/giu;

/**
 * A token as produced by the tokenizer.
 * @typedef {{text: string, raw: string, isAllCaps: boolean, isAction: boolean}} Token
 */

/**
 * Normalize raw message text before tokenizing.
 * Inputs: text (string). Output: normalized string.
 * Side effects: none.
 * @param {string} text
 * @returns {string}
 */
export function normalize(text) {
  return String(text ?? '')
    .replace(/[‘’`]/g, "'")
    .replace(/\(\([\s\S]*?\)\)/g, ' ')
    .replace(/\[[^\]\n]*\]/g, ' ')
    .replace(/\r?\n+/g, ' . ');
}

/**
 * Tokenize one segment of text.
 * Inputs: str (string), isAction (boolean). Output: Token[].
 * Side effects: none.
 * @param {string} str
 * @param {boolean} isAction
 * @returns {Token[]}
 */
function tokenizeSegment(str, isAction) {
  const out = [];
  for (const m of str.matchAll(TOKEN_RE)) {
    const raw = m[0];
    const letters = raw.match(/\p{L}/gu) || [];
    const isAllCaps =
      letters.length >= 2 && raw === raw.toUpperCase() && raw !== raw.toLowerCase();
    out.push({
      text: raw.toLowerCase().replace(/['’]/g, ''),
      raw,
      isAllCaps,
      isAction
    });
  }
  return out;
}

/**
 * Split normalized text into speech and *action* segments and tokenize each.
 * Inputs: text (string). Output: Token[] in message order.
 * Side effects: none.
 * @param {string} text
 * @returns {Token[]}
 */
export function tokenize(text) {
  const norm = normalize(text);
  const tokens = [];
  let last = 0;
  for (const m of norm.matchAll(/\*([^*]+)\*/g)) {
    tokens.push(...tokenizeSegment(norm.slice(last, m.index), false));
    tokens.push(...tokenizeSegment(m[1], true));
    last = m.index + m[0].length;
  }
  tokens.push(...tokenizeSegment(norm.slice(last), false));
  // Commas and semicolons carry no emotion. Dropping them lets phrases like
  // "im not the only one am i" match across a comma in the user's text.
  return tokens.filter((t) => t.text !== ',' && t.text !== ';');
}

/**
 * Collapse runs of 3+ identical letters to one letter.
 * Inputs: word (string). Output: string.
 * Side effects: none.
 * @param {string} word
 * @returns {string}
 */
function collapse(word) {
  return word.replace(/(\p{L})\1{2,}/gu, '$1');
}

/**
 * Find the longest lexicon phrase starting at token index i.
 * Falls back to a single collapsed-elongation token lookup.
 * Inputs: tokens, i, phraseMap. Output: match object or null.
 * Side effects: none.
 * @param {Token[]} tokens
 * @param {number} i
 * @param {Map<string, {emotion: string, weight: number}>} phraseMap
 * @returns {{len: number, phrase: string, emotion: string, weight: number, elongated: boolean} | null}
 */
function matchAt(tokens, i, phraseMap) {
  const maxN = Math.min(MAX_PHRASE, tokens.length - i);
  for (let n = maxN; n >= 1; n--) {
    const key = tokens.slice(i, i + n).map((t) => t.text).join(' ');
    const hit = phraseMap.get(key);
    if (hit) {
      return { len: n, phrase: key, emotion: hit.emotion, weight: hit.weight, elongated: false };
    }
  }
  const single = tokens[i].text;
  const squashed = collapse(single);
  if (squashed !== single) {
    const hit = phraseMap.get(squashed);
    if (hit) {
      return { len: 1, phrase: squashed, emotion: hit.emotion, weight: hit.weight, elongated: true };
    }
  }
  return null;
}

/**
 * Booster multiplier from up to two tokens before index i.
 * "a bit" is handled as a two-token booster. Elongated boosters get ELONG_MULT.
 * Inputs: tokens, i. Output: number (already capped at BOOSTER_CAP).
 * Side effects: none.
 * @param {Token[]} tokens
 * @param {number} i
 * @returns {number}
 */
function boosterBefore(tokens, i) {
  if (i >= 2 && tokens[i - 2].text === 'a' && tokens[i - 1].text === 'bit') {
    return 0.6;
  }
  let mult = 1;
  for (let k = i - 1; k >= Math.max(0, i - 2); k--) {
    const t = tokens[k];
    if (PUNCT.has(t.text)) break;
    const base = collapse(t.text);
    const v = BOOSTERS[base];
    if (v !== undefined) {
      mult *= v;
      if (base !== t.text) mult *= ELONG_MULT;
    }
  }
  return Math.min(mult, BOOSTER_CAP);
}

/**
 * True if a negator appears within NEG_WINDOW tokens before i, stopping at a sentence end.
 * Inputs: tokens, i. Output: boolean.
 * Side effects: none.
 * @param {Token[]} tokens
 * @param {number} i
 * @returns {boolean}
 */
function negatedBefore(tokens, i) {
  for (let k = i - 1; k >= Math.max(0, i - NEG_WINDOW); k--) {
    const t = tokens[k];
    if (SENTENCE_END.has(t.text)) return false;
    if (NEGATORS.has(t.text)) return true;
  }
  return false;
}

/**
 * Detect sarcasm from markers. "/s" is checked on the raw text.
 * Inputs: text (string), tokens (Token[]). Output: boolean.
 * Side effects: none.
 * @param {string} text
 * @param {Token[]} tokens
 * @returns {boolean}
 */
function detectSarcasm(text, tokens) {
  if (/\/s(?![\p{L}\p{N}])/iu.test(text)) return true;
  const words = ' ' + tokens.filter((t) => !PUNCT.has(t.text)).map((t) => t.text).join(' ') + ' ';
  return SARCASM_MARKERS.some((m) => {
    if (m === '/s') return false;
    const mw = m.split(/\s+/).map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean).join(' ');
    return words.includes(' ' + mw + ' ');
  });
}

/**
 * Build an empty result for input with no emotional signal.
 * Inputs: sarcasm (boolean). Output: result object.
 * Side effects: none.
 * @param {boolean} sarcasm
 */
function emptyResult(sarcasm) {
  return {
    dist: { happy: 0, love: 0, sad: 0, jealous: 0, anger: 0 },
    dominant: 'neutral',
    valence: 0,
    confidence: 0,
    hits: [],
    rawTotal: 0,
    sarcasm
  };
}

/**
 * Compute dist, dominant, and the top two values from raw scores.
 * Inputs: score (object of raw scores), total (number). Output: {dist, dominant, top1, top2}.
 * Side effects: none.
 * @param {Record<string, number>} score
 * @param {number} total
 */
function summarize(score, total) {
  const dist = {};
  for (const e of EMOTIONS) dist[e] = total > 0 ? score[e] / total : 0;
  const ranked = [...EMOTIONS].sort((a, b) => dist[b] - dist[a]);
  const top1 = ranked[0];
  const top2 = ranked[1];
  const dominant = dist[top1] >= DOMINANT_THRESHOLD ? top1 : 'neutral';
  return { dist, dominant, top1, top2, d1: dist[top1], d2: dist[top2] };
}

/**
 * Analyze one message and return its mood reading.
 * Inputs: text (string), phraseMap (from buildPhraseMap), options ({sarcasmDetection: boolean}).
 * Output: {dist, dominant, valence, confidence, hits, rawTotal, sarcasm}.
 * Side effects: none.
 * @param {string} text
 * @param {Map<string, {emotion: string, weight: number}>} phraseMap
 * @param {{sarcasmDetection?: boolean}} [options]
 */
export function analyzeMessage(text, phraseMap, options = {}) {
  const sarcasmOn = options.sarcasmDetection !== false;
  const tokens = tokenize(text);
  const sarcasm = sarcasmOn && detectSarcasm(String(text ?? ''), tokens);
  const score = { happy: 0, love: 0, sad: 0, jealous: 0, anger: 0 };
  const hits = [];

  let i = 0;
  while (i < tokens.length) {
    const m = matchAt(tokens, i, phraseMap);
    if (!m) {
      i++;
      continue;
    }
    const span = tokens.slice(i, i + m.len);
    let w = m.weight;
    const actionHit = span.some((t) => t.isAction);
    const capsHit = span.some((t) => t.isAllCaps);
    if (actionHit) w *= ACTION_MULT;
    if (capsHit) w *= CAPS_MULT;
    if (m.elongated) w *= ELONG_MULT;

    const boost = boosterBefore(tokens, i);
    if (boost !== 1) w *= boost;

    const negated = negatedBefore(tokens, i);
    let target = m.emotion;
    if (negated) {
      if (m.emotion === 'happy' || m.emotion === 'love') {
        score.sad += 0.5 * w;
        target = null;
      } else if (m.emotion === 'sad') {
        score.happy += 0.4 * w;
        target = null;
      } else {
        w *= 0.4;
      }
    }

    if (target !== null) {
      if (sarcasm && (target === 'happy' || target === 'love')) {
        score.happy += 0.3 * w;
        score.sad += 0.7 * w;
      } else {
        score[target] += w;
      }
    }

    hits.push({
      phrase: m.phrase,
      emotion: m.emotion,
      weight: m.weight,
      finalWeight: w,
      negated,
      boosted: boost !== 1,
      action: actionHit,
      caps: capsHit,
      elongated: m.elongated
    });
    i += m.len;
  }

  let total = EMOTIONS.reduce((s, e) => s + score[e], 0);
  if (total === 0) return emptyResult(sarcasm);

  let s = summarize(score, total);

  // Exclamation boost on the dominant emotion (only when a dominant exists).
  const excl = tokens.filter((t) => t.text === '!').length;
  if (s.dominant !== 'neutral' && excl > 0) {
    score[s.dominant] *= 1 + 0.1 * Math.min(excl, 5);
    total = EMOTIONS.reduce((acc, e) => acc + score[e], 0);
    s = summarize(score, total);
  }

  let confidence = Math.max(0, Math.min(1, s.d1 - s.d2));
  const wordTokens = tokens.filter((t) => !PUNCT.has(t.text)).length;
  const last = tokens[tokens.length - 1];
  if (last && last.text === '?') confidence *= 0.9;
  if (wordTokens < 3) confidence *= 0.5;
  const sign1 = VALENCE_SIGN[s.top1];
  const sign2 = VALENCE_SIGN[s.top2];
  if (s.d1 > 0.25 && s.d2 > 0.25 && sign1 !== sign2) confidence -= 0.3;
  confidence = Math.max(0, Math.min(1, confidence));

  const valenceSum = EMOTIONS.reduce((acc, e) => acc + VALENCE_SIGN[e] * s.dist[e], 0);
  return {
    dist: s.dist,
    dominant: s.dominant,
    valence: Math.tanh(valenceSum),
    confidence,
    hits,
    rawTotal: total,
    sarcasm
  };
}
