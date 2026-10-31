# API notes

What Trunk Classic would want from the Trunk Recorder Pro interface API (api 1, recorder 0.2.6),
found while building it against CLMRN. Most wanted first. Each is additive: new optional
fields or topics, so `api` can stay 1.

## 1. Structured control channel log lines

`LogLine` is `{ timeS, kind, text, system, site }`. The unit, talkgroup, frequency, slot and flags
exist only inside `text` ("Grant TG 301 771.35625 MHz src 1819332 slot 0 ENC"). Plugins already
get them structured (`UnitEvent`, built at `crates/trunk-app/src/session.rs:880`); the log line
pushed three lines below at `session.rs:888` has the same `m` in hand.

Want: optional `unit`, `target` (unit-to-unit), `talkgroup`, `freqHz`, `slot`, `encrypted`,
`emergency` on the decoder's lines.

Would give: affiliations, registrations and channel occupancy the instant they're heard, with no
polling and no parsing of text meant for people. Today Users/Groups lag up to 3 s, and channels
only learn of a grant once the recorder follows it.

## 2. Wall-clock time on decoder log lines

The decoder's lines carry `timeS` (seconds into the recording) only; the recorder's own lines
have `time` (Unix s). An interface converts with `Date.now()/1000 − status.nowS` from the latest
`status`, which folds in the browser's clock error and the message's delay.

Want: `time` (Unix s) on every log line, or `status.startedAt` (Unix s) so `timeS` converts
exactly.

## 3. Registry changes pushed, not polled

`radioQuery units` / `talkgroups` returns whole tables. Polling them every 3 s on one busy system is ~490
units and ~40 talkgroups an hour: 113 KB a poll for units (495 rows) and 15 KB for talkgroups,
measured, mostly unchanged from the last.

Want, in order of effort:
- `radioQuery … since: <Unix s>`: only rows whose `last` (or `affT`) is newer. Cheap; polling
  stays but costs little.
- A topic `registry:<shortName>`: `registryDelta { units: UnitRow[], tgs: TgRow[] }` once a
  second with the rows that changed.

## 4. Channel identity and the full channel table

A P25 channel is known only by frequency: no IDEN/channel number ("1-0123"), and `decodeDetail`
lists only the frequencies being watched now. DMR and NXDN already expose `lcn` / `channel`.

Want: `channel` (P25 `iden-chan`) on `CallView` and in `decodeDetail.channels`; each site's IDEN
table (base, step, bandwidth, TDMA slots), already decoded ("IDEN 3: base 762.00625 MHz…" in the
log); and every channel the control channel has granted, followed or not.

## 5. Secondary control channels, structured

Heard only as text: "Secondary CC rfss 3 site 13: 771.78125 MHz". Want `secondary: number[]`
(Hz) on `SiteStatus` or `SiteDetail`.

## 6. Affiliation counts per talkgroup, in bulk

`radioQuery tg` gives one talkgroup's `affiliated` radios; there's no count across all
talkgroups. Want `affiliated: number` on `TgRow`, for an AFF column on Groups.

Today Groups counts them from the `units` rows, so it polls the units table even when Users isn't
shown, and counts only the radios heard in the time range.

## 7. Per-system call history

`history` is the newest 300 calls across every system, and `olderCalls` has no system filter. On
a recorder with several busy systems one system's Calls pane starts nearly empty. Want
`olderCalls { system? }`.

## 8. Noise worth taming at the source

- A self-patch ("Moto patch add sg 1366: 1366 1366 1366") comes several times a second on
  clmrn-G. `decodeDetail.patches` rightly leaves it out, but the log carries each repeat. A repeat
  count, or one line per change, would keep `patch_add` readable.
- Base station ID lines have an empty callsign ("Base station ID  853.75000 MHz").

## Side finding: a control-access greeting logs device errors

Each control-access connection's greeting lists RTL-SDR dongles (`devices`,
`crates/trunk-pro/src/server.rs:569`), and `Device::list()` (`sdr.rs:47`) opens each one to read
it. While recording, every claimed dongle answers "interface is busy (errno 16)", logged at error level and sent to
every connection as a `log` line: four lines per connection with four dongles, ~716 in six hours from the
built-in interface's reconnects. Listen-access interfaces don't trigger it (their greeting has no
`devices`), but they do receive the error lines. Skip claimed devices when listing, or log it at
debug.
