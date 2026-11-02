# Changelog

## [0.2.2]

- Needs Trunk Recorder Pro 0.3.0 or later (it was 0.2.6).
- A conventional system gets a row in the sites table (its channels open now, calls and
  recordings) instead of an empty table.
- A conventional system's Channels lists every channel in its config, idle ones too, with HITS
  and SEEN from its recorded calls.
- Channels: a CODE column, a conventional channel's code: the one it's set to record, else the
  codes heard on it, else its latest call's NAC.
- Calls asks the recorder for the system's own latest 300 calls, so a quiet
  system's list isn't crowded out by a busy one's.
- A conventional system chosen in the address stays chosen while the recorder's first status is on
  its way.
- The Groups and Users titles count the rows when the recorder sends no total, instead of
  `OF undefined`.
- SYSTEM has ALL (with more than one system): every system at once, each table with a SYSTEM
  column, and `L` playing every system's calls. `?system=*` opens it.
- Screenshots of this version.

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
