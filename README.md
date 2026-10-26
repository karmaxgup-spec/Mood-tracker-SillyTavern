made by claude
made by claude
made by claude

# Mood Tracker (st-mood-tracker)

A SillyTavern extension that reads the AI's replies and estimates the **character's** mood as one of five states: happy, love, sad, jealous, or anger. It reads the AI's replies, never the user's messages. It is built for romantic AI-companion roleplay, so the character's emotional state carries into the next reply.

- **No visual changes.** It adds nothing to the screen: no bar, no panel, no popup, no styles.
- **Fully local.** Analysis is keyword and rule based. The code makes no network requests and no LLM calls.
- **Per chat.** Each chat keeps its own mood history, stored in the chat metadata.
- **Prompt injection.** When enabled, adds one short line to the prompt on every turn, such as `You are sad.` The line is chosen from a fixed table. Scores and history are never sent.

## Install

1. Copy the `st-mood-tracker` folder into `SillyTavern/public/scripts/extensions/third-party/`. Copy the whole folder, including `lib/`.
2. Restart SillyTavern, or reload the page.

To update, replace the folder and reload.

## Settings

There is no settings panel. Defaults live at the top of `index.js` in the `DEFAULTS` object. Edit them there and reload:

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn tracking on or off |
| `alpha` | `0.4` | How strongly each new message moves the mood (0 to 1) |
| `halfLifeHours` | `6` | How fast old readings fade |
| `minConfidence` | `0.15` | Readings below this leave the mood unchanged |
| `injectIntoPrompt` | `false` | Add a mood line to the prompt for the model |
| `injectDepth` | `2` | Where the prompt line goes (0 to 8) |
| `sarcasmDetection` | `true` | Shift happy and love to sad when sarcasm markers appear |

## Commands

- `/mood` replies with the current mood for this chat.
- `/mood set <happy|love|sad|jealous|anger|neutral>` sets the mood by hand.
- `/mood reset` clears this chat's mood history.

Replies appear as plain text in the chat. If this SillyTavern version does not support slash command registration, the commands are disabled and a single warning is logged.

## How it works

1. When the character's reply arrives, the text is normalized. Curly apostrophes are straightened, `((OOC))` and `[bracketed]` text is removed, and `*actions*` are marked.
2. The text is split into tokens. Apostrophes are dropped inside words, so "I'm" becomes "im" and matches the lexicon.
3. The analyzer looks up the longest phrase at each position (up to 7 tokens). If nothing matches, it tries again with runs of 3+ identical letters collapsed ("sooooo" becomes "so"), which counts as elongation.
4. Each hit is weighted by its lexicon weight, then adjusted:
   - inside `*actions*`: ×1.2
   - an ALL-CAPS word: ×1.3
   - elongated: ×1.3
   - preceded by a booster ("so", "very", "extremely"...): multiplied, capped at ×2.0
   - preceded by a negator within 3 tokens: happy or love becomes sad (×0.5), sad becomes happy (×0.4), jealous and anger are dampened (×0.4)
   - sarcasm markers ("oh great", "/s", "yeah right"...) shift happy and love hits to sad (70% moved)
5. The message is scored with exclamation marks boosting the dominant emotion, and confidence is reduced for very short messages, a trailing "?", and mixed positive and negative signals.
6. The reading is blended into the chat's running state. Older readings decay with a half-life, and a reading with confidence below the minimum leaves the state unchanged.

## Design decisions

These are the choices made where the spec was ambiguous or needed a fix.

- **MAX_PHRASE is 7**, not 4. Several required phrases have more than 4 tokens, such as "im not the only one am i". With a limit of 4 they could never match.
- **Apostrophes are dropped from tokens.** The lexicon stores "dont", "im", and so on. Keeping apostrophes would have broken every contraction match.
- **Commas and semicolons are dropped** during tokenization, so phrases can match across a comma in the user's text.
- **Love is its own emotion.** Affectionate phrases, emoji, and romantic actions moved from happy to love. Love is positive, and like happy it flips to sad under negation and shifts under sarcasm.
- **Emoji are one emotion each.** 😒 is mapped only to anger. 😏 is jealous. (The original spec listed 😒 twice with different emotions.)
- **Short messages** are those with fewer than 3 tokens after tokenizing, not counting punctuation.
- **Manual overrides** set the current mood exactly, with confidence 1 and text "[manual]". Their history entries use negative ids, so they never collide with message indexes. Message deletion shifts the ids of later messages down by one.
- **Undo replay.** Replaying history after a delete uses the stored readings. Manual entries replay through the normal blend, so after a replay they are not always exactly one-hot.
- **package.json** sets `"type": "module"` so the Node tests can load the ES modules in `lib/`. SillyTavern does not need it.
- **Neutral** is the output when the top emotion's share is below 0.35.

## Tuning the lexicon

All entries live in `lib/lexicon.js`.

- Each entry is `{ phrase, emotion, weight }`. Phrases are lowercase, with no apostrophes and no punctuation (write "im", "dont", "cant").
- Emoticons with punctuation (`:)`, `:(`, `>:(`, `:d`) are allowed as single tokens.
- Weights run from 1 (mild) to 3 (strong).
- To add a word, append an entry. Duplicates keep the higher weight.
- To check the effect of a change, run the tests (see below). The fixture report shows which lines flipped.

## Tests

```
node --test tests/analyzer.test.mjs
```

`tests/analyzer.test.mjs` covers negation, boosters, caps, elongation, emoji, actions, jealousy, sarcasm, decay, undo, low-confidence handling, determinism, and the history cap. It also runs `tests/fixtures.jsonl` and prints accuracy and a confusion table. Accuracy is reported, not asserted.

The fixture set was written alongside the lexicon, so its accuracy is optimistic. To measure real performance, label messages from your own chats and add them to the fixture file.

## SillyTavern APIs used

The integration code was written without access to a live SillyTavern instance. The names below must be checked against your version before relying on them. Each call is guarded: a missing API disables only that feature and logs one warning.

| Use | Name | Status |
|---|---|---|
| Context access | `SillyTavern.getContext()` | UNVERIFIED |
| Event bus | `context.eventSource.on(...)` | UNVERIFIED |
| Event names | `eventTypes` / `event_types`: `MESSAGE_RECEIVED`, `MESSAGE_EDITED`, `MESSAGE_DELETED`, `CHAT_CHANGED` | UNVERIFIED |
| Chat messages | `context.chat[i].mes`, `.is_user` | UNVERIFIED |
| Per-chat storage | `context.chatMetadata`, `context.saveMetadata()` | UNVERIFIED |
| Extension settings | `context.extensionSettings` | UNVERIFIED |
| Prompt injection | `context.setExtensionPrompt(key, text, position, depth)`, `context.extension_prompt_types.IN_CHAT` | UNVERIFIED |
| Slash commands | `context.registerSlashCommand(name, fn, aliases, help)` | UNVERIFIED |

If something does not work, open the browser console and look for `[st-mood-tracker]` warnings. Each one names the missing API.

## Privacy

Stored in the chat metadata: the emotion label, scores, timestamp, confidence, and the user's message text. Nothing is sent or exported. Deleting a chat deletes its mood history.

