# Chrome Web Store listing — Paste Typer

> Last updated: 2026-11-23. Draft for the next submission; verify dashboard-only fields before publishing.

## Store listing

**Extension name:** Paste Typer

**Short description:** Types clipboard text character by character into web forms, including fields that block paste.

**Detailed description:**

Paste Typer helps you enter copied text into web forms that do not accept paste.

Choose text from your clipboard or type it in the popup, click the field you want to fill, and press Start. Adjust typing speed and typo rate, pause or stop a session, or keep controls visible with the floating panel. The extension also offers input navigation and support for Google Docs, Slides, Monaco, and CodeMirror editors. Some sites may reject simulated input; check the result before relying on it.

Your text and settings stay in your browser. The extension has no analytics or ads. Paste Typer is free; an optional support link in the popup opens a Stripe-hosted payment page for SOLA SPIN in a new tab only if you click it. Payments and optional feature-request messages are handled by Stripe, not by the extension.

For help or to report a bug: https://github.com/ZonaHu/paste-typer/issues

**Category:** Tools (current public listing)

**Single purpose:** Type user-selected text into the currently selected web editor.

**Primary language:** English

## Graphics and assets

| Asset | Status |
| --- | --- |
| Store icon | `icon128.png`, 128×128 PNG |
| Store screenshots | Verify existing dashboard assets; refresh the popup screenshot if it shows the old footer |

## Permissions justification

| Permission | Reason |
| --- | --- |
| `activeTab` | Access the active page when the user invokes typing or navigation. |
| `storage` | Save local typing settings, optional remembered text, and floating-panel position. |
| `contextMenus` | Offer the “Paste as typed text” right-click action. |
| `scripting` | Insert the typing controls into the selected page and accessible editor frames on demand. |
| `clipboardRead` | Read text only when the user chooses the clipboard action. |
| Optional HTTP/HTTPS origins | Let the user grant access to a specific embedded editor's site. |

The support link adds no extension permissions.

## Privacy and data use

**Extension-collected data:** None. The extension keeps remembered source text and preferences in browser-local storage; it does not transmit them to the developer. It does not include analytics, ads, or payment code. Clicking the optional support link opens Stripe's site, where Stripe collects payment details and any optional message under its own terms. See [PRIVACY.md](PRIVACY.md).

**Data use certifications:** Data is not sold, used for unrelated purposes, or used for creditworthiness or lending.

**Privacy policy URL:** https://github.com/ZonaHu/paste-typer/blob/main/PRIVACY.md

## Distribution and developer info

**Visibility and regions:** Verify current dashboard settings; this change does not alter them.

**Publisher name:** Verify current dashboard value before submission.

**Contact email:** zuomiao.hu@gmail.com (current public listing)

**Support URL:** https://github.com/ZonaHu/paste-typer/issues

**Homepage URL:** https://github.com/ZonaHu/paste-typer

## Version history

| Version | Date | Change | Status |
| --- | --- | --- | --- |
| 1.2.3 | 2026-11-23 | Optional support link in popup; Stripe disclosure | Draft |

## Review notes

The support link is voluntary, appears only at the bottom of the popup, and does not unlock features. No new permission, external script, or background request is added. The public page currently shows merchant **SOLA SPIN**, product **paste-typer**, a fixed **$1.00** amount, and an optional “What feature would you like to see?” text field. No payment was submitted during verification.
