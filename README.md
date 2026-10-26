# Trunk Classic

A classic text-mode trunk tracker view for [Trunk Recorder Pro](https://github.com/TrunkRecorder/trunk-recorder-pro):
a monospace screen of each site's control channel, the channels in use, talkgroups, radios and
their affiliations, recorded calls, neighbouring sites, patches, and the control channel's
messages scrolling by.

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

`?system=<shortName>` opens a system, `?tab=<pane>` a pane (`groups`, `users`, `calls`,
`neighbors`, `patches`; on a narrow screen also `channels`, `events`).

## The screen

| Pane | What | From |
|---|---|---|
| Sites (top) | Each site: modulation, WACN, SYS, RFSS-SITE, NAC, control channel, messages a second and the share decoded over the last 5 s, calls now, calls recorded | `status`, ~2/s |
| Channels | Every frequency a call was followed on since the page opened, and the control channels: what's on it now (talkgroup, unit, slot, recording / encrypted / ignored…), hits, SNR, last seen | `status` calls + `decodeDetail` |
| Events | The control channel's messages as they come, filtered by kind: grants, updates, units (registration, affiliation, location…), patches, site, undecoded, the recorder's own lines | `subscribe log` |
| Groups | Talkgroups heard in the last 1 h – 7 d: calls, airtime, encryption and cipher, unlisted / ignored / new; those on the air now lit | `radioQuery talkgroups`, polled every 3 s |
| Users | Radios heard: alias, affiliated talkgroup and since when, registered, transmissions, airtime, the talkgroups they use; those talking now lit | `radioQuery units`, polled every 3 s |
| Calls | Recorded calls of the system; click one to play it (when the recorder keeps audio) | `history` + `concluded` |
| Neighbors | Adjacent sites each control channel announces; the ones being followed lit | `decodeDetail` |
| Patches | Patches standing now | `decodeDetail` |

On a wide screen Channels and Events stay on the left and the rest are tabs on the right; on a
narrow one every pane is a tab.

Colours: green recording, yellow monitored (not recorded), magenta encrypted, red emergency,
blue control channel, grey idle.

## Keys

`1`–`7` panes · `/` filter the table · `Esc` clear it · `L` live audio of the system ·
`Space` pause the events · click a heading to sort.

The system, pane, sort, event kinds and time range are remembered in the browser.

## Limits

- The polled tables are up to 3 s behind; the event log and channels are live.
- Channels are only those the recorder followed a call on, without channel numbers (LCN).
- Event times are the browser's clock lined up with the recorder's, to within a second or so.

## Releasing

Set the version in `interface/interface.json`, then push a tag `v<version>`. The release
workflow packages `interface/` (`.github/package.sh`) and attests the files.

## License

MIT.
