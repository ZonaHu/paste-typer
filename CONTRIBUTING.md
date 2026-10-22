# Contributing

Thanks for helping out. This is a small, dependency-free extension, so contributing is easy.

## Run it locally

```bash
git clone https://github.com/ZonaHu/paste-typer.git
```

Open `chrome://extensions/`, enable Developer mode, click **Load unpacked**, select the folder. After editing, click the reload icon on the extension card and refresh the target page.

No build step, no dependencies.

## The most useful contribution: a new site adapter

Most "it doesn't work on site X" reports come down to the site using a custom editor that ignores standard key events. The fix is a new adapter.

Adapters live in `content/` and implement the interface in `inputAdapter.js`:

| Method | Does |
|---|---|
| `canHandle(element)` | Return true if this adapter should own the current page/element |
| `focus(element)` | Put the caret where typing should start |
| `typeCharacter(element, char)` | Send one character |
| `clear(element)` | Empty the field |

Look at `standardInputAdapter.js` for the simple case and `googleDocsAdapter.js` for a canvas-based editor. Register your adapter in `adapterManager.js`.

## Reporting a site that doesn't work

Open an issue with the URL (or a description if it's behind a login) and what happened: nothing typed, partial text, wrong order, page rejected the input. That's enough to start.

## Pull requests

Keep them focused. One fix or one adapter per PR. Describe what you tested it against.

## Testing

Run the frame routing and selection regression checks with Node.js:

```bash
node --test tests/*.test.cjs
```

For Monaco changes, also test a textarea-based Monaco editor in a cross-origin
iframe: grant only the editor site's optional access, select a caret or range,
open each UI, and verify exact text, Undo/Redo, and that another editor is untouched.
Check permission denial and iframe navigation/removal. Do not rely on Monaco's
hidden textarea value to verify the document; verify its model or visible content.
Include Monaco 0.45 and a newer release, with auto-indent and auto-closing enabled.
Verify literal multiline code, keyboard/text-input events without clipboard paste,
and immediate restoration of editor options after successful and interrupted input.

An optional real-extension regression harness is available in
`tests/monaco.integration.cjs`. It needs a recent installed Chrome supporting the
`Extensions.loadUnpacked` DevTools command, plus test-only Playwright and Monaco
packages. Install them in a temporary directory outside the repository and set
`PT_TEST_DEPS` to that directory, then run:

```bash
npm install --prefix /path/to/test-deps --no-save --package-lock=false playwright@1.56.1 monaco-editor@0.45.0
PT_TEST_DEPS=/path/to/test-deps node tests/monaco.integration.cjs
```

On PowerShell, set `$env:PT_TEST_DEPS` before running Node. Repeat with
`monaco-editor@0.57.0` (install both packages again). The harness uses a disposable
Chrome profile and local cross-origin editor fixture; it never loads your normal
browser profile. Localhost permissions are pregranted only in the disposable
extension copy, while permission denial is covered by the Node tests. The popup
is represented by an extension-page tab whose tab query is pinned to the fixture.
No test dependencies are needed to run or build the extension itself.

Floating UI controls run in the content script's isolated world. Changes to them
must preserve the trusted-event checks: page scripts must not start/stop typing
or access extension settings through window messages or synthetic DOM events.
The Node checks exercise the production controller and router; the browser
harness tests forged page messages, synthetic clicks/input, real mouse/keyboard
activation, repeated panel opening, and popup/cross-origin editor behavior.
Set `PT_PARTIAL_INSTALL=1` when running the browser harness to preload the content
script without its floating controller. This verifies dependency repair without
class redeclarations. The harness also checks settings persistence after panel
recreation and removes partial markup when controller initialization fails.

## Code style

Plain JavaScript, no build tooling, no dependencies. Match the surrounding style.
