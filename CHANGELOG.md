# Changelog

## v1.2.2 — 2026-11-08

Google Docs accepts typed text again. There was no 1.2.1 release.

### 🧰 Fixes
- **Google Docs** — Route the hidden input iframe to the Docs adapter instead of selecting it as an ordinary editable field, which made Docs reject every character. ([#42](https://github.com/ZonaHu/paste-typer/pull/42))

Validated with 104 Node checks and a disposable Chrome fixture confirming `A中B` reaches the document through the Docs adapter. Live Google Docs acceptance still needs a manual check.

**Full Changelog**: https://github.com/ZonaHu/paste-typer/compare/v1.2.0...v1.2.2

## v1.2.0 — 2026-11-06

Paste Typer fills split verification-code boxes, types in CodeMirror 6 editors, and now verifies that the page actually accepted each character before reporting success.

### 💡 Enhancements
- **Verification codes** — Fill adjacent one-character boxes in order and stop at the group boundary. ([#30](https://github.com/ZonaHu/paste-typer/pull/30))
- **CodeMirror 6** — Type through the selected editor's transaction API, preserving its filters and native Undo history. ([#31](https://github.com/ZonaHu/paste-typer/pull/31))
- **Emergency Stop** — A configurable Chrome shortcut stops the active frame, and an older Clear can no longer erase a new Start. ([#23](https://github.com/ZonaHu/paste-typer/pull/23))
- **Saved source text** — Remember text and Delete saved text behave the same in the popup and the floating panel, including before settings finish loading. ([#22](https://github.com/ZonaHu/paste-typer/pull/22))

### 🧰 Fixes & Housekeeping
- **Accepted text** — Check the settled text and caret before advancing progress, and stop on rejected or redirected edits instead of reporting success. ([#29](https://github.com/ZonaHu/paste-typer/pull/29))
- **Unicode** — Type and delete complete grapheme clusters, and reject malformed surrogate input. ([#28](https://github.com/ZonaHu/paste-typer/pull/28))
- **Typo rate** — Popup, floating controls, storage and the engine share one percentage unit, so a saved 5 means 5%. ([#27](https://github.com/ZonaHu/paste-typer/pull/27))
- **Target selection** — Skip file, hidden, disabled, read-only and non-editable controls when Start or Navigate picks a field. ([#21](https://github.com/ZonaHu/paste-typer/pull/21), [#25](https://github.com/ZonaHu/paste-typer/pull/25), [#26](https://github.com/ZonaHu/paste-typer/pull/26))
- **Notion** — Clear refuses Notion pages and block-based editors, where a synthetic Select All could delete the page title. ([#38](https://github.com/ZonaHu/paste-typer/pull/38))
- **Chrome Web Store pages** — Explain that Chrome blocks extensions there rather than reporting a generic failure. ([#25](https://github.com/ZonaHu/paste-typer/pull/25))
- **Reporting and validation docs** — Site issue template and reproduction guide, an executable unpacked-upgrade regression, and the Word body investigation notes. ([#32](https://github.com/ZonaHu/paste-typer/pull/32), [#33](https://github.com/ZonaHu/paste-typer/pull/33), [#35](https://github.com/ZonaHu/paste-typer/pull/35))

Validated with 100 Node checks plus Chrome suites for ordinary fields, session state, Monaco 0.57 and CodeMirror 6. Refresh already-open pages after updating.

Known follow-ups: ProseMirror ([#5](https://github.com/ZonaHu/paste-typer/issues/5)), Monaco EditContext ([#4](https://github.com/ZonaHu/paste-typer/issues/4)), Office on the web ([#6](https://github.com/ZonaHu/paste-typer/issues/6)) and background-tab reliability ([#14](https://github.com/ZonaHu/paste-typer/issues/14)).

**Full Changelog**: https://github.com/ZonaHu/paste-typer/compare/v1.1.2...v1.2.0

## v1.1.2 — 2026-10-29

Paste Typer no longer requires the browsing-history permission added in 1.1. Existing installations that Chrome already paused may still need to be re-enabled once in the extension manager.

### 🧰 Fixes & Housekeeping
- **Updates and embedded editors** — Discover accessible frames through the existing scripting permission, so future updates do not request `webNavigation`. Per-site access remains available for embedded editors whose iframe URL is visible from an accessible page. ([#18](https://github.com/ZonaHu/paste-typer/pull/18))
- **Connection recovery** — Replace Chrome's raw “Receiving end does not exist” error with steps to refresh the page and re-enable the extension if needed. ([#18](https://github.com/ZonaHu/paste-typer/pull/18))

Validated with 27 unit checks, real Chrome input and floating-panel tests, and a cross-origin Monaco 0.57 editor. An editor nested inside an inaccessible cross-origin iframe may require access to its parent site before it can be discovered.

**Full Changelog**: https://github.com/ZonaHu/paste-typer/compare/v1.1.1...v1.1.2

## v1.1.1 — 2026-10-23

Paste Typer now preserves existing field content when starting a typing session. Place the caret to insert text, or select a range to replace only that text.

### 🧰 Fixes
- **Ordinary fields** — Start no longer clears inputs, textareas, or editable content. Selecting `DEF` in `abcDEFghi` and typing `XYZ` now produces `abcXYZghi`. ([#17](https://github.com/ZonaHu/paste-typer/pull/17))
- **Rich text** — Replace the selected range while preserving surrounding formatting, and keep insertion inside the target field. The explicit **Clear entire field** action still deletes the whole field. ([#17](https://github.com/ZonaHu/paste-typer/pull/17))

Refresh already-open pages after updating. Validated with 27 Node checks and isolated Chrome suites for ordinary fields and Monaco 0.57. Native context-menu UI and real React/Vue applications were not exercised; routing and input notifications were checked.

Known follow-ups: typo-rate conversion, Unicode grapheme handling, accepted-text verification, and background-tab reliability. This GitHub release does not automatically update the Chrome Web Store listing.

**Full Changelog**: https://github.com/ZonaHu/paste-typer/compare/v1.1.0...v1.1.1

## v1.1.0 — 2026-10-22

Paste Typer 1.1.0 adds support for textarea-based Monaco editors inside embedded frames, including zyBooks. Selected editors retain their caret or selection when opening extension controls.

### 💡 Enhancements
- **Embedded editors** — Route input to one selected document, request optional access only for the chosen editor origin, and preserve existing Monaco content and native Undo behavior. Requires Chrome 106+. Monaco must expose its textarea input surface and `window.monaco` API. ([#8](https://github.com/ZonaHu/paste-typer/pull/8))

### 🧰 Fixes & Housekeeping
- **Literal input** — Preserve leading/trailing whitespace, normalize CRLF/CR to LF, and prevent Monaco auto-indent and paired-character completion from altering source code. ([#8](https://github.com/ZonaHu/paste-typer/pull/8))
- **Reliability and isolation** — Surface reported typing failures, improve Stop responsiveness after normal delays, and isolate floating controls from forged page messages and synthetic clicks. Refresh already-open pages after upgrading. ([#8](https://github.com/ZonaHu/paste-typer/pull/8))
- **Clear action** — Rename the button to “Clear entire field” and explain that it deletes existing content. Deletion behavior is unchanged. ([#9](https://github.com/ZonaHu/paste-typer/pull/9))

Known limitations: ordinary fields still clear on Start; typo-rate display/conversion and Unicode grapheme handling need follow-up fixes. Google Docs background-tab behavior is not fixed in this release. The attached ZIP is suitable for unpacked installation or Chrome Web Store upload; a GitHub release does not update the store listing automatically.

**Full Changelog**: https://github.com/ZonaHu/paste-typer/compare/v1.0.7...v1.1.0
