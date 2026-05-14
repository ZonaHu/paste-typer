# Paste Typer - Chrome Extension

A Chrome extension that types clipboard text character-by-character into web forms.
Useful for fields that don't accept paste, for accessibility, and for data-entry workflows.

## Features

- **Human-like typing simulation** with variable speed and natural pauses
- **Clipboard integration** - load text directly from clipboard
- **Right-click context menu** - "Paste as typed text" on any editable field
- **Adjustable typing speed and typo rate**
- **Floating in-page UI** with drag support, styled inside a Shadow DOM
- **Input navigation mode** to step through editable fields on the page
- **Google Docs adapter** with logic specific to the Docs editor
- **Visual feedback** - status messages, progress bar, active-element info

## Installation

### Load as unpacked extension (developer mode)

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `paste-typer` folder
5. The extension will appear in your extensions list

### Using the extension

1. **Popup**: Click the extension icon in the toolbar
   - Load text from clipboard or type manually
   - Adjust speed / typo rate
   - Click an input field on the page
   - Click "Start"

2. **Right-click menu**:
   - Copy text to clipboard
   - Right-click an input field
   - Select "Paste as typed text"

3. **Floating UI**:
   - Open via the popup's "Open Floating UI" button
   - Drag the header to reposition; position persists per profile

## Files Included

- `manifest.json` - Extension configuration (MV3)
- `background.js` - Service worker: context menu + clipboard read helper
- `content.js` - Main typing engine, floating-UI host, message handlers
- `content/` - Input adapters
  - `inputAdapter.js` - Base adapter interface
  - `standardInputAdapter.js` - Default `<input>` / `<textarea>` / contenteditable adapter
  - `googleDocsAdapter.js` - Google Docs-specific adapter
  - `adapterManager.js` - Picks the right adapter for the page
- `popup.html`, `popup.js` - Toolbar popup UI
- `floating-ui.html`, `floating-ui.js` - In-page floating UI (loaded via web-accessible resources)
- `icon16.png` / `icon32.png` / `icon48.png` / `icon96.png` / `icon128.png` - Extension icons
- `README.md` - This file

## How It Works

1. Content script injects on every page
2. Adapter manager selects an input adapter for the current site
3. Adapter focuses the target field and types one character at a time
4. Each character dispatches the proper `keydown` / `keypress` / `input` / `keyup` events
5. Random delays, pauses, and (optionally) typos simulate human input

## Supported Elements

- Text inputs (`<input type="text">`, `email`, `password`, `search`, `url`, `tel`)
- `<textarea>`
- `contenteditable` elements (including Google Docs canvas)

## Permissions

- `activeTab` - Send messages to the focused tab when the user invokes the extension
- `storage` - Save user preferences (text, speed, typo rate, floating UI position)
- `contextMenus` - "Paste as typed text" right-click menu on editable fields
- `scripting` - Re-inject the content script if the page loaded before the extension did
- `host_permissions: <all_urls>` - Run the content script on any site the user visits

The extension does NOT request `clipboardRead`. The popup and floating UI read the
clipboard via `navigator.clipboard.readText()` on user gesture.

## Privacy

- No external network requests. Everything runs locally.
- Clipboard is read only when the user clicks "Load from Clipboard" or the context menu.
- Settings stored in `chrome.storage.local` (browser-local, not synced).

## Troubleshooting

- **Nothing happens**: Click into an editable field first, then press Start.
- **Clipboard read fails**: The browser may require a user gesture; click "Load from Clipboard" directly.
- **Speed feels wrong**: Adjust the slider in the popup or floating UI.
- **Field not detected**: Use "Navigate Inputs" to step through editable fields on the page.
