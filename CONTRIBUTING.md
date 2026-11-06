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

For a reproducible report, use the site issue template and
[compatibility reporting guide](docs/compatibility-reporting.md). Include harmless
expected/actual text, extension/Chrome versions, invocation and tab state, and
embedded-site access. Keep private document IDs and clipboard data out of issues.

## Pull requests

Keep them focused. One fix or one adapter per PR. Describe what you tested it against.

## Testing

Run the frame routing and selection regression checks with Node.js:

```bash
node --test tests/*.test.cjs
```

Navigate has a disposable Chrome regression for field filtering, nested rich-text
editors, selected-field preference, dynamic page changes, the popup-to-typing
flow, and Chrome Web Store restrictions:

```bash
PT_TEST_DEPS=/path/to/test-deps node tests/navigation.integration.cjs
```

Set `PT_WEB_STORE_CHECK=1` to include a live Chrome Web Store restriction check
(requires network). It verifies Chrome rejects injection and Paste Typer explains
why. The test extension grants that host only in its temporary copy, so missing
host access cannot masquerade as the Web Store restriction. The Node suite also
checks translation of Chrome's gallery error without network access.
The typo-rate regression also checks real popup/floating labels, saved percent
values and helper repair in a disposable Chrome profile:

```bash
PT_TEST_DEPS=/path/to/test-deps node tests/typoRate.integration.cjs
```

Use the test-only Playwright setup below. Node tests check deterministic 0%, 5%
and 10% probability boundaries for both controls and the context menu.

For ordinary-field insertion changes, run `tests/standardInput.integration.cjs`
with the same test-only Playwright setup described below:

```bash
PT_TEST_DEPS=/path/to/test-deps node tests/standardInput.integration.cjs
```

This uses a disposable Chrome profile and extension copy. It checks caret insertion,
selection replacement, input notifications, popup/floating controls, and explicit
Clear. Context-menu coverage exercises its frame-routing contract, not the native
menu or clipboard permission UI.

Unicode regressions cover full grapheme input payloads and progress, pause/resume,
UTF-16 carets, and Backspace across native fields and split rich-text nodes:

```bash
node --test tests/unicode.test.cjs
PT_TEST_DEPS=/path/to/test-deps node tests/unicode.integration.cjs
```

The browser check also exercises Unicode input in a cross-origin Monaco editor.
Repeat it with Monaco 0.45 and 0.57 using the test-only setup below; point
`PT_MONACO_DEPS` at a separate dependency directory to switch Monaco versions.
Google Docs/Slides event construction has Node coverage only; this check does
not verify delivery into those canvas editors.
Accepted-text verification has its own disposable Chrome fixture, including
ordinary/rich-text rejection and transformation, page-handled keys, Monaco CRLF,
and unverified canvas delivery:

```bash
PT_TEST_DEPS=/path/to/test-deps node tests/acceptance.integration.cjs
```

It uses the test-only Playwright/Monaco setup below. Repeat with both Monaco
versions; `PT_MONACO_DEPS` may point to a separate Monaco installation.
Text privacy controls have a disposable Chrome regression as well:

```bash
PT_TEST_DEPS=/path/to/test-deps node tests/settings.integration.cjs
```

It covers Remember text, saved-source deletion, reloads, popup/floating consistency,
disabled-persistence typing, and forged page clicks.
For split code inputs, run the sibling-group regression with the same setup:

```bash
PT_TEST_DEPS=/path/to/test-deps node tests/splitCodeInput.integration.cjs
```

It checks six `maxlength="1"` sibling inputs with page or adapter focus advance,
partial starts, native Undo/Redo, typo correction, Stop, and group boundaries.
It also verifies page-owned edits, canceled input, deferred value rejection, and
inputs hidden by ancestor opacity or content visibility.
The adapter recognizes contiguous visible, editable text/tel/password inputs;
separators, ordinary controls and different parents end the group. Overflow stops
with an error instead of writing outside that group.

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
Run the Chrome suites sequentially. Concurrent disposable Chrome runs produced
intermittent model-wait timeouts during review; sequential Monaco 0.45/0.57 and
forced-typo runs passed. The harness logs model, session, and panel state on a
text mismatch so a future recurrence can be investigated.

For CodeMirror 6 changes, use `tests/codeMirror.integration.cjs` with a local
real-editor fixture and disposable Chrome profile. Install test-only dependencies
outside the repository:

```bash
npm install --prefix /tmp/paste-typer-cm6-test --no-save --package-lock=false playwright@1.56.1 esbuild@0.25.0 @codemirror/state@6.5.2 @codemirror/view@6.36.2 @codemirror/commands@6.8.1
PT_TEST_DEPS=/tmp/paste-typer-cm6-test node tests/codeMirror.integration.cjs
```

Repeat with `@codemirror/state@6.7.6`, `@codemirror/view@6.41.0`, and
`@codemirror/commands@6.11.1` (include Playwright and esbuild in the install again).
If editor dependencies are in a separate directory, set `PT_CODEMIRROR_DEPS` to
that directory; `PT_TEST_DEPS` still locates Playwright. The fixture bundles the
libraries only for its local page; the shipped extension has no dependencies.
It verifies model text and UTF-16 selection offsets, per-character transactions,
reversed selections, full Unicode graphemes, multiple carets, literal newlines,
configured line separators, native Undo/Redo, explicit Clear, read-only/filter
rejection, queued host restoration/rewriting/removal, interrupted dispatch, stale
view metadata, independent widget inputs, unrelated-editor safety,
forged page events, cross-origin routing, popup/floating controls, Stop and removal.
The typing engine's Unicode segmentation is tested separately; the adapter's
full-grapheme cases invoke its real runtime bridge directly. Lone UTF-16
surrogates are rejected; a complete combining or ZWJ sequence remains one
transaction, including graphemes longer than 32 code units.

The Undo regression uses the default 500 ms history grouping boundary and
recorded transaction timestamps. Every native group must restore exact text and
caret through Undo/Redo, including a deliberate pause; an entire source is not
assumed to be a single Undo event.

The bridge resolves the selected page view through the metadata used by the
public `EditorView.findFromDOM` implementation, then validates that view's DOM
identity. CodeMirror 6.36.2 uses
[`cmView.rootView.view`](https://github.com/codemirror/view/blob/6.36.2/src/editorview.ts);
6.41.0 uses [`cmTile.root.view`](https://github.com/codemirror/view/blob/6.41.0/src/editorview.ts).
These internal metadata names can change, so verify each claimed version and fail
without a DOM-edit fallback when resolution is unavailable. The public
[`EditorState.replaceSelection` API](https://github.com/codemirror/state/blob/main/src/state.ts)
preserves native selection semantics; the `input.type` user event lets the
[history extension](https://github.com/codemirror/commands/blob/main/src/history.ts)
group adjacent typed transactions normally. No site-specific support is claimed
by this local fixture alone.

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

For existing-user upgrade and receiver-recovery changes, run the isolated reload
harness with the same test-only Playwright setup:

```bash
PT_TEST_DEPS=/path/to/test-deps node tests/upgradeRecovery.integration.cjs
```

It needs full Git history for historical commit `64198da`. It checks an unpacked
upgrade with preserved settings, already-open/refreshed/new-page routed controls,
Stop, and trusted Floating UI Start.
This is not a Web Store upgrade or permission-disabled installation test. See
[the recorded evidence and live acceptance matrix](docs/upgrade-validation.md)
before claiming existing-user recovery.

The Start fallback regression covers non-text, hidden, disabled, read-only and
inert controls before a visible textarea:

```bash
PT_TEST_DEPS=/path/to/test-deps node tests/targetSelection.integration.cjs
```

The stop command has a disposable Chrome regression:

```bash
PT_TEST_DEPS=/path/to/test-deps node tests/stopCommand.integration.cjs
```

It verifies Chrome's command registration and invokes the production handler to
stop running/paused sessions. The Node tests invoke the registered command
listener and verify cross-origin frame routing. Physical key binding and OS
shortcut conflicts still need a manual check at `chrome://extensions/shortcuts`.

For session controls, also run `node --test tests/sessionState.test.cjs` and
`PT_TEST_DEPS=/path/to/test-deps node tests/sessionState.integration.cjs`.
These cover cancellation during target discovery, Stop acknowledgement after an
in-flight edit, Pause during typo correction, popup reopen, and cross-UI state
after Stop/Clear and back-to-back short sessions. Both visible UIs poll the same
session ID and phase; Stop invalidates delayed work before acknowledging.

## Code style

Plain JavaScript, no build tooling, no dependencies. Match the surrounding style.
