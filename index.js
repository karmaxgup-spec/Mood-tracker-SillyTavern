/**
 * Mood Tracker: SillyTavern integration.
 * All analysis lives in lib/ (pure functions). This file only wires events, storage,
 * settings, the widget, and prompt injection. It makes no network requests.
 *
 * Every SillyTavern API call is wrapped so a missing or renamed API disables only
 * that feature and logs one console.warn.
 */

import { LEXICON, buildPhraseMap } from './lib/lexicon.js';
import { analyzeMessage } from './lib/analyzer.js';
import { emptyState, applyReading, undoReading, applyManual } from './lib/state.js';

const EXT_KEY = 'moodTracker';
const PROMPT_KEY = 'st_mood_tracker';
const WIDGET_ID = 'st-mood-tracker-widget';
const POPUP_ID = 'st-mood-tracker-popup';
const SETTINGS_ROOT_ID = 'st-mood-tracker-settings';

const DEFAULTS = Object.freeze({
  enabled: true,
  alpha: 0.4,
  halfLifeHours: 6,
  minConfidence: 0.15,
  showWidget: true,
  injectIntoPrompt: false,
  injectDepth: 2,
  sarcasmDetection: true
});

/** Display data for each dominant mood. The "neutral" dot is a plain middle dot. */
const MOOD_META = Object.freeze({
  happy: { emoji: '😊', label: 'Happy' },
  love: { emoji: '🥰', label: 'Love' },
  sad: { emoji: '😢', label: 'Sad' },
  jealous: { emoji: '😏', label: 'Jealous' },
  anger: { emoji: '😠', label: 'Anger' },
  neutral: { emoji: '·', label: 'Neutral' }
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
 * Create a DOM element with optional class and text. Uses textContent, never innerHTML,
 * so chat text is never parsed as markup.
 * Inputs: tag (string), className (string), text (string). Output: HTMLElement.
 * Side effects: none (creates a detached element).
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function h(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
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
 * Persist settings through SillyTavern's debounced save.
 * Inputs: ctx. Output: none. Side effects: saves extension settings.
 * @param {object} c
 */
function saveSettings(c) {
  guard('saveSettings', () => c.saveSettingsDebounced?.());
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
 * Inputs: ctx, messageId (number). Output: none. Side effects: updates chat state, widget, prompt.
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
 * Inputs: ctx, messageId (number). Output: none. Side effects: updates chat state.
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
 * Refresh every visible piece that depends on mood: widget and prompt injection.
 * Inputs: ctx. Output: none. Side effects: updates DOM and prompt injection.
 * @param {object} c
 */
function refresh(c) {
  guard('widget', () => renderWidget(c));
  guard('inject', () => syncInjection(c));
}

/**
 * Set or clear the prompt injection line based on current state and settings.
 * Inputs: ctx. Output: none. Side effects: calls setExtensionPrompt.
 * @param {object} c
 */
function syncInjection(c) {
  const s = getSettings(c);
  const st = getState(c);
  const last = st.history[st.history.length - 1];
  let text = '';
  if (s.enabled && s.injectIntoPrompt && st.dominant !== 'neutral' && last && last.confidence >= INJECT_MIN_CONFIDENCE) {
    text = INJECT_LINES[st.dominant] ?? '';
  }
  const position = c.extension_prompt_types?.IN_CHAT ?? 1;
  try {
    c.setExtensionPrompt(PROMPT_KEY, text, position, s.injectDepth);
  } catch (err) {
    warnOnce('setExtensionPrompt', 'setExtensionPrompt unavailable; prompt injection disabled.', err);
  }
}

/**
 * Create the widget bar above the chat input if it does not exist yet.
 * Inputs: none. Output: HTMLElement. Side effects: inserts a DOM node.
 */
function ensureWidget() {
  let el = document.getElementById(WIDGET_ID);
  if (el) return el;
  el = h('div', 'mt-widget');
  el.id = WIDGET_ID;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  const c = getCtx();
  el.addEventListener('click', () => c && openPopup(c));
  el.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && c) {
      e.preventDefault();
      openPopup(c);
    }
  });
  const anchor = document.querySelector('#send_form');
  if (anchor?.parentElement) {
    anchor.parentElement.insertBefore(el, anchor);
  } else {
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Draw the widget: emoji and label, valence bar, and confidence.
 * Inputs: ctx. Output: none. Side effects: rewrites widget DOM.
 * @param {object} c
 */
function renderWidget(c) {
  const s = getSettings(c);
  const el = ensureWidget();
  el.hidden = !(s.enabled && s.showWidget);
  if (el.hidden) return;

  const st = getState(c);
  const meta = MOOD_META[st.dominant] ?? MOOD_META.neutral;
  const last = st.history[st.history.length - 1];
  const confidence = last ? last.confidence : 0;
  const valencePct = Math.round(((st.valence + 1) / 2) * 100);

  el.replaceChildren();
  el.append(h('span', 'mt-emoji', meta.emoji), h('span', 'mt-label', meta.label));

  const bar = h('div', 'mt-valence');
  const marker = h('div', 'mt-valence-fill');
  marker.style.left = `${valencePct}%`;
  bar.append(marker);
  bar.title = `Valence ${st.valence.toFixed(2)}`;
  el.append(bar);

  const conf = h('span', 'mt-conf', `${Math.round(confidence * 100)}%`);
  conf.title = 'Confidence in the latest reading';
  el.append(conf);
}

/**
 * Open the history popup with the last 10 entries and a manual override control.
 * Inputs: ctx. Output: none. Side effects: adds an overlay to the DOM.
 * @param {object} c
 */
function openPopup(c) {
  closePopup();
  const st = getState(c);

  const overlay = h('div', 'mt-overlay');
  overlay.id = POPUP_ID;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePopup();
  });

  const box = h('div', 'mt-popup');
  box.append(h('div', 'mt-popup-title', 'Mood history'));

  const list = h('ul', 'mt-list');
  const recent = st.history.slice(-10).reverse();
  if (recent.length === 0) {
    list.append(h('li', 'mt-row', 'No readings yet.'));
  }
  for (const e of recent) {
    const meta = MOOD_META[e.dominant] ?? MOOD_META.neutral;
    const when = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const row = h('li', 'mt-row');
    row.append(h('span', 'mt-row-mood', `${meta.emoji} ${meta.label}`), h('span', 'mt-row-time', when));
    list.append(row);
  }
  box.append(list);

  const controls = h('div', 'mt-controls');
  const select = h('select', 'mt-select');
  for (const m of MANUAL_CHOICES) {
    const opt = h('option', '', MOOD_META[m].label);
    opt.value = m;
    select.append(opt);
  }
  const setBtn = h('button', 'mt-btn', 'Set mood');
  setBtn.addEventListener('click', () => {
    // Manual entries use negative ids so they never collide with message indexes.
    const id = -Date.now();
    setState(c, applyManual(getState(c), select.value, id, Date.now()));
    refresh(c);
    closePopup();
  });
  const closeBtn = h('button', 'mt-btn mt-btn-ghost', 'Close');
  closeBtn.addEventListener('click', closePopup);
  controls.append(select, setBtn, closeBtn);
  box.append(controls);

  overlay.append(box);
  document.body.append(overlay);
}

/** Remove the history popup if it is open. Inputs: none. Output: none. Side effects: DOM removal. */
function closePopup() {
  document.getElementById(POPUP_ID)?.remove();
}

/**
 * Bind the settings panel controls once they exist in the DOM.
 * Inputs: ctx. Output: none. Side effects: attaches listeners, may start a MutationObserver.
 * @param {object} c
 */
function bindSettings(c) {
  const tryBind = () => {
    const root = document.getElementById(SETTINGS_ROOT_ID);
    if (!root || root.dataset.bound === '1') return root ? true : false;
    root.dataset.bound = '1';
    const s = getSettings(c);

    const $ = (id) => root.querySelector(`#${id}`);
    const setVal = (id, v) => {
      const el = $(id);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = String(v);
    };
    setVal('mt-enabled', s.enabled);
    setVal('mt-alpha', s.alpha);
    setVal('mt-halflife', s.halfLifeHours);
    setVal('mt-minconf', s.minConfidence);
    setVal('mt-showwidget', s.showWidget);
    setVal('mt-inject', s.injectIntoPrompt);
    setVal('mt-depth', s.injectDepth);
    setVal('mt-sarcasm', s.sarcasmDetection);

    const bindNum = (id, key, min, max) => {
      $(id)?.addEventListener('change', (e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) {
          s[key] = Math.min(max, Math.max(min, n));
          e.target.value = String(s[key]);
          saveSettings(c);
        }
      });
    };
    const bindBool = (id, key, after) => {
      $(id)?.addEventListener('change', (e) => {
        s[key] = !!e.target.checked;
        saveSettings(c);
        after?.();
      });
    };

    bindBool('mt-enabled', 'enabled', () => refresh(c));
    bindBool('mt-showwidget', 'showWidget', () => refresh(c));
    bindBool('mt-inject', 'injectIntoPrompt', () => refresh(c));
    bindBool('mt-sarcasm', 'sarcasmDetection');
    bindNum('mt-alpha', 'alpha', 0, 1);
    bindNum('mt-halflife', 'halfLifeHours', 0.1, 168);
    bindNum('mt-minconf', 'minConfidence', 0, 1);
    bindNum('mt-depth', 'injectDepth', 0, 8);

    $('mt-reset')?.addEventListener('click', () => {
      setState(c, emptyState());
      refresh(c);
    });
    return true;
  };

  if (tryBind()) return;
  const observer = new MutationObserver(() => {
    if (tryBind()) observer.disconnect();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * Register /mood slash commands if this SillyTavern version exposes a registration function.
 * Inputs: ctx. Output: none. Side effects: registers commands (if supported).
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
          return `Mood: ${(MOOD_META[st.dominant] ?? MOOD_META.neutral).label}`;
        }
        if (sub === 'reset') {
          setState(c, emptyState());
          refresh(c);
          return 'Mood reset for this chat.';
        }
        const m = sub.replace(/^set\s+/, '');
        if (MANUAL_CHOICES.includes(m)) {
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
 * Inputs: none. Output: none. Side effects: registers listeners, DOM, and commands.
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

  guard('bindSettings', () => bindSettings(c));
  registerSlashCommands(c);
  refresh(c);
}

init();
