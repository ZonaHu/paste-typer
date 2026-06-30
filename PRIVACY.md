# Paste Typer — Privacy Policy

_Last updated: 2026-05-14_

Paste Typer is a Chrome extension that types clipboard text character-by-character
into web forms. This policy describes what data the extension handles.

## Data we collect

**None.** Paste Typer does not collect, transmit, sell, or share any user data.
The extension makes no network requests to any external server.

## Data the extension accesses locally

The extension only accesses data on your device, only when you actively use it,
and only for the feature you invoke:

- **Clipboard contents** — read via `navigator.clipboard.readText()` when you
  click "Load from Clipboard" or use the "Paste as typed text" context menu.
  The clipboard text is placed into the extension's text field and (when you
  press Start) typed into the focused form on the active page. It is never
  sent anywhere else.
- **The text you type into the extension's text field** — stored in
  `chrome.storage.local` so the field persists between sessions.
- **Your speed / typo-rate slider settings** — stored in `chrome.storage.local`.
- **The floating UI's last on-screen position** — stored in `chrome.storage.local`.
- **The currently focused element on the active tab** — read only to know where
  to type and to display a small label in the popup ("Active element: input#search").
  Never transmitted.

All `chrome.storage.local` data lives in your browser profile on your device.
It is not synced to your Google account and not sent to the developer.

## Permissions and why they exist

- `activeTab` — grants temporary access to the focused tab only when you invoke the extension.
- `storage` — persist the settings listed above.
- `contextMenus` — add the right-click "Paste as typed text" menu item on editable fields.
- `scripting` — inject the content script into the active tab on demand when you invoke the extension.

The extension requests no broad host permissions, so it cannot access any site
until you explicitly invoke it on that tab.

## Third parties

The extension does not include any analytics, telemetry, advertising SDK,
crash reporter, or third-party network call.

## Children

The extension is not directed at children under 13 and does not knowingly
process data from them. Since no data is collected at all, this is moot.

## Changes

If this policy ever changes, the updated date at the top of this file will be revised.

## Contact

Questions? Open an issue on the extension's repository or email the developer
address listed on the Chrome Web Store listing.
