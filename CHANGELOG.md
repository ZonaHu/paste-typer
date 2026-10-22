# Changelog

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
