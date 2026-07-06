/* Halo2 Trace Inspector — static, no deps. */

const NET_COLORS = [
  "#4fd8c4",
  "#e5b567",
  "#ef7bab",
  "#7cafe8",
  "#a8d46a",
  "#c98ef0",
  "#f0d05e",
  "#6ee3a8"
];

const els = {
  exampleSelect: document.getElementById("exampleSelect"),
  renderBtn: document.getElementById("renderBtn"),
  jsonBtn: document.getElementById("jsonBtn"),
  jsonDrawer: document.getElementById("jsonDrawer"),
  jsonInput: document.getElementById("jsonInput"),
  parseStatus: document.getElementById("parseStatus"),
  valuesToggle: document.getElementById("valuesToggle"),
  tabs: [...document.querySelectorAll(".tab")],
  title: document.getElementById("circuitTitle"),
  subtitle: document.getElementById("circuitSubtitle"),
  viewCaption: document.getElementById("viewCaption"),
  playerBar: document.getElementById("playerBar"),
  prevBtn: document.getElementById("prevBtn"),
  playBtn: document.getElementById("playBtn"),
  nextBtn: document.getElementById("nextBtn"),
  stepCounter: document.getElementById("stepCounter"),
  stepOp: document.getElementById("stepOp"),
  gridScroll: document.getElementById("gridScroll"),
  gridWrap: document.getElementById("gridWrap"),
  grid: document.getElementById("traceGrid"),
  wireLayer: document.getElementById("wireLayer"),
  configView: document.getElementById("configView"),
  codePane: document.getElementById("codePane"),
  legend: document.getElementById("legend"),
  cellDetail: document.getElementById("cellDetail"),
  chipsList: document.getElementById("chipsList"),
  copyList: document.getElementById("copyList"),
  instanceList: document.getElementById("instanceList"),
  stage: document.querySelector(".stage")
};

const state = {
  circuit: null,
  derived: null,
  view: "synthesize",
  step: 0,
  playing: false,
  timer: null,
  selection: null // {type:"cell", key} | {type:"pair", pair:[a,b], kind:"copy"|"public"}
};

/* ---------- helpers ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function splitRef(ref) {
  const i = ref.indexOf(".");
  return i === -1 ? null : { row: ref.slice(0, i), col: ref.slice(i + 1) };
}

function columnList(circuit) {
  const c = circuit.columns || {};
  return [
    ...(c.advice || []).map((n) => ({ name: n, type: "advice" })),
    ...(c.fixed || []).map((n) => ({ name: n, type: "fixed" })),
    ...(c.selectors || []).map((n) => ({ name: n, type: "selector" })),
    ...(c.instance || []).map((n) => ({ name: n, type: "instance" }))
  ];
}

/* ---------- validation ---------- */

function validate(circuit) {
  const errors = [];
  if (typeof circuit !== "object" || circuit === null) {
    return ["circuit must be a JSON object"];
  }
  if (!circuit.columns || typeof circuit.columns !== "object") {
    return ["missing \"columns\" object"];
  }
  if (!Array.isArray(circuit.rows) || circuit.rows.length === 0) {
    return ["\"rows\" must be a non-empty array"];
  }

  const cols = columnList(circuit);
  const colNames = new Set(cols.map((c) => c.name));
  const selectorNames = new Set((circuit.columns.selectors || []));
  const rowIds = new Set();

  circuit.rows.forEach((row, i) => {
    if (!row.id) errors.push(`rows[${i}]: missing "id"`);
    else if (rowIds.has(row.id)) errors.push(`rows[${i}]: duplicate row id "${row.id}"`);
    else rowIds.add(row.id);

    Object.keys(row.cells || {}).forEach((col) => {
      if (!colNames.has(col)) errors.push(`rows[${i}] ("${row.id}"): cell in unknown column "${col}"`);
      if (selectorNames.has(col)) errors.push(`rows[${i}] ("${row.id}"): "${col}" is a selector — use "selectors", not "cells"`);
    });
    Object.keys(row.selectors || {}).forEach((sel) => {
      if (!selectorNames.has(sel)) errors.push(`rows[${i}] ("${row.id}"): unknown selector "${sel}"`);
    });
  });

  const checkRef = (ref, where) => {
    const p = typeof ref === "string" ? splitRef(ref) : null;
    if (!p) return void errors.push(`${where}: bad cell ref "${ref}" (expected "rowId.column")`);
    if (!rowIds.has(p.row)) errors.push(`${where}: unknown row "${p.row}" in ref "${ref}"`);
    if (!colNames.has(p.col)) errors.push(`${where}: unknown column "${p.col}" in ref "${ref}"`);
  };

  (circuit.copyConstraints || []).forEach((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) return void errors.push(`copyConstraints[${i}]: expected a pair ["a.x","b.y"]`);
    pair.forEach((r) => checkRef(r, `copyConstraints[${i}]`));
  });
  (circuit.instanceConstraints || []).forEach((pair, i) => {
    if (!Array.isArray(pair) || pair.length !== 2) return void errors.push(`instanceConstraints[${i}]: expected a pair ["a.x","b.y"]`);
    pair.forEach((r) => checkRef(r, `instanceConstraints[${i}]`));
  });

  return errors;
}

/* ---------- derived data (nets, indexes) ---------- */

function derive(circuit) {
  const rowIndex = new Map();
  circuit.rows.forEach((row, i) => rowIndex.set(row.id, i));

  const colType = new Map();
  columnList(circuit).forEach((c) => colType.set(c.name, c.type));

  // union-find over copy constraint endpoints -> nets
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => parent.set(find(a), find(b));
  (circuit.copyConstraints || []).forEach(([a, b]) => union(a, b));

  const netOf = new Map(); // cellKey -> net index
  const nets = []; // net index -> [cellKeys]
  const rootToNet = new Map();
  [...parent.keys()].forEach((key) => {
    const root = find(key);
    if (!rootToNet.has(root)) {
      rootToNet.set(root, nets.length);
      nets.push([]);
    }
    const n = rootToNet.get(root);
    netOf.set(key, n);
    nets[n].push(key);
  });

  // sort net members by row order for readable lists
  nets.forEach((members) =>
    members.sort((a, b) => (rowIndex.get(splitRef(a).row) ?? 0) - (rowIndex.get(splitRef(b).row) ?? 0))
  );

  // selector -> gate (for row accents + tags)
  const gateOf = new Map();
  (circuit.chips || []).forEach((chip) =>
    (chip.gates || []).forEach((g) => gateOf.set(g.selector, g))
  );

  return { rowIndex, colType, netOf, nets, gateOf };
}

function netColor(netIdx) {
  return NET_COLORS[netIdx % NET_COLORS.length];
}

/* ---------- grid rendering ---------- */

function gateKind(name) {
  const n = (name || "").toLowerCase();
  return n.includes("add") ? "add" : n.includes("mul") ? "mul" : "other";
}

function gateClassForRow(row, d) {
  const active = Object.keys(row.selectors || {}).filter((s) => row.selectors[s]);
  if (!active.length) return "";
  const gate = d.gateOf.get(active[0]);
  return `gate-${gateKind(gate?.name || active[0])}`;
}

function renderGrid() {
  const { circuit, derived: d } = state;
  const cols = columnList(circuit);

  const groups = [];
  cols.forEach((c) => {
    const last = groups[groups.length - 1];
    if (last && last.type === c.type) last.count++;
    else groups.push({ type: c.type, count: 1 });
  });

  const groupRow =
    `<tr class="group-row"><th></th>` +
    groups.map((g) => `<th colspan="${g.count}" scope="colgroup" class="group-${g.type}">${g.type}</th>`).join("") +
    `</tr>`;

  const nameRow =
    `<tr class="name-row"><th class="row-head micro-label">region · op</th>` +
    cols.map((c) => `<th scope="col" class="col-${c.type}" data-col="${esc(c.name)}">${esc(c.name)}</th>`).join("") +
    `</tr>`;

  const body = circuit.rows
    .map((row, idx) => {
      const cells = cols
        .map((col) => {
          const key = `${row.id}.${col.name}`;
          if (col.type === "selector") {
            const on = row.selectors?.[col.name] ? 1 : 0;
            return `<td class="cell sel-cell${on ? " sel-on" : ""}" data-col="${esc(col.name)}"><span class="sel-val">${on ? "1" : "·"}</span></td>`;
          }
          const cell = row.cells?.[col.name];
          if (!cell) return `<td class="cell" data-col="${esc(col.name)}"></td>`;
          const net = d.netOf.get(key);
          const dot = net !== undefined
            ? `<span class="net-dot" style="background:${netColor(net)}"></span>`
            : "";
          const value = cell.value !== undefined
            ? `<span class="cell-value">= ${esc(cell.value)}</span>`
            : "";
          const instCls = col.type === "instance" ? " col-instance-cell" : "";
          return (
            `<td class="cell assigned${instCls}" data-cell="${esc(key)}" data-col="${esc(col.name)}" tabindex="0" ` +
            `title="${esc(key)}${net !== undefined ? ` · equal-net ${net + 1}` : ""}">` +
            `<div class="cell-inner">${dot}<span class="cell-label">${esc(cell.label ?? "")}</span>${value}</div></td>`
          );
        })
        .join("");

      return (
        `<tr class="${gateClassForRow(row, d)}" data-row="${esc(row.id)}">` +
        `<th scope="row" class="row-head"><span class="row-idx">${idx}</span>` +
        `<span class="region">${esc(row.region || "")}</span>` +
        `<span class="op">${esc(row.op || "")}</span></th>${cells}</tr>`
      );
    })
    .join("");

  els.grid.innerHTML = `<thead>${groupRow}${nameRow}</thead><tbody>${body}</tbody>`;
}

/* ---------- step player ---------- */

function stepPairs() {
  const { circuit, derived: d } = state;
  const laterRow = (pair) =>
    Math.max(...pair.map((ref) => d.rowIndex.get(splitRef(ref).row) ?? 0));
  const copies = (circuit.copyConstraints || [])
    .filter((p) => laterRow(p) === state.step)
    .map((pair) => ({ pair, kind: "copy" }));
  const publics = (circuit.instanceConstraints || [])
    .filter((p) => laterRow(p) === state.step)
    .map((pair) => ({ pair, kind: "public" }));
  return [...copies, ...publics];
}

function applyStep() {
  const rows = [...els.grid.querySelectorAll("tbody tr")];
  rows.forEach((tr, idx) => {
    tr.classList.toggle("future", idx > state.step);
    tr.classList.toggle("current-step", idx === state.step);
    if (idx > state.step) tr.setAttribute("aria-hidden", "true");
    else tr.removeAttribute("aria-hidden");
  });

  const row = state.circuit.rows[state.step];
  els.stepCounter.textContent = `step ${state.step + 1}/${state.circuit.rows.length}`;
  const opText = row ? `${row.region || ""} — ${row.op || ""}` : "";
  els.stepOp.textContent = opText;
  els.stepOp.title = opText;

  drawWires();
}

function setStep(n, opts = {}) {
  const max = state.circuit.rows.length - 1;
  state.step = Math.max(0, Math.min(max, n));
  if (!opts.keepPlaying) stopPlay();
  applyStep();
}

function stopPlay() {
  state.playing = false;
  clearInterval(state.timer);
  els.playBtn.textContent = "▶ play";
}

function togglePlay() {
  if (state.playing) return stopPlay();
  clearSelection();
  state.playing = true;
  els.playBtn.textContent = "⏸ pause";
  if (state.step >= state.circuit.rows.length - 1) setStep(0, { keepPlaying: true });
  state.timer = setInterval(() => {
    if (state.step >= state.circuit.rows.length - 1) return stopPlay();
    setStep(state.step + 1, { keepPlaying: true });
  }, 1200);
}

/* ---------- wires (SVG overlay) ---------- */

function cellEl(key) {
  return els.grid.querySelector(`[data-cell="${CSS.escape(key)}"]`);
}

function activeWires() {
  const { circuit, derived: d } = state;
  const sel = state.selection;

  if (sel?.type === "pair") return [{ pair: sel.pair, kind: sel.kind }];

  if (sel?.type === "cell") {
    const net = d.netOf.get(sel.key);
    const inNet = (ref) => d.netOf.get(ref) === net && net !== undefined;
    const copies = (circuit.copyConstraints || [])
      .filter(([a, b]) => inNet(a) || inNet(b) || a === sel.key || b === sel.key)
      .map((pair) => ({ pair, kind: "copy" }));
    const publics = (circuit.instanceConstraints || [])
      .filter(([a, b]) => a === sel.key || b === sel.key || inNet(a) || inNet(b))
      .map((pair) => ({ pair, kind: "public" }));
    return [...copies, ...publics];
  }

  if (state.view === "synthesize") return stepPairs();
  return [];
}

function drawWires() {
  const svg = els.wireLayer;
  svg.innerHTML = "";
  if (state.view !== "synthesize") return;

  const wires = activeWires();
  if (!wires.length) return;

  const wrapRect = els.gridWrap.getBoundingClientRect();
  svg.setAttribute("viewBox", `0 0 ${wrapRect.width} ${wrapRect.height}`);

  const NS = "http://www.w3.org/2000/svg";
  const defs = document.createElementNS(NS, "defs");
  svg.appendChild(defs);
  const markers = new Set();
  const markerFor = (color) => {
    const id = "arr-" + color.replace("#", "");
    if (!markers.has(id)) {
      markers.add(id);
      const m = document.createElementNS(NS, "marker");
      m.setAttribute("id", id);
      m.setAttribute("markerWidth", "7");
      m.setAttribute("markerHeight", "7");
      m.setAttribute("refX", "5.5");
      m.setAttribute("refY", "3");
      m.setAttribute("orient", "auto");
      m.innerHTML = `<path d="M0,0 L0,6 L6,3 z" fill="${color}"></path>`;
      defs.appendChild(m);
    }
    return `url(#${id})`;
  };

  const { derived: d } = state;

  wires.forEach(({ pair, kind }) => {
    let [from, to] = pair;
    const ri = (ref) => d.rowIndex.get(splitRef(ref).row) ?? 0;
    if (ri(from) > ri(to)) [from, to] = [to, from];

    const a = cellEl(from);
    const b = cellEl(to);
    if (!a || !b) return;
    // never wire into a row the step player hasn't revealed yet
    if (a.closest("tr")?.classList.contains("future")) return;
    if (b.closest("tr")?.classList.contains("future")) return;

    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const x1 = ra.left - wrapRect.left + ra.width / 2;
    const y1 = ra.bottom - wrapRect.top - 4;
    const x2 = rb.left - wrapRect.left + rb.width / 2;
    const y2 = rb.top - wrapRect.top + 4;

    const dx = x2 - x1;
    const bow = Math.abs(dx) < 30 ? -34 : 0;
    const midY = (y1 + y2) / 2;

    const color = kind === "public"
      ? getComputedStyle(document.documentElement).getPropertyValue("--instance").trim()
      : netColor(d.netOf.get(from) ?? 0);

    const path = document.createElementNS(NS, "path");
    path.setAttribute(
      "d",
      `M ${x1} ${y1} C ${x1 + bow} ${midY}, ${x2 + bow} ${midY}, ${x2} ${y2}`
    );
    path.setAttribute("class", `wire animate${kind === "public" ? " public" : ""}`);
    if (kind !== "public") path.setAttribute("stroke", color);
    path.setAttribute("marker-end", markerFor(color));

    const dotEl = document.createElementNS(NS, "circle");
    dotEl.setAttribute("cx", x1);
    dotEl.setAttribute("cy", y1);
    dotEl.setAttribute("r", "2.5");
    dotEl.setAttribute("fill", color);

    svg.appendChild(path);
    svg.appendChild(dotEl);
  });
}

/* ---------- selection ---------- */

function clearSelection() {
  state.selection = null;
  els.grid.querySelectorAll(".selected, .endpoint").forEach((el) =>
    el.classList.remove("selected", "endpoint")
  );
  document.querySelectorAll(".constraint.active").forEach((el) => el.classList.remove("active"));
  els.cellDetail.textContent = "click a cell in the trace";
  drawWires();
}

function selectCell(key) {
  clearSelection();
  state.selection = { type: "cell", key };
  cellEl(key)?.classList.add("selected");
  renderCellDetail(key);
  drawWires();
}

function selectPair(pair, kind, listEl) {
  clearSelection();
  state.selection = { type: "pair", pair, kind };
  pair.forEach((ref) => cellEl(ref)?.classList.add(kind === "public" ? "endpoint" : "selected"));
  if (listEl) listEl.classList.add("active");
  drawWires();
}

// re-apply selection classes after the grid or side lists are rebuilt
function restoreSelectionMarks() {
  const sel = state.selection;
  if (!sel) return;
  if (sel.type === "cell") {
    cellEl(sel.key)?.classList.add("selected");
    renderCellDetail(sel.key);
  } else {
    sel.pair.forEach((ref) =>
      cellEl(ref)?.classList.add(sel.kind === "public" ? "endpoint" : "selected")
    );
    const match = [...document.querySelectorAll(".constraint")].find(
      (b) => b.dataset.pair === JSON.stringify(sel.pair)
    );
    match?.classList.add("active");
  }
}

function renderCellDetail(key) {
  const { circuit, derived: d } = state;
  const { row: rowId, col } = splitRef(key);
  const row = circuit.rows.find((r) => r.id === rowId);
  const cell = row?.cells?.[col];
  if (!row || !cell) return;

  const net = d.netOf.get(key);
  const netHtml = net !== undefined
    ? `<div class="detail-net-list">` +
      d.nets[net]
        .map((k) => `<span class="net-chip"><span class="net-dot" style="background:${netColor(net)}"></span>${esc(k)}</span>`)
        .join("") +
      `</div>`
    : `<span>none — not copy-constrained</span>`;

  const constraints = [
    ...(circuit.copyConstraints || [])
      .filter((p) => p.includes(key))
      .map((p) => `${esc(p[0])} ↔ ${esc(p[1])}`),
    ...(circuit.instanceConstraints || [])
      .filter((p) => p.includes(key))
      .map((p) => `${esc(p[0])} ↔ ${esc(p[1])} (public)`)
  ];

  els.cellDetail.innerHTML = `
    <table>
      <tr><td>cell</td><td>${esc(key)}</td></tr>
      <tr><td>column</td><td>${esc(col)} (${esc(d.colType.get(col) || "?")})</td></tr>
      <tr><td>region</td><td>${esc(row.region || "—")} · row ${d.rowIndex.get(rowId)}</td></tr>
      <tr><td>label</td><td>${esc(cell.label ?? "—")}</td></tr>
      <tr><td>value</td><td>${cell.value !== undefined ? esc(cell.value) : "—"}</td></tr>
      <tr><td>equal net</td><td>${netHtml}</td></tr>
      <tr><td>constraints</td><td>${constraints.length ? constraints.join("<br>") : "—"}</td></tr>
    </table>`;
}

/* ---------- side panels ---------- */

function renderSidePanels() {
  const { circuit, derived: d } = state;

  els.chipsList.innerHTML = (circuit.chips || [])
    .map(
      (chip) => `
      <div class="chip-card">
        <span class="chip-name">${esc(chip.name)}</span>
        <span class="chip-cols">[${(chip.columns || []).map(esc).join(", ")}]</span>
        ${(chip.gates || [])
          .map(
            (g) =>
              `<div class="gate-line"><span class="sel-tag">${esc(g.selector)}</span>${esc(g.expression)}</div>`
          )
          .join("")}
      </div>`
    )
    .join("") || `<div class="cell-detail">none</div>`;

  document.getElementById("copyCount").textContent = `(${(circuit.copyConstraints || []).length})`;
  document.getElementById("instanceCount").textContent = `(${(circuit.instanceConstraints || []).length})`;

  els.copyList.innerHTML = "";
  (circuit.copyConstraints || []).forEach((pair) => {
    const net = d.netOf.get(pair[0]);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "constraint";
    btn.dataset.pair = JSON.stringify(pair);
    btn.innerHTML =
      `<span class="net-dot" style="background:${netColor(net ?? 0)}"></span>` +
      `${esc(pair[0])} ↔ ${esc(pair[1])}`;
    btn.addEventListener("click", () => selectPair(pair, "copy", btn));
    els.copyList.appendChild(btn);
  });
  if (!(circuit.copyConstraints || []).length) els.copyList.textContent = "none";

  els.instanceList.innerHTML = "";
  (circuit.instanceConstraints || []).forEach((pair) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "constraint public-c";
    btn.dataset.pair = JSON.stringify(pair);
    btn.innerHTML = `<span class="net-dot" style="background:var(--instance)"></span>` +
      `${esc(pair[0])} == ${esc(pair[1])}`;
    btn.addEventListener("click", () => selectPair(pair, "public", btn));
    els.instanceList.appendChild(btn);
  });
  if (!(circuit.instanceConstraints || []).length) els.instanceList.textContent = "none";
}

function renderLegend() {
  const { derived: d } = state;
  const netSwatches = d.nets
    .slice(0, 3)
    .map((_, i) => `<span class="legend-swatch" style="background:${netColor(i)}"></span>`)
    .join("");

  els.legend.innerHTML = `
    <span class="legend-item">${netSwatches} same color = pinned equal</span>
    <span class="legend-item"><span class="legend-swatch" style="background:var(--selector)"></span> selector on</span>
    <span class="legend-item"><span class="legend-swatch dashed"></span> public pin</span>`;
}

/* ---------- configure view: ownership diagram ---------- */

// witness vars = cells in rows with no active selector and only advice cells
function witnessVars(circuit) {
  const { derived: d } = state;
  const out = [];
  circuit.rows.forEach((row) => {
    const active = Object.keys(row.selectors || {}).some((s) => row.selectors[s]);
    const cells = Object.entries(row.cells || {});
    if (active || !cells.length) return;
    if (!cells.every(([c]) => d.colType.get(c) === "advice")) return;
    cells.forEach(([, cell]) => out.push({ name: cell.label, row: row.id }));
  });
  return out;
}

function renderConfigure() {
  const { circuit } = state;
  const equality = new Set(circuit.equality || []);
  const chips = circuit.chips || [];
  const chipColNames = new Set(chips.flatMap((c) => c.columns || []));
  const witness = witnessVars(circuit);

  const strip = (name, type, opts = {}) => `
    <div class="col-strip t-${type}${opts.borrowed ? " borrowed" : ""}">
      <span class="col-name">${esc(name)}</span>
      <span class="col-type">${opts.borrowed ? "borrowed advice" : type}</span>
      ${equality.has(name) ? `<span class="eq-badge">⇄ equality</span>` : ""}
    </div>`;

  const circuitStrips = [
    ...(circuit.columns?.advice || []).map((n) => strip(n, "advice")),
    ...(circuit.columns?.fixed || []).map((n) => strip(n, "fixed")),
    ...(circuit.columns?.instance || []).map((n) => strip(n, "instance"))
  ].join("");

  const chipBoxes = chips
    .map((chip) => {
      const gates = (chip.gates || [])
        .map((g) => {
          const n = (g.name || "").toLowerCase();
          const cls = n.includes("add") ? "g-add" : n.includes("mul") ? "g-mul" : "g-other";
          return `
            <div class="gate-card ${cls}">
              <span class="gate-name">${esc(g.name || "gate")}</span>
              <span class="sel-tag">${esc(g.selector)}</span>
              <span class="gate-expr">${esc(g.expression)}</span>
            </div>`;
        })
        .join("");
      const owned = (chip.gates || [])
        .map((g) => `<span class="sel-tag">${esc(g.selector)} = meta.selector()</span>`)
        .join(" ");
      return `
      <div class="own-pass">passes ${(chip.columns || []).map(esc).join(", ")} ↓</div>
      <div class="own-box t-chip">
        <div class="own-head">${esc(chip.name)}::configure(${(chip.columns || []).map(esc).join(", ")}) → ${esc(chip.name)}Config</div>
        <div class="own-body">
          <span class="micro-label">borrows — created by the circuit, used by the chip</span>
          <div class="col-strips">${(chip.columns || []).map((n) => strip(n, "advice", { borrowed: true })).join("")}</div>
          <span class="micro-label">owns — selectors the chip creates itself</span>
          <div class="own-owned">${owned || "—"}</div>
          <span class="micro-label">owns — gates (polynomial identities)</span>
          ${gates}
        </div>
      </div>`;
    })
    .join("");

  els.configView.innerHTML = `
    <div class="own-box t-witness">
      <div class="own-head">MyCircuit — the prover's witness</div>
      <div class="own-body">
        ${
          witness.length
            ? witness.map((w) => `<code class="own-field">${esc(w.name)}: Value&lt;F&gt;</code>`).join(" ")
            : `<span class="own-note">no unconstrained loads — witness assigned directly in regions</span>`
        }
        <p class="own-note">secret values only. No columns, no gates, no structure — those live below.</p>
      </div>
    </div>
    <div class="own-box t-circuit">
      <div class="own-head">Circuit::configure() → CircuitConfig</div>
      <div class="own-body">
        <span class="micro-label">creates every column once — advice at circuit level so chips can share</span>
        <div class="col-strips">${circuitStrips}</div>
        <p class="own-note">enable_equality(col) marks a column usable in copy constraints${
          chipColNames.size ? "; advice columns are then handed to the chip:" : "."
        }</p>
      </div>
    </div>
    ${chipBoxes}`;
}

/* ---------- code view ---------- */

const SECTION_LABELS = [
  ["witness", "MyCircuit — witness"],
  ["chipcfg", "chip config — borrowed cols, owned selectors + gates"],
  ["config", "CircuitConfig — shape, built in configure()"],
  ["synth", "synthesize() — fill rows at proving time"]
];

function renderCode() {
  const lines = window.generateRust(state.circuit);

  const legend = `<div class="code-legend">${SECTION_LABELS.map(
    ([s, label]) => `<span class="legend-item"><span class="legend-swatch sw-${s}"></span> ${label}</span>`
  ).join("")}</div>`;

  els.codePane.innerHTML =
    legend +
    `<div class="code-lines">` +
    lines
      .map((l) => {
        const refs =
          (l.col ? ` data-col="${esc(l.col)}"` : "") + (l.row ? ` data-row="${esc(l.row)}"` : "");
        return `<div class="code-line s-${l.section || "plain"}${l.col || l.row ? ' linked" tabindex="0' : ""}"${refs}><span class="code-text">${esc(l.text) || " "}</span></div>`;
      })
      .join("") +
    `</div>`;

  const highlightFromLine = (target) => {
    const line = target.closest(".code-line.linked");
    clearCodeHighlight();
    if (!line) return;
    if (line.dataset.col) {
      els.grid
        .querySelectorAll(`[data-col="${CSS.escape(line.dataset.col)}"]`)
        .forEach((el) => el.classList.add("code-hi"));
    }
    if (line.dataset.row) {
      els.grid
        .querySelector(`tr[data-row="${CSS.escape(line.dataset.row)}"]`)
        ?.classList.add("code-hi-row");
    }
  };

  els.codePane.onmouseover = (e) => highlightFromLine(e.target);
  els.codePane.onfocusin = (e) => highlightFromLine(e.target);
  els.codePane.onmouseleave = clearCodeHighlight;
  els.codePane.onfocusout = clearCodeHighlight;
}

function clearCodeHighlight() {
  els.grid.querySelectorAll(".code-hi, .code-hi-row").forEach((el) =>
    el.classList.remove("code-hi", "code-hi-row")
  );
}

/* ---------- render pipeline ---------- */

const CAPTIONS = {
  synthesize:
    "press ▶ play to watch synthesize() fill the trace (⏭ shows it all) — click any cell to see where its value is pinned equal",
  configure:
    "who owns what: MyCircuit holds secrets, the circuit creates columns, chips borrow columns and own their selectors + gates",
  code:
    "homework-style Rust generated from this circuit — hover a line to light up what it creates or fills in the trace"
};

function renderAll() {
  const { circuit } = state;
  els.title.textContent = circuit.title || "untitled circuit";
  els.subtitle.textContent = circuit.subtitle || "";
  els.viewCaption.textContent = CAPTIONS[state.view];

  const view = state.view;
  els.playerBar.style.display = view === "synthesize" ? "" : "none";
  els.gridScroll.style.display = view === "configure" ? "none" : "";
  els.legend.style.display = view === "synthesize" ? "" : "none";
  els.configView.hidden = view !== "configure";
  els.codePane.hidden = view !== "code";
  els.stage.classList.toggle("view-code", view === "code");

  document.querySelector(".render-error")?.remove();

  if (view === "configure") {
    renderConfigure();
  } else {
    renderGrid();
    bindCellEvents();
    if (view === "synthesize") applyStep();
    else {
      drawWires(); // clears overlay; full trace shown, no step classes
      renderCode();
    }
  }
  renderSidePanels();
  renderLegend();
  restoreSelectionMarks();
}

function loadCircuit(circuit) {
  const errors = validate(circuit);
  if (errors.length) {
    showErrors(errors);
    return false;
  }
  stopPlay();
  state.circuit = circuit;
  state.derived = derive(circuit);
  state.selection = null;
  state.step = 0; // trace builds up via the player
  els.cellDetail.textContent = "click a cell in the trace";
  setStatus("rendered ✓", "ok");
  renderAll();
  return true;
}

function showErrors(errors) {
  const msg = errors.join("\n");
  setStatus(msg, "error");
  openDrawer(true);
  document.querySelector(".render-error")?.remove();
  const box = document.createElement("div");
  box.className = "render-error";
  box.textContent = "circuit JSON invalid:\n" + msg;
  els.stage.insertBefore(box, els.viewCaption);
}

function setStatus(text, cls) {
  els.parseStatus.textContent = text;
  els.parseStatus.className = "parse-status" + (cls ? " " + cls : "");
}

/* ---------- events ---------- */

function bindCellEvents() {
  els.grid.querySelectorAll(".cell.assigned").forEach((td) => {
    const key = td.dataset.cell;
    const net = state.derived.netOf.get(key);

    td.addEventListener("click", () => {
      if (state.selection?.type === "cell" && state.selection.key === key) clearSelection();
      else selectCell(key);
    });
    td.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectCell(key);
      }
    });

    if (net !== undefined) {
      td.addEventListener("mouseenter", () => {
        state.derived.nets[net].forEach((k) => cellEl(k)?.classList.add("net-hover"));
      });
      td.addEventListener("mouseleave", () => {
        els.grid.querySelectorAll(".net-hover").forEach((el) => el.classList.remove("net-hover"));
      });
    }
  });
}

function openDrawer(open) {
  els.jsonDrawer.hidden = !open;
  els.jsonBtn.setAttribute("aria-expanded", String(open));
  els.jsonBtn.textContent = open ? "JSON ⌃" : "JSON ⌄";
}

function parseAndRender() {
  let circuit;
  try {
    circuit = JSON.parse(els.jsonInput.value);
  } catch (e) {
    showErrors([`JSON parse error: ${e.message}`]);
    return;
  }
  loadCircuit(circuit);
}

function loadExample(id) {
  const ex = window.HALO2_EXAMPLES.find((e) => e.id === id);
  if (!ex) return;
  els.jsonInput.value = JSON.stringify(ex.circuit, null, 2);
  loadCircuit(ex.circuit);
}

function init() {
  window.HALO2_EXAMPLES.forEach((ex) => {
    const opt = document.createElement("option");
    opt.value = ex.id;
    opt.textContent = ex.label;
    els.exampleSelect.appendChild(opt);
  });

  els.exampleSelect.addEventListener("change", () => loadExample(els.exampleSelect.value));
  els.renderBtn.addEventListener("click", parseAndRender);
  els.jsonInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") parseAndRender();
  });
  els.jsonBtn.addEventListener("click", () => openDrawer(els.jsonDrawer.hidden));
  els.valuesToggle.addEventListener("change", () => {
    document.body.classList.toggle("show-values", els.valuesToggle.checked);
    drawWires();
  });

  els.tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => {
      state.view = tab.dataset.view;
      els.tabs.forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
      });
      stopPlay();
      renderAll();
    });
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.stopPropagation();
      const next = els.tabs[(i + (e.key === "ArrowRight" ? 1 : els.tabs.length - 1)) % els.tabs.length];
      next.focus();
      next.click();
    });
  });

  els.prevBtn.addEventListener("click", () => setStep(state.step - 1));
  els.nextBtn.addEventListener("click", () => setStep(state.step + 1));
  document.getElementById("endBtn").addEventListener("click", () =>
    setStep(state.circuit.rows.length - 1)
  );
  els.playBtn.addEventListener("click", togglePlay);

  const buildDrawer = document.getElementById("buildDrawer");
  const buildToggle = document.getElementById("buildToggle");
  const buildStatus = document.getElementById("buildStatus");
  buildToggle.addEventListener("click", () => {
    buildDrawer.hidden = !buildDrawer.hidden;
    buildToggle.setAttribute("aria-expanded", String(!buildDrawer.hidden));
    buildToggle.textContent = buildDrawer.hidden ? "Build ⌄" : "Build ⌃";
  });
  ["buildStmt", "buildWitness"].forEach((id) =>
    document.getElementById(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("buildBtn").click();
    })
  );
  document.getElementById("buildBtn").addEventListener("click", () => {
    try {
      const circuit = window.buildCircuit(
        document.getElementById("buildStmt").value,
        document.getElementById("buildWitness").value
      );
      els.jsonInput.value = JSON.stringify(circuit, null, 2);
      buildStatus.textContent = `generated ${circuit.rows.length} rows, ${circuit.copyConstraints.length} copy constraints ✓`;
      buildStatus.className = "parse-status ok";
      loadCircuit(circuit);
    } catch (e) {
      buildStatus.textContent = e.message;
      buildStatus.className = "parse-status error";
    }
  });

  document.addEventListener("keydown", (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || state.view !== "synthesize") return;
    if (e.key === "ArrowLeft") setStep(state.step - 1);
    else if (e.key === "ArrowRight") setStep(state.step + 1);
    else if (e.key === "Escape") clearSelection();
  });

  window.addEventListener("resize", drawWires);

  loadExample(window.HALO2_EXAMPLES[0].id);
}

init();
