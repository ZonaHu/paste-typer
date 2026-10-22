<h1 align="center">
  <img src="icon128.png" width="72" alt="Paste Typer">
  <br>Paste Typer
</h1>

<p align="center">
  <b>Paste into sites that block pasting.</b><br>
  A Chrome extension that types your clipboard out character-by-character, like a human would.
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/ofklpccfpgecjdccbnlmjbndkefgjaid"><img src="https://img.shields.io/badge/Chrome%20Web%20Store-Install-4285F4?logo=googlechrome&logoColor=white" alt="Chrome Web Store"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Manifest-V3-orange.svg" alt="Manifest V3">
  <img src="https://img.shields.io/badge/dependencies-none-brightgreen.svg" alt="No dependencies">
</p>

<p align="center">
  <a href="https://chromewebstore.google.com/detail/ofklpccfpgecjdccbnlmjbndkefgjaid"><b>➡️ Install from the Chrome Web Store</b></a>
</p>

<!-- Demo GIF: record it with docs/RECORDING.md, save as docs/demo.gif, then uncomment this block.
<p align="center">
  <img src="docs/demo.gif" width="640" alt="Paste Typer typing clipboard text into a field that blocks paste">
</p>
-->


---

## Why

Some sites disable paste. Banking portals, exam platforms, government forms, "confirm your email" fields, admin panels that call `preventDefault()` on every paste event. You end up retyping a 40-character password or a long ID by hand.

Paste Typer types it for you. It dispatches real `keydown` / `keypress` / `input` / `keyup` events one character at a time, with human-like timing, so the page sees typing instead of a paste.

## Features

- **Types your clipboard** into any field, character by character
- **Human-like timing** with variable speed and natural pauses
- **Right-click → "Paste as typed text"** on any editable field
- **Adjustable speed and typo rate**
- **Floating in-page UI**, draggable, isolated in a Shadow DOM
- **Google Docs and Slides support** via a canvas-editor adapter
- **Monaco textarea-based editors**, including editors in embedded frames
- **Input navigation mode** to step through editable fields on a page
- **Zero dependencies, zero network requests** — everything runs locally

## Install

**Chrome Web Store (recommended)** — [install here](https://chromewebstore.google.com/detail/ofklpccfpgecjdccbnlmjbndkefgjaid)

**From source**

```bash
git clone https://github.com/ZonaHu/paste-typer.git
```

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `paste-typer` folder

## Usage

**Popup** — click the toolbar icon, load from clipboard or type text, click an input field on the page, hit Start.

**Right-click menu** — copy text, right-click the target field, choose "Paste as typed text".

**Floating UI** — open it from the popup when you need the controls to stay visible while you work.

**Embedded editors** — if the editor is hosted on another site, choose its site under
"Allow access to an embedded editor's site" in the popup and click "Allow selected
site". Only that site is requested; you can revoke access in Chrome's extension
settings. Then click inside the editor and reopen the popup, or start from the
floating UI. Monaco input is inserted at the saved caret/selection without clearing
the document. Monaco must expose its editor API as `window.monaco` so the extension
can temporarily suppress automatic indentation and paired characters during each
simulated keystroke, then immediately restore the editor's options. Text still
enters through keyboard/text-input events, not clipboard paste or direct model
edits. Newer Monaco configurations using EditContext rather than a textarea
are not supported yet. Chrome 106 or newer is required.

## Supported fields

| Field type | Supported |
|---|---|
| `<input>` (text, email, password, search, url, tel) | ✅ |
| `<textarea>` | ✅ |
| `contenteditable` | ✅ |
| Google Docs / Slides canvas | ✅ |
| Monaco textarea-based editor (including permitted iframes) | ✅ |

## How it works

The content script is injected on demand, only when you invoke the extension. An adapter manager picks the right input adapter for the page, focuses the target field, and types one character at a time — dispatching the full keyboard event sequence for each character, with randomized delays and optional typos so the input looks human.

```
manifest.json        MV3 config
background.js        service worker: context menu + clipboard helper
content.js           typing engine, floating-UI host, message handlers
content/
  inputAdapter.js          base adapter interface
  standardInputAdapter.js  <input> / <textarea> / contenteditable
  googleDocsAdapter.js     Google Docs & Slides canvas editor
  monacoAdapter.js         Monaco keyboard/text input with temporary option suppression
  targetTracker.js         remembers the selected field and native selection
  adapterManager.js        picks the adapter for the page
frameRouter.js             selects and addresses a single permitted frame
popup.html / popup.js              toolbar popup
floating-ui.html / floating-ui.js  floating markup / isolated content-script controller
```

## Privacy

No network requests. No analytics. No accounts.

- The clipboard is read **only** when you click "Load from Clipboard" or use the context menu
- No required host permissions — `activeTab` covers the main site's origin; embedded sites can be allowed individually
- Settings live in `chrome.storage.local` (browser-local, not synced)

Full details in [PRIVACY.md](PRIVACY.md).

<details>
<summary><b>Permissions, explained</b></summary>

| Permission | Why |
|---|---|
| `activeTab` | Access the focused tab only when you invoke the extension |
| `storage` | Save your preferences (text, speed, typo rate, UI position) |
| `contextMenus` | The "Paste as typed text" right-click item |
| `scripting` | Inject the content script into the active tab on demand |
| `clipboardRead` | Read the clipboard when you click "Load from Clipboard" |
| `webNavigation` | Identify frames in the invoked tab to address the selected editor |

Optional host access is declared for HTTP/HTTPS sites but is requested only for the
individual embedded site you select. Content scripts are still injected on demand;
granting access does not install automatic scripts on that site.

</details>

## Troubleshooting

| Problem | Fix |
|---|---|
| Nothing happens | Click into an editable field first, then press Start |
| Clipboard read fails | The browser needs a user gesture — click "Load from Clipboard" directly |
| Field not detected | Use "Navigate Inputs" to step through editable fields |
| Speed feels wrong | Adjust the slider in the popup or floating UI |

## Contributing

Issues and PRs welcome, especially new site adapters. See [CONTRIBUTING.md](CONTRIBUTING.md).

Found a site where it doesn't work? [Open an issue](https://github.com/ZonaHu/paste-typer/issues/new/choose) with the URL.

## Disclaimer

Built for accessibility and legitimate data entry: password managers that can't autofill, long IDs, forms that block paste for no good reason. Don't use it to break the rules of exam platforms or any site whose terms you've agreed to.

## License

MIT © [ZonaHu](https://github.com/ZonaHu)

---

<p align="center">
  If this saved you from retyping something, a ⭐ helps other people find it.
</p>
