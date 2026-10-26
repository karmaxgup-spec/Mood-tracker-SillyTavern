/**
 * Mood Tracker: SillyTavern integration.
 * All analysis lives in lib/ (pure functions). This file wires events, per-chat storage,
 * optional prompt injection, and the /mood slash command. It draws nothing on screen
 * and makes no network requests.
 *
 * Every SillyTavern API call is wrapped so a missing or renamed API disables only
 * that feature and logs one console.warn.
 */

import { LEXICON, buildPhraseMap } from './lib/lexicon.js';
import { analyzeMessage } from './lib/analyzer.js';
import { emptyState, applyReading, undoReading, applyManual } from './lib/state.js';

const EXT_KEY = 'moodTracker';
const PROMPT_KEY = 'st_mood_tracker';

/**
 * Settings defaults. Edit these values here to change behavior, since there is no settings panel.
 * injectIntoPrompt: when true, adds one short mood line to the prompt for the model.
 * Default is true, since there is no settings panel to turn it on.
 */
const DEFAULTS = Object.freeze({
  enabled: true,
  alpha: 0.4,
  halfLifeHours: 6,
  minConfidence: 0.15,
  injectIntoPrompt: true,
  injectDepth: 2,
  sarcasmDetection: true
});

/** Labels used in /mood replies. */
const MOOD_LABELS = Object.freeze({
  happy: 'Happy',
  love: 'Love',
  sad: 'Sad',
  jealous: 'Jealous',
  anger: 'Anger',
  neutral: 'Neutral'
});

/** One short line per emotion, injected into the prompt when enabled. */
const INJECT_LINES = Object.freeze({
  happy: '[User seems happy. Share the warmth.]',
  love: '[User seems affectionate. Return the affection warmly.]',
  sad: '[User seems sad. Be gentle and reassuring.]',
  jealous: "[User seems jealous. Reassure them you're only theirs.]",
  anger: '[User seems upset. Stay calm and listen.]'
});

const MANUAL_CHOICES = ['happy', 'love', 'sad', 'jealous', 'anger', 'neutral'];
const INJECT_MIN_CONFIDENCE = 0.3;
const phraseMap = buildPhraseMap(LEXICON);

const warned = new Set();
let promptApi = null;

/**
 * Log a warning once per key.
 * Inputs: key (string), message (string), err (optional). Output: none. Side effect: console.warn.
 * @param {string} key
 * @param {string} message
 * @param {unknown} [err]
 */
function warnOnce(key, message, err) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn('[st-mood-tracker]', message, err ?? '');
}

/**
 * Run a function and turn any error into a single warning.
 * Inputs: key (string), fn (function). Output: fn's return value or undefined.
 * Side effects: may log a warning.
 * @param {string} key
 * @param {() => unknown} fn
 */
function guard(key, fn) {
  try {
    return fn();
  } catch (err) {
    warnOnce(key, `${key} failed; feature disabled for this action.`, err);
    return undefined;
  }
}

/**
 * Get SillyTavern's context object, or null if unavailable.
 * Inputs: none. Output: context or null. Side effects: may log a warning.
 */
function getCtx() {
  return guard('getContext', () => SillyTavern.getContext()) ?? null;
}

/**
 * Read this extension's settings, filling in defaults for missing keys.
 * Inputs: ctx. Output: settings object. Side effects: writes defaults into extensionSettings.
 * @param {object} c
 */
function getSettings(c) {
  const root = c.extensionSettings;
  if (!root[EXT_KEY]) root[EXT_KEY] = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (root[EXT_KEY][k] === undefined) root[EXT_KEY][k] = v;
  }
  return root[EXT_KEY];
}

/**
 * Read this chat's mood state.
 * Inputs: ctx. Output: state object. Side effects: none.
 * @param {object} c
 */
function getState(c) {
  return c.chatMetadata?.[EXT_KEY] ?? emptyState();
}

/**
 * Store this chat's mood state and save chat metadata.
 * Inputs: ctx, state. Output: none. Side effects: writes chatMetadata and saves it.
 * @param {object} c
 * @param {object} state
 */
function setState(c, state) {
  c.chatMetadata[EXT_KEY] = state;
  guard('saveMetadata', () => c.saveMetadata());
}

/**
 * Analyze a user message and store its reading. Replaces any earlier entry for the same message.
 * Inputs: ctx, messageId (number). Output: none. Side effects: updates chat state and prompt.
 * @param {object} c
 * @param {number} messageId
 */
function trackUserMessage(c, messageId) {
  const s = getSettings(c);
  if (!s.enabled) return;
  const msg = c.chat?.[messageId];
  if (!msg || !msg.is_user) return;

  let state = getState(c);
  if (state.history.some((x) => x.id === messageId)) {
    state = undoReading(state, messageId, s);
  }
  const r = analyzeMessage(msg.mes ?? '', phraseMap, { sarcasmDetection: s.sarcasmDetection });
  const next = applyReading(
    state,
    { id: messageId, dist: r.dist, confidence: r.confidence, text: msg.mes ?? '', dominant: r.dominant, valence: r.valence },
    Date.now(),
    s
  );
  setState(c, next);
  refresh(c);
}

/**
 * Handle a deleted message: drop its entry and shift later message ids down by one.
 * Inputs: ctx, messageId (number). Output: none. Side effects: updates chat state and prompt.
 * @param {object} c
 * @param {number} messageId
 */
function handleDeleted(c, messageId) {
  const s = getSettings(c);
  let state = undoReading(getState(c), messageId, s);
  state = {
    ...state,
    history: state.history.map((x) => (x.id > messageId ? { ...x, id: x.id - 1 } : x))
  };
  setState(c, state);
  refresh(c);
}

/**
 * Refresh the prompt injection after any state change.
 * Inputs: ctx. Output: none. Side effects: calls setExtensionPrompt.
 * @param {object} c
 */
function refresh(c) {
  syncInjection(c).catch((err) => warnOnce('inject', 'Prompt injection update failed.', err));
}

/**
 * Find SillyTavern's setExtensionPrompt. Uses getContext() if it exposes it, otherwise
 * imports it from ST core (script.js, four folders up from this extension).
 * Inputs: ctx. Output: {set, position} or null. Side effects: may log a warning.
 * @param {object} c
 */
async function getPromptApi(c) {
  if (promptApi) return promptApi;
  if (typeof c.setExtensionPrompt === 'function') {
    promptApi = { set: c.setExtensionPrompt, position: c.extension_prompt_types?.IN_CHAT ?? 1 };
    return promptApi;
  }
  try {
    const core = await import('../../../../script.js');
    if (typeof core.setExtensionPrompt === 'function') {
      promptApi = { set: core.setExtensionPrompt, position: core.extension_prompt_types?.IN_CHAT ?? 1 };
      return promptApi;
    }
    warnOnce('promptApi', 'setExtensionPrompt not exported by script.js; prompt injection disabled.');
  } catch (err) {
    warnOnce('promptApi', 'Could not import setExtensionPrompt; prompt injection disabled.', err);
  }
  return null;
}

/**
 * Set or clear the prompt injection line based on current state and settings.
 * Inputs: ctx. Output: Promise<void>. Side effects: calls setExtensionPrompt.
 * @param {object} c
 */
async function syncInjection(c) {
  const s = getSettings(c);
  const st = getState(c);
  const last = st.history[st.history.length - 1];
  let text = '';
  if (s.enabled && s.injectIntoPrompt && st.dominant !== 'neutral' && last && last.confidence >= INJECT_MIN_CONFIDENCE) {
    text = INJECT_LINES[st.dominant] ?? '';
  }
  const api = await getPromptApi(c);
  if (!api) return;
  try {
    api.set(PROMPT_KEY, text, api.position, s.injectDepth);
  } catch (err) {
    warnOnce('setExtensionPrompt', 'setExtensionPrompt call failed; prompt injection disabled.', err);
  }
}

/**
 * Register /mood slash commands if this SillyTavern version exposes a registration function.
 * Replies are plain text in chat. Nothing is drawn on screen.
 * Inputs: ctx. Output: none. Side effects: registers the command.
 * @param {object} c
 */
function registerSlashCommands(c) {
  if (typeof c.registerSlashCommand !== 'function') {
    warnOnce('slash', 'registerSlashCommand unavailable; /mood commands disabled.');
    return;
  }
  guard('slash', () => {
    c.registerSlashCommand(
      'mood',
      (args) => {
        const sub = String(args ?? '').trim().toLowerCase();
        if (!sub) {
          const st = getState(c);
          return `Mood: ${MOOD_LABELS[st.dominant] ?? MOOD_LABELS.neutral}`;
        }
        if (sub === 'reset') {
          setState(c, emptyState());
          refresh(c);
          return 'Mood reset for this chat.';
        }
        const m = sub.replace(/^set\s+/, '');
        if (MANUAL_CHOICES.includes(m)) {
          // Manual entries use negative ids so they never collide with message indexes.
          setState(c, applyManual(getState(c), m, -Date.now(), Date.now()));
          refresh(c);
          return `Mood set to ${m}.`;
        }
        return 'Usage: /mood | /mood set <happy|love|sad|jealous|anger|neutral> | /mood reset';
      },
      [],
      'Show or set the tracked mood for this chat.'
    );
  });
}

/**
 * Hook SillyTavern events and start the extension.
 * Inputs: none. Output: none. Side effects: registers listeners and commands.
 */
function init() {
  const c = getCtx();
  if (!c) return;
  const es = c.eventSource;
  const et = c.eventTypes ?? c.event_types;
  if (!es || !et) {
    warnOnce('events', 'eventSource or eventTypes missing; mood tracker disabled.');
    return;
  }

  const on = (name, fn) => {
    if (!et[name]) {
      warnOnce(`event-${name}`, `Event ${name} not found in this SillyTavern version.`);
      return;
    }
    guard(`on-${name}`, () => es.on(et[name], fn));
  };

  // Messages are read at the moment they are sent, not when generation starts.
  on('MESSAGE_SENT', (arg) => {
    const c2 = getCtx();
    if (!c2) return;
    const id = typeof arg === 'number' ? arg : c2.chat.length - 1;
    guard('trackUserMessage', () => trackUserMessage(c2, id));
  });
  on('MESSAGE_EDITED', (arg) => {
    const c2 = getCtx();
    if (!c2 || typeof arg !== 'number') return;
    guard('trackEdited', () => trackUserMessage(c2, arg));
  });
  on('MESSAGE_DELETED', (arg) => {
    const c2 = getCtx();
    if (!c2 || typeof arg !== 'number') return;
    guard('handleDeleted', () => handleDeleted(c2, arg));
  });
  on('CHAT_CHANGED', () => {
    const c2 = getCtx();
    if (c2) guard('chatChanged', () => refresh(c2));
  });

  registerSlashCommands(c);
  refresh(c);
}

init();
