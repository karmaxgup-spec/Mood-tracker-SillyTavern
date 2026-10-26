/**
 * Pure mood state: decay, smoothing, history, and undo. No DOM, no SillyTavern imports.
 * All functions return new objects and never mutate their inputs.
 */

import { EMOTIONS, VALENCE_SIGN, DOMINANT_THRESHOLD } from './analyzer.js';

export const HISTORY_CAP = 200;
export const DEFAULTS = Object.freeze({ alpha: 0.4, halfLifeHours: 6, minConfidence: 0.15 });

/**
 * Create the starting state for a chat with no history.
 * Inputs: none. Output: state object. Side effects: none.
 * @returns {{dist: Record<string, number>, dominant: string, valence: number, updatedAt: number|null, history: object[]}}
 */
export function emptyState() {
  const dist = {};
  for (const e of EMOTIONS) dist[e] = 0;
  return { dist, dominant: 'neutral', valence: 0, updatedAt: null, history: [] };
}

/**
 * Derive dominant emotion and valence from a dist map.
 * Inputs: dist (Record<string, number>). Output: {dominant, valence}. Side effects: none.
 * @param {Record<string, number>} dist
 * @returns {{dominant: string, valence: number}}
 */
export function summarizeDist(dist) {
  const ranked = [...EMOTIONS].sort((a, b) => dist[b] - dist[a]);
  const top = ranked[0];
  const dominant = dist[top] >= DOMINANT_THRESHOLD ? top : 'neutral';
  const sum = EMOTIONS.reduce((acc, e) => acc + VALENCE_SIGN[e] * dist[e], 0);
  return { dominant, valence: Math.tanh(sum) };
}

/**
 * Apply one reading to the state with decay and smoothing.
 * Inputs: state, reading ({id, dist, confidence, text}), nowMs (number), options ({alpha, halfLifeHours, minConfidence}).
 * Output: new state. Side effects: none.
 * @param {object} state
 * @param {{id: number, dist: Record<string, number>, confidence: number, text?: string}} reading
 * @param {number} nowMs
 * @param {{alpha?: number, halfLifeHours?: number, minConfidence?: number}} [options]
 */
export function applyReading(state, reading, nowMs, options = {}) {
  const alpha = options.alpha ?? DEFAULTS.alpha;
  const halfLife = options.halfLifeHours ?? DEFAULTS.halfLifeHours;
  const minConf = options.minConfidence ?? DEFAULTS.minConfidence;

  const hours = state.updatedAt == null ? 0 : Math.max(0, (nowMs - state.updatedAt) / 3600000);
  const factor = state.updatedAt == null ? 1 : Math.pow(0.5, hours / halfLife);

  const decayed = {};
  for (const e of EMOTIONS) decayed[e] = (state.dist[e] ?? 0) * factor;

  const useAlpha = reading.confidence < minConf ? 0 : alpha;
  const newDist = {};
  for (const e of EMOTIONS) {
    newDist[e] = useAlpha * (reading.dist[e] ?? 0) + (1 - useAlpha) * decayed[e];
  }

  const { dominant, valence } = summarizeDist(newDist);
  const entry = {
    id: reading.id,
    ts: nowMs,
    dist: { ...reading.dist },
    confidence: reading.confidence,
    dominant: reading.dominant ?? dominant,
    valence: reading.valence ?? valence,
    text: reading.text ?? ''
  };
  const history = [...state.history, entry].slice(-HISTORY_CAP);

  return {
    dist: newDist,
    dominant,
    valence,
    updatedAt: nowMs,
    history
  };
}

/**
 * Remove the history entry for a message and rebuild the state from the rest.
 * Inputs: state, messageId (number), options (same as applyReading). Output: new state.
 * Side effects: none.
 * @param {object} state
 * @param {number} messageId
 * @param {{alpha?: number, halfLifeHours?: number, minConfidence?: number}} [options]
 */
export function undoReading(state, messageId, options = {}) {
  const remaining = state.history.filter((h) => h.id !== messageId);
  let rebuilt = emptyState();
  for (const h of remaining) {
    rebuilt = applyReading(rebuilt, h, h.ts, options);
  }
  return rebuilt;
}

/**
 * Create a manual override reading (confidence 1, text "[manual]").
 * Inputs: id (number), emotion (string, one of the five or "neutral"), nowMs (number).
 * Output: state-ready reading. Side effects: none.
 * @param {number} id
 * @param {string} emotion
 * @param {number} nowMs
 */
export function manualReading(id, emotion, nowMs) {
  const dist = {};
  for (const e of EMOTIONS) dist[e] = emotion === e ? 1 : 0;
  return { id, ts: nowMs, dist, confidence: 1, dominant: emotion === 'neutral' ? 'neutral' : emotion, text: '[manual]' };
}

/**
 * Apply a manual override. The current dist is set exactly to the chosen emotion
 * (one-hot, or all zeros for neutral), and a history entry is appended with confidence 1.
 * Inputs: state, emotion (string), id (number), nowMs (number). Output: new state.
 * Side effects: none.
 * @param {object} state
 * @param {string} emotion
 * @param {number} id
 * @param {number} nowMs
 */
export function applyManual(state, emotion, id, nowMs) {
  const reading = manualReading(id, emotion, nowMs);
  const { dominant, valence } = summarizeDist(reading.dist);
  const entry = { ...reading, dominant, valence };
  const history = [...state.history, entry].slice(-HISTORY_CAP);
  return { dist: { ...reading.dist }, dominant, valence, updatedAt: nowMs, history };
}
