# Between interface

The front door introduces the writing workflow before showing the editor. The warm paper, forest ink, Lora headings, and locally hosted DM Sans UI continue into the editor and saved references. The generated mark appears in the top-left home link on every page. See `public/images/ASSETS.md` for artwork provenance.

## Spacing and accessibility

`src/design-system.css` defines a 4px base rhythm with 8, 12, 16, 24, 32, 48, 64, 80, and 96px steps. Related controls use smaller gaps; sections use larger ones. Controls have at least 44px height, icon controls have 44×44px targets, important labels have a 13–16px floor, and forms use 16px input text. Mobile layouts stack without clipping reference text. Keyboard focus, reduced motion, and meaningful navigation landmarks are retained.

This implementation draws on Apple's [Layout](https://developer.apple.com/design/human-interface-guidelines/layout), [Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility), and [Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons) guidance: alignment, grouping, adaptable layout, clear hierarchy, readable text, and usable hit regions. The 4px rhythm is our own design choice. Apple does not certify this website or require a universal 8px web grid.

## Routes and data

- `#/` introduces the product; no editor is mounted until its first visit.
- `#/editor` retains its mounted editor after leaving. Drafts are flushed immediately on navigation; undo history and unfinished manual-reference entry remain in memory. Hidden workspaces cancel AI and reference requests and close modal dialogs. Stale completions cannot modify the draft.
- `#/bookmarks` saves explicit references in `between.bookmarks.v1`. It does not import X bookmarks. Text-only, link-only, or combined references are supported. Opening one creates a new X draft without replacing an existing draft.
- Bookmark removal offers Undo for each removal during the current session. Invalid or inaccessible bookmark storage pauses writes without replacing the original; original readable bytes can be downloaded. A concurrent tab change is detected before writing. Draft storage remains in its existing keys and format.

Bookmarked source text is rendered in full. References are not trusted instructions. External links are normalized X post URLs. Drafts and bookmarks are saved locally, but AI edits and auto-detection send context to OpenAI when configured. Marketing copy states that boundary and never promises zero data transmission.

## Verification

Unit checks cover bookmark round trips, link-only references, 60,000-character text, malformed or inaccessible storage, duplicate identifiers, unsafe URLs, concurrent writes, and remove/restore. Browser fixtures cover navigation, preservation, cancellation, bookmark workflows, responsive layouts, and accessibility without real provider calls. Browser verification requires the project's verified, sandboxed stable Chrome; a successful build alone is not visual verification.
