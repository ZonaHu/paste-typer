# Background typing investigation (#14)

Keep the target tab visible and Chrome open while typing. Background tabs and
minimized windows can run much more slowly, and Chrome can freeze or discard
hidden pages. There is no guarantee of continued typing after switching tabs,
minimizing Chrome, suspending the computer, closing the tab, or quitting Chrome.
Google Docs background compatibility still requires the live checks below.

## Reproduce the local measurements

Use Node 22+ and recent installed Chrome supporting `Extensions.loadUnpacked`,
with a desktop session. Run:

```bash
PT_BACKGROUND_REPORT=/tmp/paste-typer-background.json node tests/background.integration.cjs
```

Set `PT_CHROME_PATH` if Chrome is not in the usual installation location.
The harness opens a new headful Chrome process, a temporary profile, and a copy of
the extension with access to its localhost fixture. It does not open Google Docs,
use an account, or load your normal profile. Do not interact with the disposable
window while the test runs. The process/profile/fixture are removed on exit.

The test uses direct CDP rather than Playwright: Playwright's ordinary launch
flags disable background timer throttling, and its focus emulation can keep
inactive tabs reporting `visible`. A test using those defaults cannot establish
background compatibility. This harness asserts the real document visibility and
the minimized window state. It never enables focus emulation or disables
background timer throttling. Its CDP attachment and short duration remain limits
of the measurement; it does not establish behavior after prolonged inactivity.

Each of two fixtures runs in the foreground, after switching to another tab,
and with its window minimized:

- A normal textarea exercises production target selection and native insertion.
- An observable local event sink uses the real `GoogleDocsAdapter`, selected
  explicitly in the test because localhost is not Google Docs. The sink accepts
  synthetic keyboard/text-input events and records a model. It is deliberately
  simpler than Docs and cannot prove that Docs accepts those events.

The known source is `PT14 one\nPT14 two\nPT14 end` (26 characters). Every run starts
visible, changes state after at least two characters, and compares the final
fixture value exactly with the source. Requested delays are 40 ms; random timing
variation, random pauses, and typos are disabled only in the injected test
instance. A second run checks pause, resume, and Stop in the same visibility
state, holds output/progress for 1.4 seconds, then returns to the tab and checks
that Stop still holds. The JSON records Chrome/OS/command line, exact output,
progress, event timestamps, visibility, and command response times.

This narrow Stop check has no typos or overlapping starts. Full cancellation
and session isolation are tracked by #15 / PR #23; canvas acceptance reporting
is tracked by #13 / PR #29. Neither is implemented by this investigation.

## Recorded compatibility matrix

Exploratory baseline: **2026-11-06 03:20 UTC**, Chrome **156.0.8078.80**,
macOS **26.5.2 (25F84)** / Darwin **25.5.0**, arm64. Extension code was
`f3ca1d13ff1f3b3d73d7f296dd8f36acc0a70aba` (v1.1.2), with only test-instance
timing/adapter configuration as described above. All six rows had exact fixture
text, final progress **26/26**, `isTyping: false`, and no reported error.

| Fixture | Window/tab state | Elapsed | Characters delivered while hidden | Pause/resume and Stop |
|---|---|---:|---:|---|
| Native textarea | Foreground | 1.32 s | 0/26 | Held/resumed; Stop held after restore |
| Native textarea | Switched away | 23.82 s | 24/26 | Held/resumed; Stop held after restore |
| Native textarea | Minimized | 9.82 s | 9/26 | Held/resumed; Stop held after restore |
| Local Docs event sink | Foreground | 1.19 s | 0/26 | Held/resumed; Stop held after restore |
| Local Docs event sink | Switched away | 22.96 s | 23/26 | Held/resumed; Stop held after restore |
| Local Docs event sink | Minimized | 9.85 s | 10/26 | Held/resumed; Stop held after restore |
| **Real Google Docs** | **Foreground** | **Not tested** | — | **Pending** |
| **Real Google Docs** | **Switched away** | **Not tested** | — | **Pending** |
| **Real Google Docs** | **Minimized** | **Not tested** | — | **Pending** |

Elapsed time includes the state transition. macOS's minimize animation allowed
more characters through before the document became hidden; the minimized rows
do **not** represent all 26 characters typed while hidden. The longest inter-input
gaps were about 42 ms in foreground, and 1.00–1.37 s in hidden cases. Pause and
Stop were checked against exact fixture text and position after a 1.4 s hold;
Stop was also checked 0.6 s after restoration. Command response times varied;
the baseline's slowest pause response was 243 ms and slowest Stop response 124 ms.
These are observations from one short run, not latency guarantees.

**Replay limitations:** later attempts exposed intermittent CDP session loss and
one requested minimization that left the document visible/focused. Those runs
failed; they were not counted as successful minimized typing. The exploratory
baseline sent content-script commands by evaluating in the service worker. The
final harness uses the real extension runtime message path from an extension-page
tab so an idle MV3 worker can wake normally, waits for restoration, and fails if
visibility does not match or changes during delivery. CDP/session and macOS
window-state stability remain fixture limitations. Do not describe this matrix
as consistently reproduced, or use a partial/failed replay to fill a Docs row.

A final bounded replay through the extension runtime path passed all six cases
with visibility held through delivery: native foreground/switched/minimized took
2.05/25.02/10.80 s; the local event sink took 1.20/23.77/10.74 s. Exact output,
26/26 progress, and the same pause/resume/Stop observations passed. This successful
replay does not erase the intermittent fixture failures above.

No separate engine defect was established by these measurements. The observed
hidden-page slowdown is consistent with timer throttling; the safe response in
this change is to communicate the limit and preserve an executable investigation.

## Live Google Docs runbook (still required)

1. Load the candidate extension in a disposable Chrome profile and open a new
   disposable document with an authorized account. Record extension commit,
   Chrome version from `chrome://version`, OS version, and relevant Memory Saver
   and Energy Saver settings. Keep the real document's content as the oracle;
   the extension's progress only counts attempted delivery on canvas editors.
2. With typos disabled and a fixed speed, type the exact 26-character source
   above into an empty document. Copy or export its plain text after the run and
   compare characters, order, line breaks, duplication, and missing text. Record
   start/end wall time and the extension's final position/total/error.
3. Repeat from an empty document, switching to an unrelated tab after the first
   few characters. Remain away until the run finishes or a recorded timeout;
   preserve partial output and progress rather than treating it as success.
4. Repeat from an empty document, minimizing Chrome instead. Record whether the
   document was still receiving text, stalled, or resumed on restoration.
5. For each state, run a longer known source. Pause and record both document
   text and progress before/after an observation interval, resume and confirm
   continued text, then Stop. Observe while hidden and after restoring the tab
   to check for delayed characters. A routed command in a harness does not prove
   the user can invoke the real toolbar/floating controls while minimized; record
   the actual control path (including the Stop shortcut if installed).
6. Include a separate run hidden for more than five minutes and a separate
   Memory Saver/frozen/discarded-page check. Record these as distinct conditions;
   a short hidden-tab run cannot establish long-duration behavior. Do not infer
   operation during browser shutdown, computer sleep, or power-off.
7. Repeat on each OS/Chrome combination to be claimed, and record failures or
   unsupported states. Never replace an untested Docs row with a local fixture
   pass. Attach the measured output and timings before closing #14.

## Why a background speed guarantee is unsafe

`PasteTyper.sleep()` uses `setTimeout`; the loop waits for each delay before
dispatching the next character. Chrome documents hidden-page timer batching and
more intensive throttling under prolonged hidden/silent conditions. It also
documents suspension/discarding of background pages. These browser policies can
delay or prevent the next character even when the extension's state still says
typing. An extension progress response is therefore not proof of steady typing
or of accepted Google Docs document content.

Sources: [Chrome timer throttling](https://developer.chrome.com/blog/timer-throttling-in-chrome-88/)
and [Page Lifecycle API](https://developer.chrome.com/docs/web-platform/page-lifecycle-api).
The local test measures current behavior; the documented scheduling policies are
context, not a substitute for a live Docs result. This change does not add
keepalive audio, permissions, busy loops, or an attempted throttling bypass.
