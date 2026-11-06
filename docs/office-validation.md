# Office on the web acceptance workflow

Related to [issue #6](https://github.com/ZonaHu/paste-typer/issues/6).
**Word body delivery is not yet verified.** This runbook records the observed
layout and makes the missing live checks explicit; it does not add an Office
adapter or claim that a generic contenteditable fixture establishes support.

## Observed layout

On 2026-11-06 UTC, a new free Microsoft test account successfully opened a blank
Word document in the in-app browser. Its editing document was inside
`iframe#WacFrame_Word_0`. The frame exposed:

- `#WACViewPanel_EditingElement`, a visible contenteditable editing surface;
- a separate document-name contenteditable in the header;
- hidden clipboard, footnote/endnote and accessibility editing elements.

This is one observed Word layout, not an API contract. The in-app browser's
surface used a `Safari` class; Chrome can expose a different input/rendering path.
Do not select an adapter solely by the Office hostname or assume the first
contenteditable is the document body. A successful edit of the document name
is not a successful Word body test.

The reported Outlook first-character loss has not been reproduced. Excel's cell
editor has not been inspected. These are separate surfaces and need their own
observations before sharing an adapter implementation.

## Prepare an isolated live test

1. Load Paste Typer unpacked in a disposable Chrome profile, record the extension
   and Chrome/OS versions, and use free test accounts. Keep passwords in the
   provider sign-in UI; never put credentials, cookies or private document URLs
   in a test fixture or public issue.
2. Open a blank Word document and type `LEFT RIGHT` normally into its body as a
   control. Click between the space and `RIGHT` so the initial caret is known.
3. Copy harmless source `PT-test-483920`. Set typo rate to zero and select a
   deterministic speed. Open the popup, grant only any explicitly requested
   editor-frame origin, and record any refusal/error. The document title,
   toolbar search and unrelated document must remain unchanged.
4. Start typing. Expected body: `LEFT PT-test-483920RIGHT`. Record exact actual
   body text and progress/error, rather than treating a successful message or
   an invisible editing-surface value as accepted document text.
5. Wait for save, click elsewhere, return and reload. The body text must persist.
   Verify Undo/Redo and a selected-range replacement with a second harmless
   marker. Repeat with the floating panel; check Stop during a long source.
6. Repeat in an unsent Outlook test draft and an Excel test workbook. Include the
   very first character, a selected range, punctuation, a newline and a complete
   Unicode grapheme. Record literal-tab behavior separately from focus movement.

Use a new disposable document/draft/workbook for destructive Clear testing.
Do not send Outlook mail. Do not use a real password or verification-code field
as the test target.

## Current acceptance matrix

| Surface | Setup/control | Extension delivery | Persistence / Undo | Status |
| --- | --- | --- | --- | --- |
| Word document body | Blank test document opened; frame/editing nodes observed | Pending | Pending | Needs exact QA Chrome tab binding |
| Outlook unsent body | Free test mailbox created | Pending, including first character | Pending | Needs a reproducible affected layout |
| Excel cell editor | Pending | Pending | Pending | No compatibility claim |

Native Chrome control was bound to a different profile rather than the isolated
QA window. Testing stopped at the mismatch. Signing in to an in-app browser does
not establish sign-in or extension availability in another Chrome profile.

When a failure is reproduced, capture only the harmless marker, expected/actual
body text, invocation, frame-origin access and error. Inspect the real input
pipeline before implementing a narrowly detected adapter. Avoid direct canvas
DOM edits, hidden-input success checks, broad host permissions, forced focus
fallbacks and retries that could duplicate a partly accepted edit.
