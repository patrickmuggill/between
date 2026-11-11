# Interaction and design review

This pass follows Emil Kowalski's public [emil-design-eng skill](https://github.com/emilkowalski/skills/blob/main/skills/emil-design-eng/SKILL.md), read on November 11, 2026.

The existing paper-and-sage palette, Lora/DM Sans typography, quiet controls, and full reference text are retained. The priority is predictable editing rather than adding decoration to a frequently used writing surface.

| Before | After | Why |
| --- | --- | --- |
| Clicking empty space inside OpenAI settings dismissed it | Only actual pointer clicks outside the modal dismiss it | Padding is part of the dialog, not its backdrop |
| Closing and reopening reference entry replaced unfinished edits with saved text | Text and author edits survive the toggle | Temporary dismissal should not destroy work |
| Manual entry opened without intentional focus placement | Opening focuses the text; saving returns focus to its trigger | Keyboard users retain their place |
| Title focus was suppressed; textarea and disclosure had inconsistent focus styling | Shared visible focus treatment | Quiet visual design still needs a clear keyboard path |
| Every button press scaled, including keyboard and reduced-motion users | Pointer feedback uses a short custom easing; keyboard/reduced-motion presses remain still | Frequent writing interactions should feel immediate |
| Small touch inputs and tiny secondary targets | Touch inputs are at least 16px; key targets are at least 44px | Avoid mobile input zoom and improve tapping accuracy |
| Long reference column used sticky positioning | Reference remains in normal document flow | Keep the full source reachable without an inner scroller |
| Copy confirmation disappeared at tablet widths | Confirmation wraps below the actions | Feedback should remain visible across breakpoints |

## Verification

- Pure dialog-boundary regression tests cover padding, content, borders, keyboard clicks, and clicks outside all four edges.
- `scripts/interaction-check.js` exercises modal dismissal, manual-reference preservation, focus return, touch input sizes, and mobile overflow using synthetic fixtures and isolated browser storage.
- Run the browser suite only through the verified stable-Chrome runner with its sandbox enabled. A compiled build and unit tests do not replace browser verification or visual review.
