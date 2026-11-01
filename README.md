# Trunk Classic

A classic text-mode trunk tracker view for [Trunk Recorder Pro](https://github.com/TrunkRecorder/trunk-recorder-pro):
a monospace screen of each site's control channel, the channels in use, talkgroups, radios and
their affiliations, recorded calls, neighboring sites, patches, and the control channel's
messages scrolling by.

Made for Trunk Recorder Pro 0.2.6 and later.

It is an [interface](https://github.com/TrunkRecorder/trunk-recorder-pro/blob/main/docs/interfaces/README.md):
static files, no build step, listen access only. It changes nothing on the recorder.

## Install it

```bash
trunk-pro interface install taclane/trunk-classic
```

That installs the latest release and serves it on the next free port, with listen access. To run
it from a copy of this repository instead:

```bash
trunk-pro --ui trunk-classic/interface          # this run only
trunk-pro interface add trunk-classic/interface  # or keep it
```

Or **Interfaces → Add a folder…** in the recorder's own interface.

`?system=<shortName>` opens a system, `?show=channels,events,groups` the panes shown (on a narrow
screen, `?tab=<pane>` the one pane). The address keeps up as you change them, so each browser
window keeps its own: open two and show different panes in each.

## The screen

| Pane | What | From |
|---|---|---|
| Sites (top) | Each site: modulation, WACN, SYS, RFSS-SITE, NAC, control channel, messages a second and the share decoded over the last 5 s, calls now, calls recorded | `status`, ~2/s |
| Channels | Every frequency a call was followed on since the page opened, and the control channels: what's on it now (talkgroup, unit, slot, recording / encrypted / ignored…), hits, SNR, last seen | `status` calls + `decodeDetail` |
| Events | The control channel's messages as they come, filtered by kind: grants, updates, units (registration, affiliation, location…), patches, site, undecoded, the recorder's own lines; a line repeated within 2 s is counted on the first (`×2`) | `subscribe log` |
| Groups | Talkgroups heard in the last 1 h – 7 d: radios affiliated, calls, airtime, encryption and cipher, unlisted / ignored / new; those on the air now lit | `radioQuery talkgroups` and `units`, polled (below) |
| Users | Radios heard: alias, affiliated talkgroup and since when, registered, transmissions, airtime, the talkgroups they use; those talking now lit | `radioQuery units`, polled (below) |
| Calls | Recorded calls of the system; click one to play it (when the recorder keeps audio) | `history` + `concluded` |
| Neighbors | Adjacent sites each control channel announces; the ones being followed lit | `decodeDetail` |
| Patches | Patches standing now | `decodeDetail` |

On a wide screen Channels and Events are on the left, one above the other, and one of the rest is
on the right. `1`–`7` (or the buttons along the top) show and hide them: `1` and `2` Channels and
Events, `3`–`7` the pane on the right, and the one shown again to hide it. Drag the dividers to
resize (double-click one to even it up). On a narrow screen every pane is a tab.

**COLS** on a table, or a right-click on its headings, chooses its columns. HEX on Groups starts
hidden.

Colors: green recording, yellow monitored (not recorded), magenta encrypted, red emergency,
blue control channel, gray idle. A `+` before a talkgroup or radio: first heard in the last 24 hours.

## Keys

`1`–`7` show / hide panes · `/` filter the tables · `Esc` clear it · `L` live audio of the system ·
`Space` pause the events · click a heading to sort.

The filter applies to every pane shown: type a talkgroup to follow it through Channels, Events and
Groups at once.

The system, panes, divider positions, columns, sort, event kinds and time range are remembered in
the browser.

## Limits

- Groups and Users are asked for again when something they show changes (a call ends, a radio
  registers, affiliates or moves), at most every 3 s and at least every 30 s, so they can be up to
  3 s behind. The radios Groups needs for AFF alone are asked for every 15 s. The event log and
  channels are live.
- AFF counts only the radios heard in the time range Groups shows.
- ENC% is over every call the recorder has kept of the talkgroup, not just the time range. CIPHER
  is named only for a talkgroup at least 5% encrypted.
- Channels are only those the recorder followed a call on, without channel numbers (LCN).
- Event times are the browser's clock lined up with the recorder's, to within a second or so.

## Releasing

Move the changes under Unreleased in `CHANGELOG.md` to a `## [<version>]` heading, set the version in `interface/interface.json`, then push a tag `v<version>`. The release
workflow packages `interface/` (`.github/package.sh`) and attests the files.

## License

MIT.
