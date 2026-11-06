# Validate an existing installation after an update

Related to [issue #19](https://github.com/ZonaHu/paste-typer/issues/19).
An unpacked reload exercises receiver recovery, but cannot establish the behavior
of a Chrome Web Store update or an installation disabled by a permission change.
Keep those acceptance checks open until an affected installation is available.

## Recorded evidence

Observed on 2026-11-06 UTC (2026-11-05 in Toronto):

- The live [Chrome Web Store listing](https://chromewebstore.google.com/detail/paste-typer/ofklpccfpgecjdccbnlmjbndkefgjaid)
  displayed **1.1.2**, updated **October 29, 2026**. This supersedes the older
  listing observation in issue #19; it does not prove an existing profile updated.
- The disposable harness upgraded the same unpacked directory from historical
  commit `64198da` (**1.1.1**) to the current **1.1.2** manifest. The extension ID
  and a harmless storage marker survived. `webNavigation` was absent afterward.
- Chrome **156.0.8078.80**, macOS **Darwin 25.5.0**: two consecutive runs passed.
  On the already-open page, Navigate found both fields and the existing `OLD`
  value stayed unchanged. Refreshed and newly opened pages passed Navigate,
  Start, Stop and Floating UI checks; an unrelated field stayed unchanged.
- **Not tested:** a real Web Store upgrade and recovery of a permission-disabled
  1.1.0 installation. The local result must not be substituted for either check.

Chrome's [update lifecycle documentation](https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle)
explains update timing and manual update checks. A disabled extension can receive
updates; that alone does not establish that Chrome re-enables a particular
permission-disabled installation without user action.

## Repeat the disposable regression

Install test-only Playwright outside this repository, as described in
[CONTRIBUTING.md](../CONTRIBUTING.md), then run:

```bash
PT_TEST_DEPS=/path/to/test-deps node tests/upgradeRecovery.integration.cjs
```

The repository must contain historical commit `64198da` (fetch full history if
using a shallow clone). The harness uses an isolated Chrome profile and localhost
fixture. Developer mode is enabled only inside that disposable profile, matching
Chrome's Load unpacked prerequisite. It overwrites files in place before invoking
`runtime.reload()`: deleting the installed directory first can disable the test
extension and would exercise a different failure.

The harness records the old-page Navigate response rather than requiring a
particular stale-script response. Reloading invalidates content-script contexts;
the important assertions are no field mutation during the reload, preserved
settings, and successful operation on refreshed/new pages. All temporary files
and the disposable browser are removed when the harness exits.

## Live acceptance matrix

Use harmless test content in a disposable document. Keep an editable page open
before updating. Record the actual version and enabled state from
`chrome://extensions`; avoid reinstalling or clearing settings first because that
would erase the existing-user condition.

| Installation and page | Navigate | Start / exact output | Stop | Floating UI | Status |
| --- | --- | --- | --- | --- | --- |
| Store 1.1.1 → 1.1.2, already-open page | Pending | Pending | Pending | Pending | Needs an existing Store installation |
| Same Store upgrade, refreshed page | Pending | Pending | Pending | Pending | Needs an existing Store installation |
| Same Store upgrade, new page | Pending | Pending | Pending | Pending | Needs an existing Store installation |
| Disabled by 1.1.0 permission change → 1.1.2 | Pending | Pending | Pending | Pending | Record whether manual re-enable is required |
| Unpacked 1.1.1 → 1.1.2, refreshed/new fixture | Pass | Pass | Pass | Pass | Local regression only |

For the permission-disabled case, record enabled state both before and after the
update, any permission prompt, and whether an explicit re-enable is needed.
Check that settings survive. Do not infer this from a clean installation.

If `Could not establish connection. Receiving end does not exist.` persists,
record Chrome/OS versions, extension version, enabled state, installation source,
which control failed, whether refresh helps, the affected site's public origin,
and the service-worker error from `chrome://extensions`. Remove private page IDs,
query tokens, clipboard text and document content before posting diagnostics.
A focused recovery fix should follow the reproduced failing path.
