# Changelog

## [0.2.1]

- Events: a line the control channel repeats within 2 s is counted on the first (`×2`) instead of
  drawn again.
- Groups and Users are polled when something they show changes, at most every 3 s and at least
  every 30 s, instead of every 3 s regardless.
- With Groups shown and Users not, the radios (for AFF) are polled every 15 s, not every 3 s.
- US spelling throughout (neighboring, colors, gray).

## [0.2.0]

- Groups: an AFF column, the radios affiliated to each talkgroup.
- Groups: CIPHER names the cipher a talkgroup's encrypted calls mostly use, and only for a
  talkgroup at least 5% encrypted, not one with a stray encrypted call.
- `1`–`7` show and hide panes on a wide screen: Channels and Events can be hidden, and the pane
  on the right too (choose it again). The panes shown are kept in the address, so two windows can
  show different ones.
- Draggable dividers between the left and right, and between Channels and Events.
- COLS on each table (or a right-click on its headings) chooses its columns. HEX on Groups starts
  hidden.
- The filter applies to every pane shown, Events included.
- ENC% under 1 shows as `<1`, not `0`.
- `L` does nothing until a system is chosen (it would have played every system).
- Channels idle for 6 hours are dropped from the Channels pane.
- The footer explains the `+` before a new talkgroup or radio.
- API-NOTES.md: what the interface would want from the recorder's API.

## [0.1.0]

- The first release.
