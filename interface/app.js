// Trunk Classic: a text-mode trunk tracker view over the Trunk Recorder Pro API.
// Live state comes from `status` (2/s) and `decodeDetail`; the talkgroup and
// radio tables are polled from the radio registry (`radioQuery`) every few
// seconds. See API-NOTES.md for what a push would do better.
import { TrunkClient, LivePlayer, escapeHtml as esc } from "/api/client.js";

const POLL_MS = 3000;
const EV_KEEP = 3000; // events kept, to re-filter
const EV_SHOW = 600; // events drawn
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

const rec = new TrunkClient();
const player = new LivePlayer({ onNowPlaying: () => mark("header") });

const ui = {
  system: new URLSearchParams(location.search).get("system") ?? store.get("system", null),
  tab: new URLSearchParams(location.search).get("tab") ?? store.get("tab", "groups"),
  hours: store.get("hours", 1),
  kinds: new Set(store.get("kinds", ["grant", "unit", "rec"])),
  sort: store.get("sort", {}),
  filter: "",
  paused: false,
  listening: false,
};

// What we know of the system shown; reset when it changes.
let S = fresh();
function fresh() {
  return {
    channels: new Map(), // `${freqHz}/${slot}` → channel row
    rates: new Map(), // site name → recent { t, good, bad } samples
    detail: null, // decodeDetail
    tgs: null, // radioQuery talkgroups rows
    units: null, // radioQuery units rows
    tgsTotal: 0,
    unitsTotal: 0,
    polledAt: 0,
    active: { tgs: new Map(), units: new Set(), key: "" },
    events: [],
  };
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
const tgName = (tg) => rec.talkgroups(ui.system).get(tg)?.alphaTag ?? "";
const unitName = (u) => (u == null ? "" : rec.unitName(ui.system, u));

// ── Tables ────────────────────────────────────────────────────────────────

const cmp = (a, b) => {
  if (a == null || a === "") return b == null || b === "" ? 0 : 1;
  if (b == null || b === "") return -1;
  return typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
};

// cols: { k, label, num?, cls?, get(row) (what sorts and filters), show?(row) (text drawn), find? (filtered on) }
function drawTable(pane, el, cols, rows, opts = {}) {
  const s = ui.sort[pane] ?? opts.sort;
  if (s) {
    const c = cols.find((c) => c.k === s.k);
    if (c) rows = [...rows].sort((a, b) => cmp(c.get(a), c.get(b)) * s.dir);
  }
  const f = ui.filter && ui.tab === pane ? ui.filter : "";
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

// A click on a heading sorts by it (again: the other way).
for (const id of ["channels", "groups", "users", "calls", "neighbors", "patches"]) {
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

const DEFAULT_SORT = {
  channels: { k: "freq", dir: 1 },
  groups: { k: "last", dir: -1 },
  users: { k: "last", dir: -1 },
  calls: { k: "time", dir: -1 },
};

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
const shown = (pane) => ui.tab === pane || (wide.matches && (pane === "channels" || pane === "events"));

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
  $("now").textContent = ui.listening ? (np ? `▶ TG ${np.talkgroup} ${tgName(np.talkgroup)}` : "▶ WAITING FOR A CALL") : "";

  // Trunked systems: the ones being recorded, else the config's.
  const names = rec.status?.systems?.length ? rec.status.systems.map((s) => s.shortName) : (rec.config?.systems ?? []).map((s) => s.shortName);
  const sel = $("system");
  if (sel.dataset.names !== names.join("\n")) {
    sel.dataset.names = names.join("\n");
    sel.innerHTML = names.map((n) => `<option>${esc(n)}</option>`).join("");
  }
  if (names.length && !names.includes(ui.system)) setSystem(names[0]);
  sel.value = ui.system ?? "";
}

function drawSites() {
  const sys = rec.status?.systems?.find((s) => s.shortName === ui.system);
  const el = $("sites");
  if (!sys) {
    el.innerHTML = `<tbody><tr class="empty"><td>${esc(rec.connected ? (rec.phase.phase === "running" ? "This system isn't being recorded." : "Not recording: nothing on the air to follow.") : "Waiting for the recorder…")}</td></tr></tbody>`;
    return;
  }
  const head = ["SITE", "MOD", "WACN", "SYS", "RFSS-SITE", "NAC", "CONTROL", "MSG/S", "DEC%", "CALLS", "RECORDED"];
  const num = new Set(["MSG/S", "DEC%", "CALLS", "RECORDED"]);
  const rows = sys.sites.map((s) => {
    const r = siteRate(s.name);
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
  el.innerHTML = `<thead><tr>${head.map((h) => `<th class="${num.has(h) ? "num" : ""}">${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody>`;
}

// Messages a second and the share decoded, over the last ~5 s of status.
function siteRate(name) {
  const xs = S.rates.get(name) ?? [];
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

function drawChannels() {
  const rows = [...S.channels.values()];
  const now = Date.now() / 1000;
  const n = drawTable(
    "channels",
    $("channels"),
    [
      { k: "freq", label: "FREQ", num: true, get: (r) => r.freq, show: (r) => fmhz(r.freq), find: true },
      { k: "site", label: "SITE", get: (r) => r.site, find: true },
      { k: "kind", label: "TYPE", get: (r) => r.kind },
      { k: "slot", label: "SL", num: true, get: (r) => r.slot },
      { k: "state", label: "STATE", get: (r) => (r.kind === "CC" ? "CTRL" : r.live ? (r.reason ? STATE[r.reason] ?? r.reason : "REC") : "") },
      { k: "tg", label: "TGID", num: true, get: (r) => r.tg, find: true },
      { k: "tag", label: "TAG", cls: () => "tag", get: (r) => r.tag, find: true },
      { k: "unit", label: "UNIT", num: true, get: (r) => r.unit, find: true },
      { k: "alias", label: "ALIAS", cls: () => "tag", get: (r) => unitName(r.unit), find: true },
      { k: "hits", label: "HITS", num: true, get: (r) => r.hits },
      { k: "snr", label: "SNR", num: true, get: (r) => r.snr, show: (r) => (r.snr == null ? "" : r.snr.toFixed(1)) },
      { k: "seen", label: "SEEN", num: true, get: (r) => (r.live ? now : r.last), show: (r) => (r.live ? "NOW" : ago(r.last)) },
    ],
    rows,
    {
      sort: DEFAULT_SORT.channels,
      empty: "No channels yet: they're listed as the control channel grants them.",
      rowClass: (r) => (r.kind === "CC" ? "cc" : !r.live ? "idle" : r.emergency ? "emerg" : r.encrypted && !r.decrypted ? "enc" : r.reason ? "mon" : "on"),
    },
  );
  const live = rows.filter((r) => r.live && r.kind !== "CC").length;
  $("channels-sub").textContent = `${n} HEARD · ${live} ACTIVE`;
}

function drawGroups() {
  const sub = $("groups-sub");
  if (!S.tgs) {
    sub.textContent = "LOADING";
    $("groups").innerHTML = "";
    return;
  }
  const file = rec.talkgroups(ui.system);
  const act = S.active.tgs;
  const n = drawTable(
    "groups",
    $("groups"),
    [
      { k: "tg", label: "TGID", num: true, get: (r) => r.tg, find: true },
      { k: "hex", label: "HEX", get: (r) => hex(r.tg, 4), find: true },
      { k: "tag", label: "TAG", cls: () => "tag", get: (r) => r.alphaTag, find: true },
      { k: "group", label: "CATEGORY", cls: () => "tag", get: (r) => file.get(r.tg)?.group ?? "", find: true },
      { k: "calls", label: "CALLS", num: true, get: (r) => r.calls },
      { k: "secs", label: "AIR", num: true, get: (r) => r.secs, show: (r) => mmss(r.secs) },
      { k: "enc", label: "ENC%", num: true, get: (r) => r.encPct, show: (r) => (r.encPct ? r.encPct.toFixed(0) : "") },
      { k: "cipher", label: "CIPHER", get: (r) => r.ciphers?.[0]?.name ?? "" },
      { k: "flags", label: "FLAGS", get: (r) => [!r.known && "UNLISTED", r.ignore && "IGNORED", r.new && "NEW"].filter(Boolean).join(" ") },
      { k: "last", label: "LAST", num: true, get: (r) => (act.has(r.tg) ? Infinity : r.last), show: (r) => (act.has(r.tg) ? "NOW" : ago(r.last)) },
    ],
    S.tgs,
    {
      sort: DEFAULT_SORT.groups,
      empty: "No talkgroups heard in this time.",
      rowClass: (r) => {
        const c = act.get(r.tg);
        return [c ? (c.emergency ? "emerg" : c.encrypted && !c.decrypted ? "enc" : "on") : "", r.new && "new"].filter(Boolean).join(" ");
      },
    },
  );
  sub.textContent = `${n} OF ${S.tgsTotal}`;
}

function drawUsers() {
  const sub = $("users-sub");
  if (!S.units) {
    sub.textContent = "LOADING";
    $("users").innerHTML = "";
    return;
  }
  const act = S.active.units;
  const n = drawTable(
    "users",
    $("users"),
    [
      { k: "unit", label: "UID", num: true, get: (r) => r.unit, find: true },
      { k: "alias", label: "ALIAS", cls: () => "tag", get: (r) => r.alias || unitName(r.unit), find: true },
      { k: "aff", label: "AFF TG", num: true, get: (r) => r.aff, find: true },
      { k: "affTag", label: "AFF TAG", cls: () => "tag", get: (r) => (r.aff == null ? "" : tgName(r.aff)), find: true },
      { k: "affT", label: "SINCE", num: true, get: (r) => r.affT, show: (r) => ago(r.affT) },
      { k: "reg", label: "REG", get: (r) => (r.reg == null ? "" : r.reg ? "ON" : "OFF") },
      { k: "tx", label: "TX", num: true, get: (r) => r.tx },
      { k: "txSecs", label: "AIR", num: true, get: (r) => r.txSecs, show: (r) => mmss(r.txSecs) },
      { k: "tgs", label: "TALKS ON", cls: () => "wide", get: (r) => (r.tgs ?? []).slice(0, 3).map(([tg]) => tg).join(" "), find: true },
      { k: "lastTx", label: "LAST TX", num: true, get: (r) => (act.has(r.unit) ? Infinity : r.lastTx), show: (r) => (act.has(r.unit) ? "NOW" : ago(r.lastTx)) },
      { k: "last", label: "SEEN", num: true, get: (r) => r.last, show: (r) => ago(r.last) },
    ],
    S.units,
    {
      sort: DEFAULT_SORT.users,
      empty: "No radios heard in this time.",
      rowClass: (r) => [act.has(r.unit) ? "on" : r.reg === false ? "idle" : "", r.new && "new"].filter(Boolean).join(" "),
    },
  );
  sub.textContent = `${n} OF ${S.unitsTotal}`;
}

let playing = null; // the call path playing
function drawCalls() {
  const rows = rec.history.filter((e) => e.record.short_name === ui.system);
  drawTable(
    "calls",
    $("calls"),
    [
      { k: "time", label: "TIME", get: (e) => e.record.start_time, show: (e) => hms(e.record.start_time) },
      { k: "site", label: "SITE", get: (e) => e.record.site ?? "", find: true },
      { k: "tg", label: "TGID", num: true, get: (e) => e.record.talkgroup, find: true },
      { k: "tag", label: "TAG", cls: () => "tag", get: (e) => e.record.talkgroup_tag, find: true },
      { k: "len", label: "LEN", num: true, get: (e) => e.record.call_length, show: (e) => mmss(e.record.call_length) },
      { k: "unit", label: "UNIT", num: true, get: (e) => e.record.srcList?.[0]?.src, find: true },
      { k: "alias", label: "ALIAS", cls: () => "tag", get: (e) => e.record.srcList?.[0]?.tag || unitName(e.record.srcList?.[0]?.src), find: true },
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
  const sys = rec.status?.systems?.find((s) => s.shortName === ui.system);
  const ours = new Map((sys?.sites ?? []).map((s) => [`${s.identity.sysId}/${s.identity.rfss}/${s.identity.site}`, s.name]));
  const rows = (S.detail?.sites ?? []).flatMap((s) => s.adjacent.map((a) => ({ from: s.name, ...a, ours: ours.get(`${a.sysId}/${a.rfss}/${a.site}`) ?? "" })));
  drawTable(
    "neighbors",
    $("neighbors"),
    [
      { k: "from", label: "HEARD ON", get: (r) => r.from, find: true },
      { k: "sys", label: "SYS", get: (r) => hex(r.sysId, 3), find: true },
      { k: "rs", label: "RFSS-SITE", get: (r) => rfssSite(r.rfss, r.site), find: true },
      { k: "freq", label: "CONTROL", num: true, get: (r) => r.freqHz, show: (r) => fmhz(r.freqHz), find: true },
      { k: "ours", label: "FOLLOWED AS", get: (r) => r.ours, find: true },
    ],
    rows,
    { empty: S.detail ? "No neighbours announced (only P25 control channels announce them)." : "Waiting for the control channel's detail…", rowClass: (r) => (r.ours ? "cc" : "") },
  );
}

function drawPatches() {
  const rows = S.detail?.patches ?? [];
  const name = (t) => t.alphaTag || tgName(t.talkgroup);
  drawTable(
    "patches",
    $("patches"),
    [
      { k: "sg", label: "SUPERGROUP", num: true, get: (p) => p.supergroup.talkgroup, find: true },
      { k: "tag", label: "TAG", cls: () => "tag", get: (p) => name(p.supergroup), find: true },
      { k: "n", label: "N", num: true, get: (p) => p.members.length },
      { k: "members", label: "MEMBERS", get: (p) => p.members.map((m) => (name(m) ? `${m.talkgroup} ${name(m)}` : m.talkgroup)).join(" · "), find: true },
    ],
    rows,
    { empty: S.detail ? "No patches standing." : "Waiting for the control channel's detail…" },
  );
}

// ── Events: the control channel log, appended as it comes ─────────────────

function evRow(l) {
  const g = kindGroup(l.kind);
  const t = l.time ?? (l.timeS ? wall(l.timeS) : null);
  const cls = [`k-${g}`, /emergency/i.test(l.kind) || /emergency/i.test(l.text) ? "e-emerg" : "", l.level === "error" ? "e-error" : ""].join(" ");
  return `<tr class="${cls}"><td>${hms(t)}</td><td>${esc(l.site ?? "")}</td><td>${esc(l.kind.toUpperCase())}</td><td class="text">${esc(l.text)}</td></tr>`;
}
const evShown = (l) => ui.kinds.has(kindGroup(l.kind)) && (!ui.filter || ui.tab !== "events" || `${l.kind} ${l.text} ${l.site ?? ""}`.toLowerCase().includes(ui.filter));

let evQueue = [];
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
  }
  evQueue = [];
  if (stick || full) box.scrollTop = box.scrollHeight;
}

rec.on("log", (m) => {
  for (const l of m.lines) {
    if (l.system && l.system !== ui.system) continue;
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
  const sys = m.status.systems.find((s) => s.shortName === ui.system);
  if (!sys) return mark("header", "sites");
  const now = Date.now() / 1000;

  for (const s of sys.sites) {
    const xs = S.rates.get(s.name) ?? [];
    xs.push({ t: s.nowS, good: s.good, bad: s.bad });
    while (xs.length > 2 && xs[xs.length - 1].t - xs[0].t > 5) xs.shift();
    S.rates.set(s.name, xs);
    if (s.controlChannelHz) {
      const key = `${s.controlChannelHz}/cc`;
      const ch = S.channels.get(key) ?? { freq: s.controlChannelHz, kind: "CC", slot: null, hits: 0, snr: null };
      Object.assign(ch, { site: s.name, live: true, last: now });
      S.channels.set(key, ch);
    }
  }
  // A control channel no site is on any more (it hunted elsewhere) is no longer live.
  const ccs = new Set(sys.sites.map((s) => s.controlChannelHz));
  for (const ch of S.channels.values()) if (ch.kind === "CC" && !ccs.has(ch.freq)) ch.live = false;

  const calls = m.calls.filter((c) => c.systemName === ui.system);
  const liveKeys = new Set();
  for (const c of calls) {
    const key = `${c.freqHz}/${c.slot ?? 0}`;
    liveKeys.add(key);
    const ch = S.channels.get(key) ?? { freq: c.freqHz, kind: "VC", slot: c.slot, hits: 0, snr: null };
    if (ch.callId !== c.id) {
      ch.callId = c.id;
      ch.hits++;
    }
    Object.assign(ch, {
      site: c.site ?? "",
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
  for (const [key, ch] of S.channels) if (ch.kind === "VC" && !liveKeys.has(key)) ch.live = false;

  // Talkgroups and radios on the air now, for the polled tables' highlights.
  const tgs = new Map(calls.map((c) => [c.talkgroup, c]));
  const units = new Set(calls.flatMap((c) => c.sources));
  const key = `${[...tgs.keys()].sort()}|${[...units].sort()}`;
  const changed = key !== S.active.key;
  S.active = { tgs, units, key };

  mark("header", "sites", "channels", ...(changed ? ["groups", "users"] : []));
});

rec.on("decodeDetail", (m) => {
  if (m.system !== ui.system) return;
  S.detail = m;
  for (const c of m.channels) {
    for (const ch of S.channels.values()) if (ch.freq === c.freqHz && ch.live) ch.snr = c.snrDb;
  }
  mark("channels", "neighbors", "patches");
});

rec.on("concluded", () => mark("calls"));
rec.on("history", () => mark("calls"));
rec.on("state", () => mark("header", "sites"));
rec.on("config", () => mark("header"));
rec.on("talkgroups", () => mark("groups", "users", "calls"));

rec.on("connection", (up) => {
  pending.clear();
  mark("header", "sites");
  if (up) poll();
});

// ── The registry, polled ──────────────────────────────────────────────────

let qid = 0;
const pending = new Map(); // id → { what, system }
function poll() {
  if (!rec.connected || document.hidden || !ui.system) return;
  const want = [shown("groups") && "talkgroups", shown("users") && "units"].filter(Boolean);
  for (const what of want) {
    if ([...pending.values()].some((p) => p.what === what)) continue;
    const id = ++qid;
    pending.set(id, { what, system: ui.system, hours: ui.hours });
    rec.send({ type: "radioQuery", id, what, system: ui.system, hours: ui.hours, limit: 1000 });
  }
}
setInterval(poll, POLL_MS);
document.addEventListener("visibilitychange", poll);

rec.on("radioResult", (m) => {
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  if (p.system !== ui.system || p.hours !== ui.hours || m.error) return;
  if (m.what === "talkgroups") (S.tgs = m.rows), (S.tgsTotal = m.total), mark("groups");
  if (m.what === "units") (S.units = m.rows), (S.unitsTotal = m.total), mark("users");
  S.polledAt = Date.now();
  $("poll").textContent = `REGISTRY ${hms(S.polledAt / 1000)} · EVERY ${POLL_MS / 1000} S`;
});

for (const sel of document.querySelectorAll("select.hours")) {
  sel.innerHTML = HOURS.map(([h, label]) => `<option value="${h}">${label}</option>`).join("");
  sel.value = ui.hours;
  sel.onchange = () => {
    ui.hours = Number(sel.value);
    store.set("hours", ui.hours);
    for (const s of document.querySelectorAll("select.hours")) s.value = ui.hours;
    S.tgs = S.units = null;
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
  S = fresh();
  pending.clear();
  rec.subscribe(["log", `decode:${name}`]);
  if (ui.listening) rec.listen({ system: name });
  $("events").innerHTML = "";
  for (const p of Object.keys(DRAW)) mark(p);
  poll();
}
$("system").onchange = (ev) => setSystem(ev.target.value);

function setTab(tab) {
  ui.tab = tab;
  store.set("tab", tab);
  for (const b of document.querySelectorAll("#tabs [data-tab]")) b.setAttribute("aria-selected", b.dataset.tab === tab);
  for (const p of document.querySelectorAll(".pane")) p.classList.toggle("shown", p.dataset.pane === tab);
  for (const p of Object.keys(DRAW)) mark(p);
  poll();
}
$("tabs").addEventListener("click", (ev) => {
  const b = ev.target.closest("[data-tab]");
  if (b) setTab(b.dataset.tab);
});
wide.addEventListener("change", () => {
  // Channels and events are tabs only on a narrow screen.
  if (wide.matches && (ui.tab === "channels" || ui.tab === "events")) setTab("groups");
  else setTab(ui.tab);
});

$("filter").addEventListener("input", (ev) => {
  ui.filter = ev.target.value.trim().toLowerCase();
  mark(ui.tab);
});

async function toggleListen() {
  ui.listening = !ui.listening;
  if (ui.listening) {
    await player.resume();
    rec.listen({ system: ui.system });
  } else {
    rec.listen(false);
    player.stop();
  }
  $("listen").setAttribute("aria-pressed", ui.listening);
  mark("header");
}
$("listen").onclick = toggleListen;
rec.on("audio", (chunk) => ui.listening && player.play(chunk));

const TAB_KEYS = ["channels", "events", "groups", "users", "calls", "neighbors", "patches"];
document.addEventListener("keydown", (ev) => {
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const typing = ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement;
  if (ev.key === "Escape" && ev.target === $("filter")) {
    $("filter").value = "";
    ui.filter = "";
    $("filter").blur();
    mark(ui.tab);
    return;
  }
  if (typing) return;
  const n = Number(ev.key);
  if (n >= 1 && n <= TAB_KEYS.length) {
    const tab = TAB_KEYS[n - 1];
    if (!(wide.matches && (tab === "channels" || tab === "events"))) setTab(tab);
  } else if (ev.key === "/") {
    ev.preventDefault();
    $("filter").focus();
  } else if (ev.key === "l" || ev.key === "L") toggleListen();
  else if (ev.key === " " && !(ev.target instanceof HTMLButtonElement)) {
    ev.preventDefault();
    togglePause();
  }
});

setInterval(() => ($("clock").textContent = hms(Date.now() / 1000)), 1000);

if (wide.matches && (ui.tab === "channels" || ui.tab === "events")) ui.tab = "groups";
setTab(ui.tab);
if (ui.system) setSystem(ui.system);
mark("header", "sites");
