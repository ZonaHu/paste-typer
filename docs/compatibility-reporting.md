# Report an editor compatibility problem

Use the [site issue form](https://github.com/ZonaHu/paste-typer/issues/new?template=site-not-working.md)
for a reproducible failure. [Issue #7](https://github.com/ZonaHu/paste-typer/issues/7)
remains the place to collect site reports; it is an ongoing tracker.

1. Check that Paste Typer is enabled in `chrome://extensions`, record its version,
   and refresh the affected page once after an extension update.
2. Use harmless test text such as `PT-test-483920`. Click the intended field,
   invoke one UI, and record the expected and exact actual text.
3. Record the invocation: popup, floating panel, or right-click menu. Include
   Chrome/OS versions, whether the tab was in front, and any permission/error text.
4. If the editor is in an embedded frame, record its site and whether access was
   granted. A site's search field and document body may use different editors.
5. If possible, share a small public reproduction. The local
   [demo page](demo-page.html) provides an ordinary-field control case.

For a minimal reproduction, keep only the failing field, its editor setup, and
the handler that rejects or transforms input. State the editor package/version
and how to run it. Check insertion at a caret, replacement of selected text,
Undo/Redo, and that another field stays unchanged. Describe which case fails.

Keyboard events dispatched by JavaScript are synthetic. Some sites require
trusted browser input or keep an editor model that ignores those events. A
successful dispatch alone does not establish compatibility with that site.
Chrome also blocks extension scripting on its protected pages, including the
Chrome Web Store. Report the displayed error rather than trying to bypass it.

Do not include real clipboard text, passwords, one-time codes, private documents,
or signed URLs in a public issue. Remove document/account IDs and query tokens
from URLs and screenshots. A site name plus a description is useful even when
the page cannot be shared.
