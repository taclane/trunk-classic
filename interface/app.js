// Trunk Classic: a text-mode trunk tracker view over the Trunk Recorder Pro API.
// Live state comes from `status` (2/s) and `decodeDetail`; the talkgroup and
// radio tables are polled from the radio registry (`radioQuery`) every few
// seconds. See API-NOTES.md for what a push would do better.
import { TrunkClient, LivePlayer, escapeHtml as esc } from "/api/client.js";

// The registry tables are asked for again when something they show has changed
// (a call ended, a radio registered or affiliated…), at most every POLL_MIN_MS,
// and at least every POLL_IDLE_MS. Radios wanted only for Groups' AFF: less often.
const POLL_MIN_MS = 3000;
const POLL_AFF_MS = 15000;
const POLL_IDLE_MS = 30000;
const POLL_TICK_MS = 1000;
// Control channel messages that change the radios table.
const UNIT_KINDS = new Set(["registration", "deregistration", "affiliation", "location"]);
const EV_KEEP = 3000; // events kept, to re-filter
const EV_SHOW = 600; // events drawn
const CHANNEL_KEEP_S = 6 * 3600; // a channel idle this long is dropped
const HOURS = [
  [1, "1 HOUR"],
  [6, "6 HOURS"],
  [24, "24 HOURS"],
  [168, "7 DAYS"],
];

// Control channel message kinds (LogLine.kind), grouped as the event filter shows them.
const KIND_GROUPS = [
  ["grant", "GRANTS", ["grant", "uu_v_grant", "phone_grant", "data_grant", "deny", "queued", "uu_ans_req"]],
  ["update", "UPDATES", ["update", "uu_v_update", "phone_update"]],
  ["unit", "UNITS", ["registration", "deregistration", "affiliation", "location", "acknowledge", "call_alert", "status_update", "message_update", "emergency_alarm"]],
  ["patch", "PATCHES", ["patch_add", "patch_delete"]],
  ["site", "SITE", ["sysid", "status", "adjacent", "control_channel", "base_station_id", "control"]],
  ["raw", "UNDECODED", ["unknown"]],
  ["rec", "RECORDER", []], // everything else: the recorder's own lines
];
const KIND_GROUP = new Map(KIND_GROUPS.flatMap(([g, , kinds]) => kinds.map((k) => [k, g])));
const kindGroup = (kind) => KIND_GROUP.get(kind) ?? "rec";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`trunk-classic.${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`trunk-classic.${k}`, JSON.stringify(v));
    } catch {}
  },
};

// The panes: channels and events on the left, one of the others on the right.
const LEFT = ["channels", "events"];
const RIGHT = ["groups", "users", "calls", "neighbors", "patches"];
const PANES = [...LEFT, ...RIGHT]; // keys 1-7
// Columns hidden until someone shows them.
const DEFAULT_HIDDEN = { groups: ["hex"] };

const rec = new TrunkClient();
const player = new LivePlayer({ onNowPlaying: () => mark("header") });

const params = new URLSearchParams(location.search);
const ui = {
  system: params.get("system") ?? store.get("system", null),
  tab: params.get("tab") ?? store.get("tab", "groups"), // the one pane on a narrow screen
  show: initialShow(), // the panes on a wide one: { channels, events, right }
  hidden: store.get("hidden", DEFAULT_HIDDEN), // pane → column keys

  hours: store.get("hours", 1),
  kinds: new Set(store.get("kinds", ["grant", "unit", "rec"])),
  sort: store.get("sort", {}),
  filter: "",
  paused: false,
  listening: false,
};

// ?show=channels,users from the address (so each window keeps its own), else as last left.
function initialShow() {
  const list = params.get("show");
  if (list != null) {
    const xs = list.split(",");
    return { channels: xs.includes("channels"), events: xs.includes("events"), right: RIGHT.find((r) => xs.includes(r)) ?? null };
  }
  const saved = store.get("show", { channels: true, events: true, right: "groups" });
  const tab = params.get("tab");
  return RIGHT.includes(tab) ? { ...saved, right: tab } : saved;
}

// What we know of the system shown; reset when it changes.
let S = fresh();
function fresh() {
  return {
    channels: new Map(), // `${system}|${freqHz}/${slot}` (conventional: `…/conv`) → channel row
    calls: new Map(), // system → its latest calls (callsQuery), beside the history
    rates: new Map(), // `${system}|${site}` → recent { t, good, bad } samples
    detail: {}, // system → decodeDetail
    tgs: new Map(), // system → { rows, total } (radioQuery talkgroups; each row's `sys` added)
    units: new Map(), // system → { rows, total } (radioQuery units)
    polled: {}, // what → when last asked (ms)
    stale: {}, // what → something it shows has changed since
    active: { tgs: new Map(), units: new Set(), key: "" }, // `${system}|${tg}` → call, `${system}|${unit}`
    events: [],
  };
}

// The shown systems' rows of a registry table, and their total; rows null until any came.
function reg(by) {
  if (!by.size) return { rows: null, total: 0 };
  const xs = [...by.values()];
  return { rows: xs.flatMap((x) => x.rows), total: xs.reduce((a, x) => a + x.total, 0) };
}

// Engine seconds (LogLine.timeS, CallView.startS) → Unix seconds, from the latest status.
let offset = null;
const wall = (engineS) => (offset == null ? null : engineS + offset);

// ── Formatting ────────────────────────────────────────────────────────────

const fmhz = (hz) => (hz ? (hz / 1e6).toFixed(5) : "");
const hex = (n, w) => (n == null ? "" : n.toString(16).toUpperCase().padStart(w, "0"));
const pad0 = (n, w = 2) => String(n).padStart(w, "0");
const hms = (unixS) => {
  if (unixS == null) return "";
  const d = new Date(unixS * 1000);
  return `${pad0(d.getHours())}:${pad0(d.getMinutes())}:${pad0(d.getSeconds())}`;
};
const ago = (unixS) => {
  if (!unixS) return "";
  const s = Math.max(0, Date.now() / 1000 - unixS);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${pad0(Math.floor((s % 3600) / 60))}`;
  return `${Math.floor(s / 86400)}d`;
};
const mmss = (s) => {
  if (s == null) return "";
  const t = Math.round(s);
  return t >= 3600 ? `${Math.floor(t / 3600)}:${pad0(Math.floor((t % 3600) / 60))}:${pad0(t % 60)}` : `${Math.floor(t / 60)}:${pad0(t % 60)}`;
};
const rfssSite = (rfss, site) => (rfss == null || site == null ? "" : `${pad0(rfss, 3)}-${pad0(site, 3)}`);
const tgName = (tg, sys = ui.system) => rec.talkgroups(sys).get(tg)?.alphaTag ?? "";
const unitName = (u, sys = ui.system) => (u == null ? "" : rec.unitName(sys, u));

// "All": every system at once, each row saying whose it is.
const ALL = "*";
const mine = (name) => ui.system === ALL || name === ui.system;
// Every system: the ones being recorded (conventional ones last), else the config's.
const sysNames = () =>
  rec.status?.systems?.length ? rec.status.systems.map((s) => s.shortName) : [...(rec.config?.systems ?? []), ...(rec.config?.conventional ?? [])].map((s) => s.shortName);
// The systems shown.
const chosen = () => (ui.system === ALL ? sysNames() : ui.system ? [ui.system] : []);
const SYS_COL = (get) => ({ k: "sys", label: "SYSTEM", all: true, get, find: true });

// ── Tables ────────────────────────────────────────────────────────────────

const cmp = (a, b) => {
  if (a == null || a === "") return b == null || b === "" ? 0 : 1;
  if (b == null || b === "") return -1;
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
};

// cols: { k, label, num?, cls?, get(row) (what sorts and filters), show?(row) (text drawn), find? (filtered on) }
function drawTable(pane, el, cols, rows, opts = {}) {
  cols = cols.filter((c) => !c.all || ui.system === ALL);
  colsOf[pane] = cols;
  const all = cols;
  const off = hiddenOf(pane);
  cols = cols.filter((c) => !off.has(c.k));
  if (!cols.length) cols = all;
  const s = ui.sort[pane] ?? opts.sort;
  if (s) {
    const c = all.find((c) => c.k === s.k);
    if (c) rows = [...rows].sort((a, b) => cmp(c.get(a), c.get(b)) * s.dir);
  }
  const f = ui.filter;
  if (f) rows = rows.filter((r) => cols.some((c) => c.find && String(c.show ? c.show(r) : c.get(r) ?? "").toLowerCase().includes(f)));
  const head = cols
    .map((c) => {
      const cls = [c.num && "num", s?.k === c.k && (s.dir > 0 ? "asc" : "desc")].filter(Boolean).join(" ");
      return `<th data-k="${c.k}" class="${cls}">${c.label}</th>`;
    })
    .join("");
  const body = rows
    .map((r) => {
      const tds = cols.map((c) => `<td class="${[c.num && "num", c.cls?.(r)].filter(Boolean).join(" ")}">${esc(c.show ? c.show(r) : c.get(r) ?? "")}</td>`).join("");
      return `<tr class="${opts.rowClass?.(r) ?? ""}"${opts.rowAttr?.(r) ?? ""}>${tds}</tr>`;
    })
    .join("");
  el.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body || `<tr class="empty"><td colspan="${cols.length}">${esc(f ? "Nothing matches the filter." : opts.empty ?? "")}</td></tr>`}</tbody>`;
  return rows.length;
}

const DEFAULT_SORT = {
  channels: { k: "freq", dir: 1 },
  groups: { k: "last", dir: -1 },
  users: { k: "last", dir: -1 },
  calls: { k: "time", dir: -1 },
};

// A click on a heading sorts by it (again: the other way); a right-click chooses the columns.
for (const id of ["channels", "groups", "users", "calls", "neighbors", "patches"]) {
  $(id).addEventListener("contextmenu", (ev) => {
    if (!ev.target.closest("th")) return;
    ev.preventDefault();
    openColumns(id, ev.clientX, ev.clientY);
  });
  $(id).addEventListener("click", (ev) => {
    const th = ev.target.closest("th[data-k]");
    if (!th) return;
    const k = th.dataset.k;
    const cur = ui.sort[id] ?? DEFAULT_SORT[id];
    ui.sort[id] = { k, dir: cur?.k === k ? -cur.dir : th.classList.contains("num") ? -1 : 1 };
    store.set("sort", ui.sort);
    mark(id);
  });
}

// ── Drawing, at most every 200 ms, and only what's on screen ──────────────

const dirty = new Set();
let timer = 0;
function mark(...panes) {
  for (const p of panes) dirty.add(p);
  if (!timer) timer = setTimeout(flush, 200);
}
function flush() {
  timer = 0;
  for (const p of [...dirty]) {
    if (p !== "header" && p !== "sites" && !shown(p)) continue;
    dirty.delete(p);
    DRAW[p]?.();
  }
}

const wide = matchMedia("(min-width: 1001px)");
const shown = (pane) => (!wide.matches ? ui.tab === pane : LEFT.includes(pane) ? ui.show[pane] : ui.show.right === pane);

const DRAW = {
  header: drawHeader,
  sites: drawSites,
  channels: drawChannels,
  events: () => drawEvents(true),
  groups: drawGroups,
  users: drawUsers,
  calls: drawCalls,
  neighbors: drawNeighbors,
  patches: drawPatches,
};

function drawHeader() {
  const st = $("state");
  const phase = rec.phase.phase;
  const text = !rec.connected ? (rec.exited ? "RECORDER QUIT" : "NO CONNECTION") : phase === "running" ? "RECORDING" : phase.toUpperCase();
  st.textContent = text;
  st.classList.toggle("off", text !== "RECORDING");

  const np = player.nowPlaying;
  const npSys = typeof np?.system === "number" ? rec.status?.systemNames?.[np.system] : np?.system ?? ui.system;
  $("now").textContent = ui.listening ? (np ? `▶ ${ui.system === ALL && npSys ? `${npSys} ` : ""}TG ${np.talkgroup} ${tgName(np.talkgroup, npSys)}` : "▶ WAITING FOR A CALL") : "";

  const names = sysNames();
  const sel = $("system");
  if (sel.dataset.names !== names.join("\n")) {
    sel.dataset.names = names.join("\n");
    sel.innerHTML = names.map((n) => `<option>${esc(n)}</option>`).join("") + (names.length > 1 ? `<option value="${ALL}">ALL</option>` : "");
    if (ui.system === ALL) subscribe(), fetchCalls(); // the systems "All" means are known now
  }
  if (names.length && !(ui.system === ALL ? names.length > 1 : names.includes(ui.system))) setSystem(names[0]);
  sel.value = ui.system ?? "";
}

function drawSites() {
  const systems = (rec.status?.systems ?? []).filter((s) => mine(s.shortName));
  const el = $("sites");
  if (!systems.length) {
    el.innerHTML = `<tbody><tr class="empty"><td>${esc(rec.connected ? (rec.phase.phase === "running" ? "This system isn't being recorded." : "Not recording: nothing on the air to follow.") : "Waiting for the recorder…")}</td></tr></tbody>`;
    return;
  }
  const head = ["SITE", "MOD", "WACN", "SYS", "RFSS-SITE", "NAC", "CONTROL", "MSG/S", "DEC%", "CALLS", "RECORDED"];
  const num = new Set(["MSG/S", "DEC%", "CALLS", "RECORDED"]);
  const rows = systems.flatMap((sys) => siteRows(sys, head));
  el.innerHTML = `<thead><tr>${head.map((h) => `<th class="${num.has(h) ? "num" : ""}">${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody>`;
}

function siteRows(sys, head) {
  const rows = sys.sites.map((s) => {
    const r = siteRate(`${sys.shortName}|${s.name}`);
    const id = s.identity;
    const decCls = r.pct == null ? "" : r.pct < 90 ? "bad" : r.pct < 98 ? "warn" : "";
    const cells = [
      [s.name],
      [s.modulation ?? ""],
      [hex(id.wacn, 5)],
      [hex(id.sysId, 3)],
      [rfssSite(id.rfss, id.site)],
      [hex(id.nac, 3)],
      [s.controlChannelHz ? fmhz(s.controlChannelHz) : "HUNTING", s.controlChannelHz ? "" : "bad"],
      [r.mps == null ? "" : r.mps.toFixed(1), "num"],
      [r.pct == null ? "" : r.pct.toFixed(1), `num ${decCls}`],
      [s.activeCalls, "num"],
      [s.callsConcluded, "num"],
    ];
    const warn = s.mismatch ? `<tr class="emerg"><td colspan="${head.length}">  ${esc(s.mismatch)}</td></tr>` : "";
    return `<tr>${cells.map(([v, c]) => `<td class="${c ?? ""}">${esc(v)}</td>`).join("")}</tr>${warn}`;
  });
  // A conventional system has no sites: one row for its channels.
  if (!sys.sites.length) {
    const cells = [[sys.shortName], ["CONV"], [""], [""], [""], [""], [`${sys.conventionalOpen ?? 0} OPEN`], ["", "num"], ["", "num"], [sys.activeCalls, "num"], [sys.callsConcluded, "num"]];
    rows.push(`<tr>${cells.map(([v, c]) => `<td class="${c ?? ""}">${esc(v)}</td>`).join("")}</tr>`);
  }
  return rows;
}

// Messages a second and the share decoded, over the last ~5 s of status.
function siteRate(key) {
  const xs = S.rates.get(key) ?? [];
  if (xs.length < 2) return { mps: null, pct: null };
  const a = xs[0],
    b = xs[xs.length - 1];
  const good = b.good - a.good,
    bad = b.bad - a.bad,
    dt = b.t - a.t;
  if (dt <= 0 || good < 0 || bad < 0) return { mps: null, pct: null };
  return { mps: (good + bad) / dt, pct: good + bad ? (100 * good) / (good + bad) : null };
}

const STATE = { encrypted: "ENC", ignored: "IGN", unknown_tg: "UNK", no_source: "NOSRC", no_recorder: "NOREC" };

// A conventional system's config, or none.
const convOf = (name) => (rec.config?.conventional ?? []).find((c) => c.shortName === name);

// A conventional system's channels from its config, listed idle until heard.
function seedConventional(conv) {
  const name = conv.shortName;
  for (const row of conv.channels ?? []) {
    if (row.enabled === false) continue;
    const key = `${name}|${row.freqHz}/conv`;
    const ch = S.channels.get(key);
    if (ch) {
      if (row.code && !ch.codes.includes(row.code)) ch.codes.push(row.code);
      continue;
    }
    S.channels.set(key, { sys: name, site: name, freq: row.freqHz, kind: (row.mode ?? "fm").toUpperCase(), conv: true, slot: null, tg: row.talkgroup, tag: row.name, name: row.name, codes: row.code ? [row.code] : [], hits: 0, snr: null, live: false, last: null });
  }
}

// Codes heard on each frequency (Hz, as a string): HeardCode[].
let heard = {};

function drawChannels() {
  const rows = [...S.channels.values()];
  const now = Date.now() / 1000;
  const names = chosen();
  const conv = names.length > 0 && names.every((n) => convOf(n));
  // A conventional channel's calls and when it was last heard, from the calls listed.
  const byFreq = new Map(); // `${system}|${freqHz}` → …
  const fk = (r) => `${r.sys}|${r.freq}`;
  if (rows.some((r) => r.conv))
    for (const e of callRows()) {
      const k = `${e.record.short_name}|${e.record.freq}`;
      const f = byFreq.get(k) ?? { n: 0, last: 0, nacT: 0 };
      f.n++;
      f.last = Math.max(f.last, e.record.stop_time ?? e.record.start_time);
      // The NAC of its latest digital call.
      if (e.record.nac && e.record.start_time > f.nacT) (f.nac = e.record.nac), (f.nacT = e.record.start_time);
      byFreq.set(k, f);
    }
  const hits = (r) => (r.conv ? (byFreq.get(fk(r))?.n ?? 0) + (r.live && !r.counted ? 1 : 0) : r.hits);
  const last = (r) => (r.conv ? Math.max(r.last ?? 0, byFreq.get(fk(r))?.last ?? 0) || null : r.last);
  // What it's set to record, else the codes heard on it lately, else its latest call's NAC.
  const code = (r) =>
    !r.conv
      ? ""
      : r.codes?.length
      ? r.codes.join(" ")
      : (heard[String(r.freq)] ?? []).toSorted((a, b) => b.lastMs - a.lastMs).map((h) => h.code).filter(Boolean).slice(0, 2).join(" ") || (byFreq.get(fk(r))?.nac ?? "");
  const n = drawTable(
    "channels",
    $("channels"),
    [
      SYS_COL((r) => r.sys),
      { k: "freq", label: "FREQ", num: true, get: (r) => r.freq, show: (r) => fmhz(r.freq), find: true },
      { k: "site", label: "SITE", get: (r) => r.site, find: true },
      { k: "kind", label: "TYPE", get: (r) => r.kind },
      { k: "slot", label: "SL", num: true, get: (r) => r.slot },
      { k: "code", label: "CODE", get: code, find: true },
      { k: "state", label: "STATE", get: (r) => (r.kind === "CC" ? "CTRL" : r.live ? (r.reason ? STATE[r.reason] ?? r.reason : "REC") : "") },
      { k: "tg", label: "TGID", num: true, get: (r) => r.tg, find: true },
      { k: "tag", label: "TAG", cls: () => "tag", get: (r) => r.tag, find: true },
      { k: "unit", label: "UNIT", num: true, get: (r) => r.unit, find: true },
      { k: "alias", label: "ALIAS", cls: () => "tag", get: (r) => unitName(r.unit, r.sys), find: true },
      { k: "hits", label: "HITS", num: true, get: hits },
      { k: "snr", label: "SNR", num: true, get: (r) => r.snr, show: (r) => (r.snr == null ? "" : r.snr.toFixed(1)) },
      { k: "seen", label: "SEEN", num: true, get: (r) => (r.live ? now : last(r)), show: (r) => (r.live ? "NOW" : last(r) ? ago(last(r)) : "") },
    ],
    rows,
    {
      sort: DEFAULT_SORT.channels,
      empty: conv ? "The config lists no channels." : "No channels yet: they're listed as the control channel grants them.",
      rowClass: (r) => (r.kind === "CC" ? "cc" : !r.live ? "idle" : r.emergency ? "emerg" : r.encrypted && !r.decrypted ? "enc" : r.reason ? "mon" : "on"),
    },
  );
  const live = rows.filter((r) => r.live && r.kind !== "CC").length;
  $("channels-sub").textContent = `${n} ${conv ? "CHANNELS" : "HEARD"} · ${live} ACTIVE`;
}

function drawGroups() {
  const sub = $("groups-sub");
  const tgs = reg(S.tgs);
  if (!tgs.rows) {
    sub.textContent = "LOADING";
    $("groups").innerHTML = "";
    return;
  }
  const units = reg(S.units).rows;
  const files = new Map(chosen().map((n) => [n, rec.talkgroups(n)]));
  const act = S.active.tgs;
  const ak = (r) => `${r.sys}|${r.tg}`;
  // Radios affiliated to each talkgroup, of those heard in the time range (registered or not known to have left).
  const aff = new Map();
  for (const u of units ?? []) if (u.aff != null && u.reg !== false) aff.set(`${u.sys}|${u.aff}`, (aff.get(`${u.sys}|${u.aff}`) ?? 0) + 1);
  const n = drawTable(
    "groups",
    $("groups"),
    [
      SYS_COL((r) => r.sys),
      { k: "tg", label: "TGID", num: true, get: (r) => r.tg, find: true },
      { k: "hex", label: "HEX", get: (r) => hex(r.tg, 4), find: true },
      { k: "tag", label: "TAG", cls: () => "tag", get: (r) => r.alphaTag, find: true },
      { k: "group", label: "CATEGORY", cls: () => "tag", get: (r) => files.get(r.sys)?.get(r.tg)?.group ?? "", find: true },
      { k: "aff", label: "AFF", num: true, get: (r) => (units ? aff.get(ak(r)) ?? 0 : null), show: (r) => (units ? aff.get(ak(r)) || "" : "") },
      { k: "calls", label: "CALLS", num: true, get: (r) => r.calls },
      { k: "secs", label: "AIR", num: true, get: (r) => r.secs, show: (r) => mmss(r.secs) },
      { k: "enc", label: "ENC%", num: true, get: (r) => r.encPct, show: (r) => (!r.encPct ? "" : r.encPct < 1 ? "<1" : r.encPct.toFixed(0)) },
      { k: "cipher", label: "CIPHER", get: cipher },
      { k: "flags", label: "FLAGS", get: (r) => [!r.known && "UNLISTED", r.ignore && "IGNORED", r.new && "NEW"].filter(Boolean).join(" ") },
      { k: "last", label: "LAST", num: true, get: (r) => (act.has(ak(r)) ? Infinity : r.last), show: (r) => (act.has(ak(r)) ? "NOW" : ago(r.last)) },
    ],
    tgs.rows,
    {
      sort: DEFAULT_SORT.groups,
      empty: "No talkgroups heard in this time.",
      rowClass: (r) => {
        const c = act.get(ak(r));
        return [c ? (c.emergency ? "emerg" : c.encrypted && !c.decrypted ? "enc" : "on") : "", r.new && "new"].filter(Boolean).join(" ");
      },
    },
  );
  sub.textContent = `${n} OF ${tgs.total}`;
}

// The cipher a talkgroup's encrypted calls mostly use. Not for one that's
// rarely encrypted: a stray call marked encrypted would name it forever.
const ENC_MIN_PCT = 5;
function cipher(r) {
  if (!(r.encPct >= ENC_MIN_PCT) || !r.ciphers?.length) return "";
  return r.ciphers.reduce((a, b) => (b.calls > a.calls ? b : a)).name;
}

function drawUsers() {
  const sub = $("users-sub");
  const units = reg(S.units);
  if (!units.rows) {
    sub.textContent = "LOADING";
    $("users").innerHTML = "";
    return;
  }
  const act = S.active.units;
  const on = (r) => act.has(`${r.sys}|${r.unit}`);
  const n = drawTable(
    "users",
    $("users"),
    [
      SYS_COL((r) => r.sys),
      { k: "unit", label: "UID", num: true, get: (r) => r.unit, find: true },
      { k: "alias", label: "ALIAS", cls: () => "tag", get: (r) => r.alias || unitName(r.unit, r.sys), find: true },
      { k: "aff", label: "AFF TG", num: true, get: (r) => r.aff, find: true },
      { k: "affTag", label: "AFF TAG", cls: () => "tag", get: (r) => (r.aff == null ? "" : tgName(r.aff, r.sys)), find: true },
      { k: "affT", label: "SINCE", num: true, get: (r) => r.affT, show: (r) => ago(r.affT) },
      { k: "reg", label: "REG", get: (r) => (r.reg == null ? "" : r.reg ? "ON" : "OFF") },
      { k: "tx", label: "TX", num: true, get: (r) => r.tx },
      { k: "txSecs", label: "AIR", num: true, get: (r) => r.txSecs, show: (r) => mmss(r.txSecs) },
      { k: "tgs", label: "TALKS ON", cls: () => "wide", get: (r) => (r.tgs ?? []).slice(0, 3).map(([tg]) => tg).join(" "), find: true },
      { k: "lastTx", label: "LAST TX", num: true, get: (r) => (on(r) ? Infinity : r.lastTx), show: (r) => (on(r) ? "NOW" : ago(r.lastTx)) },
      { k: "last", label: "SEEN", num: true, get: (r) => r.last, show: (r) => ago(r.last) },
    ],
    units.rows,
    {
      sort: DEFAULT_SORT.users,
      empty: "No radios heard in this time.",
      rowClass: (r) => [on(r) ? "on" : r.reg === false ? "idle" : "", r.new && "new"].filter(Boolean).join(" "),
    },
  );
  sub.textContent = `${n} OF ${units.total}`;
}

let playing = null; // the call path playing
// This system's calls: the history's (every system's latest) and its own latest, asked for.
function callRows() {
  const seen = new Set();
  return [...rec.history.filter((e) => mine(e.record.short_name)), ...[...S.calls.values()].flat()].filter((e) => !seen.has(e.path) && seen.add(e.path));
}

// Each system's own, so a quiet one isn't crowded out by a busy one. Sent
// directly: the client's calls() is hidden by its own `calls` (the calls on the air).
const callsAsked = new Map(); // id → { system, view }
function fetchCalls() {
  if (!ui.system || !rec.connected || !rec.capabilities.includes("calls")) return;
  callsAsked.clear();
  for (const system of chosen()) {
    const id = 1e9 + ++qid;
    callsAsked.set(id, { system, view: ui.system });
    rec.send({ type: "callsQuery", id, system, limit: 300 });
  }
}
rec.on("callsResult", (m) => {
  const a = callsAsked.get(m.id);
  if (!a) return;
  callsAsked.delete(m.id);
  if (a.view !== ui.system || m.error) return;
  S.calls.set(a.system, m.entries ?? []);
  mark("calls", "channels");
});

function drawCalls() {
  const rows = callRows();
  drawTable(
    "calls",
    $("calls"),
    [
      SYS_COL((e) => e.record.short_name),
      { k: "time", label: "TIME", get: (e) => e.record.start_time, show: (e) => hms(e.record.start_time) },
      { k: "site", label: "SITE", get: (e) => e.record.site ?? "", find: true },
      { k: "tg", label: "TGID", num: true, get: (e) => e.record.talkgroup, find: true },
      { k: "tag", label: "TAG", cls: () => "tag", get: (e) => e.record.talkgroup_tag, find: true },
      { k: "len", label: "LEN", num: true, get: (e) => e.record.call_length, show: (e) => mmss(e.record.call_length) },
      { k: "unit", label: "UNIT", num: true, get: (e) => e.record.srcList?.[0]?.src, find: true },
      { k: "alias", label: "ALIAS", cls: () => "tag", get: (e) => e.record.srcList?.[0]?.tag || unitName(e.record.srcList?.[0]?.src, e.record.short_name), find: true },
      { k: "units", label: "UNITS", num: true, get: (e) => new Set((e.record.srcList ?? []).map((s) => s.src)).size },
      { k: "freq", label: "FREQ", num: true, get: (e) => e.record.freq, show: (e) => fmhz(e.record.freq) },
      {
        k: "flags",
        label: "FLAGS",
        get: (e) => [e.record.emergency && "EMRG", e.record.encrypted && (e.record.decrypted ? "DEC" : "ENC"), !e.audio && "NO AUDIO"].filter(Boolean).join(" "),
      },
    ],
    rows,
    {
      sort: DEFAULT_SORT.calls,
      empty: "No calls recorded on this system yet.",
      rowClass: (e) =>
        [e.audio && !(e.record.encrypted && !e.record.decrypted) && "play", e.path === playing && "playing", e.record.emergency ? "emerg" : e.record.encrypted && !e.record.decrypted ? "enc" : ""]
          .filter(Boolean)
          .join(" "),
      rowAttr: (e) => ` data-path="${esc(e.path)}"`,
    },
  );
}

$("calls").addEventListener("click", (ev) => {
  const tr = ev.target.closest("tr.play");
  if (!tr) return;
  const a = $("player");
  if (playing === tr.dataset.path && !a.paused) {
    a.pause();
    playing = null;
  } else {
    playing = tr.dataset.path;
    a.src = rec.callUrl(playing);
    a.play().catch(() => {});
  }
  mark("calls");
});
$("player").addEventListener("ended", () => {
  playing = null;
  mark("calls");
});

function drawNeighbors() {
  // Sites being followed, of any system shown: an adjacent site may be another system's.
  const ours = new Map((rec.status?.systems ?? []).filter((s) => mine(s.shortName)).flatMap((sys) => sys.sites.map((s) => [`${s.identity.sysId}/${s.identity.rfss}/${s.identity.site}`, s.name])));
  const rows = Object.entries(S.detail).flatMap(([sys, d]) => (d.sites ?? []).flatMap((s) => s.adjacent.map((a) => ({ sys, from: s.name, ...a, ours: ours.get(`${a.sysId}/${a.rfss}/${a.site}`) ?? "" }))));
  const any = Object.keys(S.detail).length > 0;
  drawTable(
    "neighbors",
    $("neighbors"),
    [
      SYS_COL((r) => r.sys),
      { k: "from", label: "HEARD ON", get: (r) => r.from, find: true },
      { k: "sys", label: "SYS", get: (r) => hex(r.sysId, 3), find: true },
      { k: "rs", label: "RFSS-SITE", get: (r) => rfssSite(r.rfss, r.site), find: true },
      { k: "freq", label: "CONTROL", num: true, get: (r) => r.freqHz, show: (r) => fmhz(r.freqHz), find: true },
      { k: "ours", label: "FOLLOWED AS", get: (r) => r.ours, find: true },
    ],
    rows,
    { empty: any ? "No neighbors announced (only P25 control channels announce them)." : "Waiting for the control channel's detail…", rowClass: (r) => (r.ours ? "cc" : "") },
  );
}

function drawPatches() {
  const rows = Object.entries(S.detail).flatMap(([sys, d]) => (d.patches ?? []).map((p) => ({ ...p, sys })));
  const any = Object.keys(S.detail).length > 0;
  const name = (t, sys) => t.alphaTag || tgName(t.talkgroup, sys);
  drawTable(
    "patches",
    $("patches"),
    [
      SYS_COL((p) => p.sys),
      { k: "sg", label: "SUPERGROUP", num: true, get: (p) => p.supergroup.talkgroup, find: true },
      { k: "tag", label: "TAG", cls: () => "tag", get: (p) => name(p.supergroup, p.sys), find: true },
      { k: "n", label: "N", num: true, get: (p) => p.members.length },
      { k: "members", label: "MEMBERS", get: (p) => p.members.map((m) => (name(m, p.sys) ? `${m.talkgroup} ${name(m, p.sys)}` : m.talkgroup)).join(" · "), find: true },
    ],
    rows,
    { empty: any ? "No patches standing." : "Waiting for the control channel's detail…" },
  );
}

// ── Events: the control channel log, appended as it comes ─────────────────

function evRow(l) {
  const g = kindGroup(l.kind);
  const t = l.time ?? (l.timeS ? wall(l.timeS) : null);
  const cls = [`k-${g}`, /emergency/i.test(l.kind) || /emergency/i.test(l.text) ? "e-emerg" : "", l.level === "error" ? "e-error" : ""].join(" ");
  return `<tr id="ev${l.seq}" class="${cls}"><td>${hms(t)}</td><td>${esc(l.site ?? "")}</td><td>${esc(l.kind.toUpperCase())}</td><td class="text">${esc(l.text)}<span class="n">${repeats(l)}</span></td></tr>`;
}
const repeats = (l) => (l.n > 1 ? ` ×${l.n}` : "");
const evShown = (l) => ui.kinds.has(kindGroup(l.kind)) && (!ui.filter || `${l.kind} ${l.text} ${l.site ?? ""}`.toLowerCase().includes(ui.filter));

let evQueue = [];
const evBumped = new Set(); // lines drawn already whose repeats went up
function drawEvents(full) {
  if (ui.paused) return;
  const box = $("events-scroll");
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
  const el = $("events");
  if (full || !el.tBodies.length) {
    el.innerHTML = `<tbody>${S.events.filter(evShown).slice(-EV_SHOW).map(evRow).join("")}</tbody>`;
  } else {
    const body = el.tBodies[0];
    body.insertAdjacentHTML("beforeend", evQueue.filter(evShown).map(evRow).join(""));
    while (body.rows.length > EV_SHOW) body.deleteRow(0);
    for (const l of evBumped) {
      const n = document.getElementById(`ev${l.seq}`)?.querySelector(".n");
      if (n) n.textContent = repeats(l);
    }
  }
  evQueue = [];
  evBumped.clear();
  if (stick || full) box.scrollTop = box.scrollHeight;
}

// The control channel says most things more than once: a line the same as one
// heard in the last couple of seconds is counted on it (×2), not drawn again.
const REPEAT_MS = 2000;
let evSeq = 0;
function repeatOf(l, now) {
  for (let i = S.events.length - 1, n = 0; i >= 0 && n < 50; i--, n++) {
    const e = S.events[i];
    if (now - e.at > REPEAT_MS) break;
    if (e.kind === l.kind && e.text === l.text && e.site === l.site) return e;
  }
  return null;
}

rec.on("log", (m) => {
  const now = Date.now();
  for (const l of m.lines) {
    if (l.system && !mine(l.system)) continue;
    if (UNIT_KINDS.has(l.kind)) S.stale.units = true;
    const again = repeatOf(l, now);
    if (again) {
      again.n = (again.n ?? 1) + 1;
      evBumped.add(again);
      continue;
    }
    l.at = now;
    l.seq = ++evSeq;
    S.events.push(l);
    evQueue.push(l);
  }
  if (S.events.length > EV_KEEP) S.events.splice(0, S.events.length - EV_KEEP);
  if (evQueue.length > EV_SHOW) evQueue.splice(0, evQueue.length - EV_SHOW);
  if (!evTimer) evTimer = setTimeout(() => ((evTimer = 0), shown("events") && drawEvents(false)), 250);
});
let evTimer = 0;

$("kinds").innerHTML = KIND_GROUPS.map(([g, label]) => `<button type="button" class="chip k-${g}" data-g="${g}" aria-pressed="${ui.kinds.has(g)}">${label}</button>`).join("");
$("kinds").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-g]");
  if (!b) return;
  const g = b.dataset.g;
  ui.kinds.has(g) ? ui.kinds.delete(g) : ui.kinds.add(g);
  b.setAttribute("aria-pressed", ui.kinds.has(g));
  store.set("kinds", [...ui.kinds]);
  drawEvents(true);
});

function togglePause() {
  ui.paused = !ui.paused;
  $("pause").setAttribute("aria-pressed", ui.paused);
  $("pause").textContent = ui.paused ? "PAUSED" : "PAUSE";
  if (!ui.paused) drawEvents(true);
}
$("pause").onclick = togglePause;

// ── From the recorder ─────────────────────────────────────────────────────

rec.on("status", (m) => {
  offset = Date.now() / 1000 - m.status.nowS;
  const systems = m.status.systems.filter((s) => mine(s.shortName));
  if (!systems.length) return mark("header", "sites");
  const now = Date.now() / 1000;
  const liveKeys = new Set();
  for (const sys of systems) channelsOf(sys, m.calls, now, liveKeys);
  for (const [key, ch] of S.channels) {
    if (ch.kind !== "CC" && !liveKeys.has(key)) ch.live = false;
    if (!ch.live && !ch.conv && now - ch.last > CHANNEL_KEEP_S) S.channels.delete(key);
  }

  // Talkgroups and radios on the air now, for the polled tables' highlights.
  const calls = m.calls.filter((c) => mine(c.systemName));
  const tgs = new Map(calls.map((c) => [`${c.systemName}|${c.talkgroup}`, c]));
  const units = new Set(calls.flatMap((c) => c.sources.map((u) => `${c.systemName}|${u}`)));
  const key = `${[...tgs.keys()].sort()}|${[...units].sort()}`;
  const changed = key !== S.active.key;
  if (changed) S.stale.talkgroups = S.stale.units = true;
  S.active = { tgs, units, key };

  mark("header", "sites", "channels", ...(changed ? ["groups", "users"] : []));
});

// One system's control channels and calls on the air into S.channels; the keys live now into `liveKeys`.
function channelsOf(sys, allCalls, now, liveKeys) {
  const name = sys.shortName;
  for (const s of sys.sites) {
    const xs = S.rates.get(`${name}|${s.name}`) ?? [];
    xs.push({ t: s.nowS, good: s.good, bad: s.bad });
    while (xs.length > 2 && xs[xs.length - 1].t - xs[0].t > 5) xs.shift();
    S.rates.set(`${name}|${s.name}`, xs);
    if (s.controlChannelHz) {
      const key = `${name}|${s.controlChannelHz}/cc`;
      const ch = S.channels.get(key) ?? { sys: name, freq: s.controlChannelHz, kind: "CC", slot: null, hits: 0, snr: null };
      Object.assign(ch, { site: s.name, live: true, last: now });
      S.channels.set(key, ch);
    }
  }
  const conv = !sys.sites.length && convOf(name);
  if (conv) seedConventional(conv);
  // A control channel no site is on any more (it hunted elsewhere) is no longer live.
  const ccs = new Set(sys.sites.map((s) => s.controlChannelHz));
  for (const ch of S.channels.values()) if (ch.kind === "CC" && ch.sys === name && !ccs.has(ch.freq)) ch.live = false;

  for (const c of allCalls) {
    if (c.systemName !== name) continue;
    const key = conv ? `${name}|${c.freqHz}/conv` : `${name}|${c.freqHz}/${c.slot ?? 0}`;
    liveKeys.add(key);
    const ch = S.channels.get(key) ?? { sys: name, freq: c.freqHz, kind: conv ? "CONV" : "VC", conv: !!conv, codes: [], slot: c.slot, hits: 0, snr: null };
    if (ch.callId !== c.id) {
      ch.callId = c.id;
      ch.counted = false;
      ch.hits++;
    }
    if (conv) ch.slot = c.slot;
    Object.assign(ch, {
      site: c.site ?? (conv ? name : ""),
      tg: c.talkgroup,
      tag: c.alphaTag,
      unit: c.sources.at(-1) ?? ch.unit,
      reason: c.reason,
      encrypted: c.encrypted,
      decrypted: c.decrypted,
      emergency: c.emergency,
      live: true,
      last: now,
    });
    S.channels.set(key, ch);
  }
}

rec.on("decodeDetail", (m) => {
  if (!mine(m.system)) return;
  S.detail[m.system] = m;
  for (const c of m.channels) {
    for (const ch of S.channels.values()) if (ch.sys === m.system && ch.freq === c.freqHz && ch.live) ch.snr = c.snrDb;
  }
  mark("channels", "neighbors", "patches");
});

rec.on("concluded", (m) => {
  const r = m.entry?.record;
  if (r && mine(r.short_name)) {
    S.stale.talkgroups = S.stale.units = true;
    for (const ch of S.channels.values()) if (ch.conv && ch.sys === r.short_name && ch.freq === r.freq) ch.counted = true;
  }
  mark("calls", "channels");
});
rec.on("history", () => mark("calls", "channels"));
rec.on("heard", (m) => {
  heard = m.heard ?? {};
  mark("channels");
});
rec.on("state", () => mark("header", "sites"));
rec.on("config", () => mark("header", "channels"));
rec.on("talkgroups", () => mark("groups", "users", "calls"));

rec.on("connection", (up) => {
  pending.clear();
  S.polled = {}; // what came while away is missed: ask again
  mark("header", "sites");
  if (up) poll(), fetchCalls();
});

// ── The registry, polled ──────────────────────────────────────────────────

let qid = 0;
const pending = new Map(); // id → { what, system, view (ui.system when asked), hours }
function poll() {
  if (!rec.connected || document.hidden || !ui.system) return;
  const now = Date.now();
  const want = [];
  if (shown("groups")) want.push(["talkgroups", POLL_MIN_MS]);
  if (shown("users")) want.push(["units", POLL_MIN_MS]);
  else if (shown("groups")) want.push(["units", POLL_AFF_MS]);
  for (const [what, min] of want) {
    if ([...pending.values()].some((p) => p.what === what)) continue;
    const since = now - (S.polled[what] ?? 0);
    if (since < min || (!S.stale[what] && since < POLL_IDLE_MS)) continue;
    S.polled[what] = now;
    S.stale[what] = false;
    for (const system of chosen()) {
      const id = ++qid;
      pending.set(id, { what, system, view: ui.system, hours: ui.hours });
      rec.send({ type: "radioQuery", id, what, system, hours: ui.hours, limit: 1000 });
    }
  }
}
setInterval(poll, POLL_TICK_MS);
document.addEventListener("visibilitychange", poll);

rec.on("radioResult", (m) => {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (p.view !== ui.system || p.hours !== ui.hours || m.error) return;
  for (const r of m.rows) r.sys = p.system;
  const got = { rows: m.rows, total: m.total ?? m.rows.length };
  if (m.what === "talkgroups") S.tgs.set(p.system, got), mark("groups");
  if (m.what === "units") S.units.set(p.system, got), mark("users", "groups");
  $("poll").textContent = `REGISTRY ${hms(Date.now() / 1000)}`;
});

for (const sel of document.querySelectorAll("select.hours")) {
  sel.innerHTML = HOURS.map(([h, label]) => `<option value="${h}">${label}</option>`).join("");
  sel.value = ui.hours;
  sel.onchange = () => {
    ui.hours = Number(sel.value);
    store.set("hours", ui.hours);
    for (const s of document.querySelectorAll("select.hours")) s.value = ui.hours;
    S.tgs = new Map();
    S.units = new Map();
    S.polled = {};
    pending.clear();
    mark("groups", "users");
    poll();
  };
}

// ── The system, tabs, listening, keys ─────────────────────────────────────

function setSystem(name) {
  if (name === ui.system && S.rates.size) return;
  ui.system = name;
  store.set("system", name);
  remember();
  S = fresh();
  pending.clear();
  subscribe();
  if (ui.listening) listenTo();
  $("events").innerHTML = "";
  for (const p of Object.keys(DRAW)) mark(p);
  poll();
  fetchCalls();
}
$("system").onchange = (ev) => setSystem(ev.target.value);

// The log, and the decoder's detail of each system shown.
const subscribe = () => rec.subscribe(["log", ...chosen().map((n) => `decode:${n}`)]);
// Live audio of the system shown; with "All", of every system.
const listenTo = () => rec.listen(ui.system === ALL ? {} : { system: ui.system });

// 1-7: on a wide screen, 1 and 2 show or hide channels and events, and 3-7
// choose the pane on the right (again: none); on a narrow one, the pane.
function togglePane(p) {
  if (!wide.matches) {
    ui.tab = p;
    if (RIGHT.includes(p)) ui.show.right = p;
  } else if (LEFT.includes(p)) ui.show[p] = !ui.show[p];
  else {
    ui.show.right = ui.show.right === p ? null : p;
    if (ui.show.right) ui.tab = p;
  }
  store.set("show", ui.show);
  store.set("tab", ui.tab);
  remember();
  layout();
}

function layout() {
  for (const sec of document.querySelectorAll(".pane")) sec.classList.toggle("shown", shown(sec.dataset.pane));
  for (const b of document.querySelectorAll("#tabs [data-tab]")) b.setAttribute("aria-pressed", shown(b.dataset.tab));
  $("panes").classList.toggle("no-left", wide.matches && !ui.show.channels && !ui.show.events);
  $("panes").classList.toggle("no-right", wide.matches && !ui.show.right);
  closeColumns();
  for (const p of Object.keys(DRAW)) mark(p);
  poll();
}

// The system and panes in the address too, so a reload (or a bookmark) keeps this window's.
function remember() {
  const url = new URL(location.href);
  if (ui.system) url.searchParams.set("system", ui.system);
  url.searchParams.set("show", PANES.filter((p) => (LEFT.includes(p) ? ui.show[p] : ui.show.right === p)).join(","));
  url.searchParams.set("tab", ui.tab);
  history.replaceState(null, "", url);
}

$("tabs").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-tab]");
  if (b) togglePane(b.dataset.tab);
});
wide.addEventListener("change", layout);

// The dividers: dragged, arrow keys, double-click for even. `prop` is the CSS
// variable they set, a percentage of the panes' width (x) or the left column's height (y).
function divider(el, prop, axis, def) {
  let pct = def;
  const set = (v) => {
    pct = Math.round(Math.min(85, Math.max(15, v)) * 10) / 10;
    $("panes").style.setProperty(prop, `${pct}%`);
    el.setAttribute("aria-valuenow", Math.round(pct));
    store.set(prop, pct);
  };
  set(store.get(prop, def));
  el.addEventListener("pointerdown", (ev) => {
    el.setPointerCapture(ev.pointerId);
    el.classList.add("dragging");
    ev.preventDefault();
  });
  el.addEventListener("pointermove", (ev) => {
    if (!el.hasPointerCapture(ev.pointerId)) return;
    const r = (axis === "x" ? $("panes") : $("left")).getBoundingClientRect();
    set(axis === "x" ? (100 * (ev.clientX - r.left)) / r.width : (100 * (ev.clientY - r.top)) / r.height);
  });
  el.addEventListener("lostpointercapture", () => el.classList.remove("dragging"));
  el.addEventListener("dblclick", () => set(def));
  el.addEventListener("keydown", (ev) => {
    const d = { ArrowLeft: -2, ArrowUp: -2, ArrowRight: 2, ArrowDown: 2 }[ev.key];
    if (!d) return;
    ev.preventDefault();
    ev.stopPropagation();
    set(pct + d);
  });
}
divider($("split-x"), "--split-x", "x", 50);
divider($("split-y"), "--split-y", "y", 45);

// ── Columns: COLS, or right-click a heading ───────────────────────────────

const colsOf = {}; // pane → its columns, as last drawn
const hiddenOf = (pane) => new Set(ui.hidden[pane] ?? []);
const menu = $("colmenu");
let menuPane = null;

function openColumns(pane, x, y, alignRight = false) {
  menuPane = pane;
  drawColumns();
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  const left = alignRight ? x - r.width : x;
  menu.style.left = `${Math.max(4, Math.min(left, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  menu.querySelector("input")?.focus();
}
function closeColumns() {
  menu.hidden = true;
  menuPane = null;
}
function drawColumns() {
  const off = hiddenOf(menuPane);
  menu.innerHTML =
    `<div class="head">${esc(menuPane.toUpperCase())} COLUMNS</div>` +
    (colsOf[menuPane] ?? []).map((c) => `<label><input type="checkbox" data-k="${c.k}"${off.has(c.k) ? "" : " checked"}>${esc(c.label)}</label>`).join("") +
    `<button type="button" data-reset>DEFAULTS</button>`;
}
function setHidden(pane, keys) {
  ui.hidden = { ...ui.hidden, [pane]: keys };
  store.set("hidden", ui.hidden);
  mark(pane);
}
menu.addEventListener("change", (ev) => {
  const k = ev.target.dataset.k;
  if (!k) return;
  const off = hiddenOf(menuPane);
  ev.target.checked ? off.delete(k) : off.add(k);
  // One column at least.
  if (off.size >= (colsOf[menuPane] ?? []).length) return void (ev.target.checked = true);
  setHidden(menuPane, [...off]);
});
menu.addEventListener("click", (ev) => {
  if (!ev.target.closest("[data-reset]")) return;
  setHidden(menuPane, DEFAULT_HIDDEN[menuPane] ?? []);
  drawColumns();
});
document.addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-cols]");
  if (!b) return;
  if (menuPane === b.dataset.cols) return closeColumns();
  const r = b.getBoundingClientRect();
  openColumns(b.dataset.cols, r.right, r.bottom + 2, true);
});
document.addEventListener("pointerdown", (ev) => {
  if (!menu.hidden && !menu.contains(ev.target) && !ev.target.closest("[data-cols]")) closeColumns();
});

function clearFilter() {
  $("filter").value = "";
  ui.filter = "";
  mark(...PANES);
}
$("filter").addEventListener("input", (ev) => {
  ui.filter = ev.target.value.trim().toLowerCase();
  mark(...PANES);
});

async function toggleListen() {
  if (!ui.system && !ui.listening) return; // with no system, listen() would play every system
  ui.listening = !ui.listening;
  if (ui.listening) {
    await player.resume();
    listenTo();
  } else {
    rec.listen(false);
    player.stop();
  }
  $("listen").setAttribute("aria-pressed", ui.listening);
  mark("header");
}
$("listen").onclick = toggleListen;
rec.on("audio", (chunk) => ui.listening && player.play(chunk));

document.addEventListener("keydown", (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.key === "Escape" && !menu.hidden) return closeColumns();
  const typing = ev.target.matches("input:not([type=checkbox]), select");
  if (ev.key === "Escape" && ev.target === $("filter")) {
    clearFilter();
    $("filter").blur();
    return;
  }
  if (typing) return;
  const n = Number(ev.key);
  if (n >= 1 && n <= PANES.length) togglePane(PANES[n - 1]);
  else if (ev.key === "/") {
    ev.preventDefault();
    $("filter").focus();
  } else if (ev.key === "l" || ev.key === "L") toggleListen();
  else if (ev.key === " " && !ev.target.matches("button, input")) {
    ev.preventDefault();
    togglePause();
  }
});

setInterval(() => ($("clock").textContent = hms(Date.now() / 1000)), 1000);

layout();
if (ui.system) setSystem(ui.system);
mark("header", "sites");
