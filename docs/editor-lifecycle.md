# Editor AI lifecycle

`src/ai-lifecycle.ts` owns in-flight AI work; React mirrors its phase for rendering.
The editor's document ID and revision independently guard the input snapshot.
A request must still own the lifecycle **and** match that snapshot before it can
apply a result. Snapshot equality alone is insufficient when two requests target
the same unchanged paragraph.

## Transitions

- Idle → detecting: automatic detection or an explicit retry starts.
- Detecting → detecting: a newer check aborts and replaces the old check.
- Idle/detecting → generating: running a request cancels detection and locks editing.
- Generating → generating: additional run or detection actions are ignored.
- Detecting/generating → idle: only the current owner can finish.
- Any phase → idle: cancellation revokes ownership synchronously before aborting I/O.

Stop and Escape restore editing and clear the preview immediately. The cancelled
request's catch/finally handlers cannot clear a newer preview, unlock a newer run,
show an obsolete error, or replace the draft. Generation rechecks ownership after
classification, each stream read, and the lazy Markdown import. Incomplete output
is never inserted. Detection checks ownership before updating connection errors.

## Editor boundaries

Typing, switching drafts or modes, changing X context, and explicit Undo/Redo
clear detection. Moving to another paragraph also invalidates pending detection;
returning to that paragraph does not revive the earlier request. Movement within
the same paragraph preserves its check. The deferred Enter classification checks
that auto-detection is still enabled, no generation has started, and the submitted
paragraph/document revision still matches.

Draft/mode switches remain disabled during generation. After Stop they are
immediately available, and old responses cannot alter the newly selected draft.
Switching documents creates a fresh ProseMirror history. Accepted AI output is
bounded by history barriers so one Undo restores the prior draft and Redo restores
the accepted output. Prompt bookkeeping for X mode remains separate from history,
so restoring an instruction with Undo does not accidentally copy it into a post.

Unmount aborts the active request and the initial health check. Health-check
callbacks from a disposed effect cannot overwrite the current connection status.

## Verification

- `tests/ai-lifecycle.test.mjs`: ownership, replacement, duplicate actions,
  synchronous cancellation, abort-listener ordering, and obsolete finalizers.
- `scripts/ai-lifecycle-check.js`: isolated mocked browser regression for Stop,
  immediate retry, late response/rejection, Undo/Redo, and mode/history isolation.
  Its synthetic fetch deliberately ignores abort, verifies the cancelled request
  remains pending during the retry, then releases it. Cursor away/back checks
  also release obsolete detection success and quota errors without changing the
  document revision. No API request leaves the isolated page.
- Existing browser suites cover automatic classification, edits during detection,
  failed/incomplete generation, and prompt bookkeeping.

Browser suites require the repository's verified stable Chrome setup and sandbox.
A missing or unverified browser must be reported, not bypassed.
