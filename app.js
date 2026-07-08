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
  practiceToggle: document.getElementById("practiceToggle"),
  title: document.getElementById("circuitTitle"),
  subtitle: document.getElementById("circuitSubtitle"),
  viewCaption: document.getElementById("viewCaption"),
  playerBar: document.getElementById("playerBar"),
  prevBtn: document.getElementById("prevBtn"),
  playBtn: document.getElementById("playBtn"),
  nextBtn: document.getElementById("nextBtn"),
  endBtn: document.getElementById("endBtn"),
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
  copyList: document.getElementById("copyList"),
  instanceList: document.getElementById("instanceList"),
  pageHead: document.querySelector(".page-head")
};

const state = {
  circuit: null,
  derived: null,
  step: 0,
  configOpen: null,
  playing: false,
  timer: null,
  practice: false,
  solutions: null,
  selection: null // {type:"cell", key} | {type:"pair", pair:[a,b], kind:"copy"|"public"}
};

const GLOSSARY = {
  advice: "Advice column: private cells the prover fills with witness values, fresh for every proof.",
  selector: "Selector column: a fixed 0/1 switch baked into the circuit — 1 turns its gate on for that row.",
  instance: "Instance column: public inputs. The verifier supplies these; the proof must be consistent with them.",
  fixed: "Fixed column: constants baked into the circuit at key generation — identical for every proof."
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

  // gate constraints + lookup inputs: must parse, only reference advice/fixed columns
  const exprCols = new Set([...(circuit.columns.advice || []), ...(circuit.columns.fixed || [])]);
  const checkExpr = (src, where) => {
    try {
      window.HALO2_EVAL.refsOf(window.HALO2_EVAL.parseExpr(src)).forEach((r) => {
        if (!exprCols.has(r.col))
          errors.push(`${where}: "${r.col}" is not an advice/fixed column (in "${src}")`);
      });
    } catch (e) {
      errors.push(`${where}: ${e.message}`);
    }
  };

  (circuit.gates || []).forEach((g, gi) => {
    if (g.unsupported) return;
    const where = `gates[${gi}] (${g.name || g.selector})`;
    if (!selectorNames.has(g.selector)) errors.push(`${where}: unknown selector "${g.selector}"`);
    if (!Array.isArray(g.constraints) || !g.constraints.length)
      errors.push(`${where}: "constraints" must be a non-empty array of expressions`);
    else g.constraints.forEach((c) => checkExpr(c, where));
  });

  (circuit.chips || []).forEach((chip, ci) =>
    (chip.gates || []).forEach((g, gi) => {
      if (g.unsupported) return;
      const where = `chips[${ci}].gates[${gi}] (${g.name || g.selector})`;
      if (!selectorNames.has(g.selector)) errors.push(`${where}: unknown selector "${g.selector}"`);
      if (!Array.isArray(g.constraints) || !g.constraints.length)
        errors.push(`${where}: "constraints" must be a non-empty array of expressions`);
      else g.constraints.forEach((c) => checkExpr(c, where));
    })
  );

  const tableByName = new Map((circuit.tables || []).map((t) => [t.name, t]));
  (circuit.tables || []).forEach((t, i) => {
    if (!t.name || !Array.isArray(t.columns) || !Array.isArray(t.rows))
      return void errors.push(`tables[${i}]: needs "name", "columns", "rows"`);
    t.rows.forEach((r, ri) => {
      if (!Array.isArray(r) || r.length !== t.columns.length)
        errors.push(`tables[${i}] "${t.name}" row ${ri}: expected ${t.columns.length} values`);
    });
  });
  (circuit.lookups || []).forEach((lk, i) => {
    const where = `lookups[${i}] (${lk.name || "?"})`;
    const table = tableByName.get(lk.table);
    if (!table) errors.push(`${where}: unknown table "${lk.table}"`);
    if (lk.selector && !selectorNames.has(lk.selector))
      errors.push(`${where}: unknown selector "${lk.selector}"`);
    (lk.inputs || []).forEach((c) => checkExpr(c, where));
    const tcols = lk.tableColumns || table?.columns || [];
    if (table && tcols.some((c) => !table.columns.includes(c)))
      errors.push(`${where}: tableColumns must be columns of "${lk.table}"`);
    if ((lk.inputs || []).length !== tcols.length)
      errors.push(`${where}: inputs (${(lk.inputs || []).length}) and tableColumns (${tcols.length}) must match in length`);
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
  (circuit.gates || []).forEach((g) => gateOf.set(g.selector, g));
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
    groups.map((g) => `<th colspan="${g.count}" scope="colgroup" class="group-${g.type}" title="${esc(GLOSSARY[g.type] || "")}">${g.type}</th>`).join("") +
    `</tr>`;

  const nameRow =
    `<tr class="name-row"><th class="row-head micro-label">region · op</th>` +
    cols.map((c) => `<th scope="col" class="col-${c.type}" data-col="${esc(c.name)}">${esc(c.name)}</th>`).join("") +
    `</tr>`;

  // consecutive rows with the same region name form one region block
  const regionStart = circuit.rows.map(
    (row, i) => i === 0 || row.region !== circuit.rows[i - 1].region
  );

  const body = circuit.rows
    .map((row, idx) => {
      const cells = cols
        .map((col) => {
          const key = `${row.id}.${col.name}`;
          if (col.type === "selector") {
            const on = row.selectors?.[col.name] ? 1 : 0;
            return `<td class="cell sel-cell${on ? " sel-on" : ""}" data-col="${esc(col.name)}" data-sel="${esc(col.name)}" tabindex="0" title="click to toggle"><span class="sel-val">${on ? "1" : "·"}</span></td>`;
          }
          const cell = row.cells?.[col.name];
          if (!cell) return `<td class="cell" data-col="${esc(col.name)}" tabindex="0" title="click to assign"></td>`;
          const net = d.netOf.get(key);
          const dot = net !== undefined
            ? `<span class="net-dot" style="background:${netColor(net)}"></span>`
            : "";
          const isBlank = cell.value === undefined && state.practice && state.solutions?.has(key);
          const value = cell.value !== undefined
            ? `<span class="cell-value">= ${esc(cell.value)}</span>`
            : isBlank
            ? `<span class="cell-value blank-q">= ?</span>`
            : "";
          const instCls = col.type === "instance" ? " col-instance-cell" : "";
          return (
            `<td class="cell assigned${instCls}${isBlank ? " blank" : ""}" data-cell="${esc(key)}" data-col="${esc(col.name)}" tabindex="0" ` +
            `title="${esc(key)}${net !== undefined ? ` · equal-net ${net + 1}` : ""}">` +
            `<div class="cell-inner">${dot}<span class="cell-label">${esc(cell.label ?? "")}</span>${value}</div></td>`
          );
        })
        .join("");

      // status column: aggregate gate/lookup checks for this row
      const checks = state.check?.rows.get(row.id) || [];
      const failed = checks.filter((c) => c.ok === false);
      const pending = checks.filter((c) => c.ok === undefined);
      let statusCls = "none", statusTxt = "";
      if (failed.length) { statusCls = "fail"; statusTxt = "✗"; }
      else if (checks.length && !pending.length) { statusCls = "ok"; statusTxt = "✓"; }
      else if (checks.length) { statusCls = "pending"; statusTxt = "·"; }
      const statusTitle = checks
        .map((c) => `${c.ok === false ? "✗" : c.ok ? "✓" : "·"} ${c.name}${c.detail ? ": " + c.detail : ""}`)
        .join("\n");

      return (
        `<tr class="${gateClassForRow(row, d)}${regionStart[idx] ? " region-start" : ""}${failed.length ? " row-fail" : ""}" data-row="${esc(row.id)}">` +
        `<th scope="row" class="row-head"><span class="row-idx">${idx}</span>` +
        `<span class="region">${regionStart[idx] ? esc(row.region || "") : "″"}</span>` +
        `<span class="op">${esc(row.op || "")}</span></th>${cells}` +
        `<td class="cell status-cell s-${statusCls}" title="${esc(statusTitle)}">${statusTxt}</td></tr>`
      );
    })
    .join("");

  els.grid.innerHTML =
    `<thead>${groupRow.replace("</tr>", `<th></th></tr>`)}` +
    `${nameRow.replace("</tr>", `<th scope="col" class="status-head" title="gate + lookup checks">ok</th></tr>`)}</thead>` +
    `<tbody>${body}</tbody>`;
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
  const blanks = row ? rowBlankCols(row) : [];
  const text = blanks.length ? `fill ${blanks.join(", ")} — ${row.op || row.region}` : opText;
  els.stepOp.textContent = text;
  els.stepOp.title = text;

  drawWires();
}

function rowBlankCols(row) {
  if (!state.practice || !state.solutions) return [];
  const cols = [];
  state.solutions.forEach((_, key) => {
    const p = splitRef(key);
    if (p.row !== row.id) return;
    const cell = row.cells?.[p.col];
    if (!cell || cell.value === undefined) cols.push(p.col);
  });
  return cols;
}

function setStep(n, opts = {}) {
  if (!state.circuit) return;
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
  if (!state.circuit) return;
  if (state.playing) return stopPlay();
  clearSelection();
  state.playing = true;
  els.playBtn.textContent = "⏸ pause";
  if (state.step >= state.circuit.rows.length - 1) setStep(0, { keepPlaying: true });
  state.timer = setInterval(() => {
    if (state.step >= state.circuit.rows.length - 1) return stopPlay();
    setStep(state.step + 1, { keepPlaying: true });
    if (state.practice && rowBlankCols(state.circuit.rows[state.step]).length) stopPlay();
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

  return stepPairs();
}

function drawWires() {
  const svg = els.wireLayer;
  svg.innerHTML = "";
  if (!state.circuit) return;

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
  document.getElementById("cellDetailSection").hidden = true;
  drawWires();
}

function selectCell(key) {
  clearSelection();
  state.selection = { type: "cell", key };
  cellEl(key)?.classList.add("selected");
  renderCellDetail(key);
  document.getElementById("cellDetailSection").hidden = false;
  drawWires();
}

function selectPair(pair, kind, listEl) {
  clearSelection();
  state.selection = { type: "pair", pair, kind };
  pair.forEach((ref) => cellEl(ref)?.classList.add(kind === "public" ? "endpoint" : "selected"));
  if (listEl) listEl.classList.add("active");
  document.getElementById("cellDetailSection").hidden = false;
  drawWires();
}

// failing copy/instance pairs: mark both endpoint cells red
function markPairFails() {
  (state.check?.pairs || []).forEach((p) => {
    if (p.ok !== false) return;
    p.pair.forEach((ref) => {
      const td = cellEl(ref);
      if (td) {
        td.classList.add("pair-fail-cell");
        td.title += ` · ✗ ${p.detail}`;
      }
    });
  });
}

// re-apply selection classes after the grid or side lists are rebuilt
function restoreSelectionMarks() {
  document.getElementById("cellDetailSection").hidden = !state.selection;
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
      <tr><td>label</td><td><span class="value-edit"><input id="labelEdit" type="text" value="${esc(cell.label ?? "")}" aria-label="cell label" /></span></td></tr>
      <tr><td>value</td><td>
        <span class="value-edit">
          <input id="valueEdit" type="text" inputmode="numeric" value="${cell.value !== undefined ? esc(cell.value) : ""}" placeholder="—" aria-label="cell value" />
          <button id="valueApply" class="btn ghost" type="button" title="apply value and re-check constraints">set</button>
          ${state.practice && state.solutions?.has(key) && cell.value === undefined
            ? `<button id="valueReveal" class="btn ghost" type="button">reveal</button>`
            : ""}
        </span>
      </td></tr>
      <tr><td>equal net</td><td>${netHtml}</td></tr>
      <tr><td>constraints</td><td>${constraints.length ? constraints.join("<br>") : "—"}</td></tr>
    </table>`;

  const apply = () => {
    const raw = document.getElementById("valueEdit").value.trim();
    if (raw !== "" && !/^-?\d+$/.test(raw)) return;
    cell.label = document.getElementById("labelEdit").value.trim();
    if (raw === "") delete cell.value;
    else cell.value = raw;
    els.jsonInput.value = JSON.stringify(circuit, null, 2);
    state.check = window.HALO2_EVAL.checkCircuit(circuit, d);
    renderAll();
  };
  document.getElementById("valueApply").addEventListener("click", apply);
  document.getElementById("valueEdit").addEventListener("keydown", (e) => {
    if (e.key === "Enter") apply();
  });
  document.getElementById("labelEdit").addEventListener("keydown", (e) => {
    if (e.key === "Enter") apply();
  });
  document.getElementById("valueReveal")?.addEventListener("click", () => {
    cell.value = state.solutions.get(key);
    els.jsonInput.value = JSON.stringify(circuit, null, 2);
    state.check = window.HALO2_EVAL.checkCircuit(circuit, d);
    renderAll();
  });
}

/* ---------- side panels ---------- */

function renderSidePanels() {
  const { circuit, derived: d } = state;

  const lookupsEl = document.getElementById("lookupsList");
  document.getElementById("lookupCount").textContent = `(${(circuit.lookups || []).length})`;
  lookupsEl.innerHTML = (circuit.lookups || [])
    .map(
      (lk, i) => `
      <div class="chip-card lookup-card" data-lookup="${i}">
        <span class="chip-name">${esc(lk.name || "lookup")}</span>
        ${lk.selector ? `<span class="sel-tag">${esc(lk.selector)}</span>` : ""}
        <div class="gate-line">(${(lk.inputs || []).map(esc).join(", ")}) ∈ ${esc(lk.table)}</div>
      </div>`
    )
    .join("") || "none";
  document.getElementById("lookupsList").closest(".side-section").hidden = !(circuit.lookups || []).length;
  bindLookupHover();

  document.getElementById("copyCount").textContent = `(${(circuit.copyConstraints || []).length})`;
  document.getElementById("instanceCount").textContent = `(${(circuit.instanceConstraints || []).length})`;

  const pairStatus = new Map(
    (state.check?.pairs || []).map((p) => [p.kind + JSON.stringify(p.pair), p])
  );
  const failMark = (pair, kind) => {
    const s = pairStatus.get(kind + JSON.stringify(pair));
    return s?.ok === false ? ` <span class="pair-fail" title="${esc(s.detail)}">✗</span>` : "";
  };

  els.copyList.innerHTML = "";
  (circuit.copyConstraints || []).forEach((pair) => {
    const net = d.netOf.get(pair[0]);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "constraint";
    btn.dataset.pair = JSON.stringify(pair);
    btn.innerHTML =
      `<span class="net-dot" style="background:${netColor(net ?? 0)}"></span>` +
      `${esc(pair[0])} ↔ ${esc(pair[1])}${failMark(pair, "copy")}`;
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
      `${esc(pair[0])} == ${esc(pair[1])}${failMark(pair, "public")}`;
    btn.addEventListener("click", () => selectPair(pair, "public", btn));
    els.instanceList.appendChild(btn);
  });
  if (!(circuit.instanceConstraints || []).length) els.instanceList.textContent = "none";
}

/* gate/lookup card hover -> highlight every cell the constraint reads */

function highlightGateCells(gate) {
  const { circuit } = state;
  let refs = [];
  try {
    (gate.constraints || []).forEach((c) =>
      refs.push(...window.HALO2_EVAL.refsOf(window.HALO2_EVAL.parseExpr(c)))
    );
  } catch { return; }
  circuit.rows.forEach((row, i) => {
    if (!row.selectors?.[gate.selector]) return;
    refs.forEach((r) => {
      const target = circuit.rows[i + r.rot];
      if (target) cellEl(`${target.id}.${r.col}`)?.classList.add("code-hi");
    });
  });
}

function clearHoverHighlights() {
  els.grid.querySelectorAll(".code-hi, .code-hi-row").forEach((el) =>
    el.classList.remove("code-hi", "code-hi-row")
  );
  document.querySelectorAll(".table-block.hi, .table-row-hi").forEach((el) =>
    el.classList.remove("hi", "table-row-hi")
  );
}

function bindLookupHover() {
  document.querySelectorAll(".lookup-card[data-lookup]").forEach((el) => {
    const lk = state.circuit.lookups?.[Number(el.dataset.lookup)];
    if (!lk) return;
    el.addEventListener("mouseenter", () => {
      highlightGateCells({ selector: lk.selector, constraints: lk.inputs });
      document
        .querySelector(`.table-block[data-table="${CSS.escape(lk.table)}"]`)
        ?.classList.add("hi");
    });
    el.addEventListener("mouseleave", clearHoverHighlights);
  });
}

/* ---------- lookup tables under the grid ---------- */

function renderTables() {
  const el = document.getElementById("tablesView");
  const tables = state.circuit.tables || [];
  if (!tables.length) {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const CAP = 16;
  el.innerHTML = tables
    .map((t) => {
      const shown = t.rows.slice(0, CAP);
      return `
      <div class="table-block" data-table="${esc(t.name)}">
        <div class="table-head" title="loaded once in synthesize() via assign_table">lookup table · <strong>${esc(t.name)}</strong></div>
        <table class="mini-table">
          <thead><tr><th></th>${t.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>
          <tbody>
            ${shown
              .map(
                (r, i) =>
                  `<tr><td class="mini-idx">${i}</td>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`
              )
              .join("")}
          </tbody>
        </table>
        ${t.rows.length > CAP ? `<div class="micro-label table-more">… ${t.rows.length - CAP} more rows</div>` : ""}
      </div>`;
    })
    .join("");
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
  const witness = witnessVars(circuit);

  const strip = (name, type, opts = {}) => `
    <div class="col-strip t-${type}${opts.borrowed ? " borrowed" : ""}" title="${esc(GLOSSARY[type] || "")}">
      <span class="col-name">${esc(name)}</span>
      <span class="col-type">${opts.borrowed ? "borrowed advice" : type}</span>
      ${equality.has(name) ? `<span class="eq-badge">⇄ equality</span>` : ""}
    </div>`;

  const circuitStrips = [
    ...(circuit.columns?.advice || []).map((n) => strip(n, "advice")),
    ...(circuit.columns?.fixed || []).map((n) => strip(n, "fixed")),
    ...(circuit.columns?.instance || []).map((n) => strip(n, "instance"))
  ].join("");

  const witnessBody = `
        ${
          witness.length
            ? witness.map((w) => `<code class="own-field">${esc(w.name)}: Value&lt;F&gt;</code>`).join(" ")
            : `<span class="own-note">no unconstrained loads — witness assigned directly in regions</span>`
        }`;

  const gateCardsHtml = (gates) =>
    (gates || [])
      .map((g) => {
        const cls = `g-${gateKind(g.name)}`;
        const rots = new Set();
        try {
          (g.constraints || []).forEach((c) =>
            window.HALO2_EVAL.refsOf(window.HALO2_EVAL.parseExpr(c)).forEach((r) => rots.add(r.rot))
          );
        } catch {}
        const span = Math.max(...[...rots, 0]) - Math.min(...[...rots, 0]) + 1;
        return `
            <div class="gate-card ${cls}">
              <span class="gate-name">${esc(g.name || "gate")}</span>
              <span class="sel-tag">${esc(g.selector)}</span>
              ${span > 1 ? `<span class="rot-badge" title="reads ${span} consecutive rows via rotations">↕ ${span} rows</span>` : ""}
              ${(g.constraints || [])
                .map((c) => `<div class="gate-expr">${esc(g.selector)} · (${esc(c)}) = 0</div>`)
                .join("")}
            </div>`;
      })
      .join("");

  const circuitBody = `
        <span class="micro-label">creates all columns — advice at circuit level so chips can share</span>
        <div class="col-strips">${circuitStrips}</div>${
          (circuit.gates || []).length
            ? `
        <span class="micro-label">owns · gates — declared inline, no chip</span>
        ${gateCardsHtml(circuit.gates)}`
            : ""
        }`;

  const sections = [];

  if (circuit.generatedFrom) {
    const steps = circuit.rows
      .filter((r) => Object.keys(r.selectors || {}).some((s) => r.selectors[s]))
      .map((r) => `<div class="plan-step ${gateClassForRow(r, state.derived)}">${esc(r.op || "")}</div>`)
      .join("");
    sections.push({
      title: "your statement, broken into steps",
      kind: "witness",
      html: `
        <p class="own-note"><code>${esc(circuit.generatedFrom)}</code></p>
        ${steps}`
    });
  }

  sections.push(
    { title: "MyCircuit — the prover's witness", kind: "witness", html: witnessBody },
    { title: "Circuit::configure() → CircuitConfig", kind: "circuit", html: circuitBody }
  );

  chips.forEach((chip) => {
    const cols = (chip.columns || []).map(esc).join(", ");
    const gates = gateCardsHtml(chip.gates);
    const owned = (chip.gates || [])
      .map((g) => `<span class="sel-tag">${esc(g.selector)} = meta.selector()</span>`)
      .join(" ");
    sections.push({
      title: `${esc(chip.name)}::configure(${cols}) → ${esc(chip.name)}Config`,
      kind: "chip",
      html: `
        <span class="micro-label">borrows</span>
          <div class="col-strips">${(chip.columns || []).map((n) => strip(n, "advice", { borrowed: true })).join("")}</div>
          <span class="micro-label">owns · selectors</span>
          <div class="own-owned">${owned || "—"}</div>
          <span class="micro-label">owns · gates</span>
          ${gates}`
    });
  });

  if ((circuit.lookups || []).length) {
    sections.push({
      title: "lookup arguments + tables",
      kind: "chip",
      html: `
        ${(circuit.lookups || [])
          .map(
            (lk) =>
              `<div class="gate-card g-other">
                <span class="gate-name">${esc(lk.name || "lookup")}</span>
                ${lk.selector ? `<span class="sel-tag">${esc(lk.selector)}</span>` : ""}
                <span class="gate-expr">(${(lk.inputs || []).map(esc).join(", ")}) must appear in table ${esc(lk.table)}</span>
              </div>`
          )
          .join("")}`
    });
  }

  if (!(state.configOpen instanceof Set)) state.configOpen = new Set([0]);
  const open = state.configOpen;
  [...open].forEach((i) => { if (i >= sections.length) open.delete(i); });

  els.configView.innerHTML = `
    <div class="config-nav">
      <button id="cfgNext" class="btn" type="button">next ▶</button>
      <button id="cfgAll" class="btn ghost" type="button">${open.size === sections.length ? "collapse all" : "open all"}</button>
      <span class="step-counter">${open.size}/${sections.length}</span>
    </div>
    ${sections
      .map((s, i) =>
        open.has(i)
          ? `<div class="own-box t-${s.kind} open"><div class="own-head own-toggle" data-cfg="${i}" title="click to collapse">${i + 1} · ${s.title}</div><div class="own-body">${s.html}</div></div>`
          : `<button type="button" class="own-box own-collapsed t-${s.kind}" data-cfg="${i}"><div class="own-head">${i + 1} · ${s.title}</div></button>`
      )
      .join("")}`;

  const next = document.getElementById("cfgNext");
  const firstClosed = sections.findIndex((_, i) => !open.has(i));
  const focusShape = document.querySelector(".layout").classList.contains("focus-shape");
  if (firstClosed === -1 && focusShape) {
    next.textContent = "start the trace ▸";
    next.disabled = false;
    next.onclick = wakeTraceNow;
  } else {
    next.textContent = firstClosed === -1 ? "done ✓" : "next ▶";
    next.disabled = firstClosed === -1;
    next.onclick = () => {
      if (firstClosed !== -1) open.add(firstClosed);
      renderConfigure();
    };
  }
  document.getElementById("cfgAll").onclick = () => {
    if (open.size === sections.length) { open.clear(); open.add(0); }
    else sections.forEach((_, i) => open.add(i));
    renderConfigure();
  };
  els.configView.querySelectorAll("[data-cfg]").forEach((el) => {
    el.onclick = () => {
      const i = Number(el.dataset.cfg);
      if (open.has(i)) open.delete(i);
      else open.add(i);
      renderConfigure();
    };
  });
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

function wakeTraceNow() {
  document.querySelector(".layout").classList.remove("focus-shape");
  document.getElementById("wakeTrace").hidden = true;
  document.getElementById("paneTrace").scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  drawWires();
}

function renderAll() {
  const { circuit } = state;
  els.title.textContent = circuit.title || "untitled circuit";
  els.subtitle.textContent = circuit.subtitle || "";
  els.viewCaption.hidden = true;

  document.querySelector(".render-error")?.remove();

  renderConfigure();
  renderGrid();
  bindCellEvents();
  applyStep();
  renderTables();
  renderCode();
  renderCheckBanner();
  renderSidePanels();
  renderLegend();
  markPairFails();
  restoreSelectionMarks();
  renderWitnessBar();
  if (els.propagateBtn) els.propagateBtn.disabled = state.practice;
}

/* ---------- live witness bar (builder-generated circuits) ---------- */

function witnessBarVars() {
  const circuit = state.circuit;
  const src = circuit.witnessSource || "";
  if (src.trim()) {
    return src
      .split(",")
      .map((p) => {
        const m = p.trim().match(/^([A-Za-z_]\w*)\s*=\s*(-?\d+)$/);
        return m ? [m[1], m[2]] : null;
      })
      .filter(Boolean);
  }
  const names = [];
  (circuit.rows || []).forEach((row) => {
    if (typeof row.op === "string" && row.op.startsWith("load private ")) {
      const name = row.op.slice("load private ".length).trim();
      if (name && !names.includes(name)) names.push(name);
    }
  });
  return names.map((n) => [n, ""]);
}

function renderWitnessBar() {
  const bar = document.getElementById("witnessBar");
  if (!bar) return;
  if (!state.circuit?.generatedFrom || state.practice) {
    bar.hidden = true;
    return;
  }
  const vars = witnessBarVars();
  const key = vars.map((v) => v[0]).join(",");
  // don't re-render (losing focus) during a rebuild we ourselves triggered
  if (!bar.hidden && bar.dataset.vars === key && bar.contains(document.activeElement)) return;

  bar.hidden = false;
  bar.dataset.vars = key;
  bar.innerHTML =
    `<span class="micro-label">witness</span>` +
    vars
      .map(
        ([n, v]) =>
          `<label>${esc(n)} <input data-wvar="${esc(n)}" value="${esc(v)}" inputmode="numeric" /></label>`
      )
      .join("");
}

function rebuildFromWitnessBar() {
  const bar = document.getElementById("witnessBar");
  if (!bar || !state.circuit?.generatedFrom) return;
  const parts = [];
  for (const inp of bar.querySelectorAll("[data-wvar]")) {
    const v = inp.value.trim();
    if (!/^-?\d+$/.test(v)) return; // wait until every field is valid
    parts.push(`${inp.dataset.wvar} = ${v}`);
  }
  if (!parts.length) return;

  let circuit;
  try {
    circuit = window.buildCircuit(state.circuit.generatedFrom, parts.join(", "));
  } catch (e) {
    let err = bar.querySelector(".parse-status.error");
    if (!err) {
      err = document.createElement("span");
      err.className = "parse-status error";
      bar.appendChild(err);
    }
    err.textContent = e.message;
    return;
  }
  bar.querySelector(".parse-status.error")?.remove();
  state.circuit = circuit;
  state.derived = derive(circuit);
  state.check = window.HALO2_EVAL.checkCircuit(circuit, state.derived);
  state.selection = null;
  state.step = Math.min(state.step, circuit.rows.length - 1);
  els.jsonInput.value = JSON.stringify(circuit, null, 2);
  renderAll();
}

/* ---------- practice mode ---------- */

function loadCellKeys() {
  const { circuit, derived: d } = state;
  const keys = new Set();
  circuit.rows.forEach((row) => {
    const active = Object.keys(row.selectors || {}).some((s) => row.selectors[s]);
    const cells = Object.entries(row.cells || {});
    if (active || !cells.length) return;
    if (!cells.every(([c]) => d.colType.get(c) === "advice")) return;
    cells.forEach(([col]) => keys.add(`${row.id}.${col}`));
  });
  return keys;
}

function cellAt(key) {
  const { row: rowId, col } = splitRef(key);
  return state.circuit.rows.find((r) => r.id === rowId)?.cells?.[col];
}

function enterPractice() {
  if (!state.circuit) {
    els.practiceToggle.checked = false;
    return;
  }
  const { circuit, derived: d } = state;
  const loads = loadCellKeys();
  const solutions = new Map();
  circuit.rows.forEach((row) => {
    Object.entries(row.cells || {}).forEach(([col, cell]) => {
      const key = `${row.id}.${col}`;
      if (loads.has(key) || cell.value === undefined || d.colType.get(col) !== "advice") return;
      solutions.set(key, cell.value);
      delete cell.value;
    });
  });
  if (!solutions.size) {
    setStatus("nothing to practice — this circuit has no computed values", "error");
    els.practiceToggle.checked = false;
    return;
  }
  state.solutions = solutions;
  state.practice = true;
  document.body.classList.add("practice", "show-values");
  els.valuesToggle.checked = true;
  els.endBtn.title = "Reveal all answers";
  state.check = window.HALO2_EVAL.checkCircuit(circuit, d);
  setStep(0);
  renderAll();
}

function exitPractice() {
  if (state.solutions) {
    state.solutions.forEach((value, key) => {
      const cell = cellAt(key);
      if (cell) cell.value = value;
    });
  }
  state.solutions = null;
  state.practice = false;
  document.body.classList.remove("practice");
  els.endBtn.title = "Show full trace";
  state.check = window.HALO2_EVAL.checkCircuit(state.circuit, state.derived);
  renderAll();
}

function revealAll() {
  if (!state.solutions) return;
  state.solutions.forEach((value, key) => {
    const cell = cellAt(key);
    if (cell && cell.value === undefined) cell.value = value;
  });
  els.jsonInput.value = JSON.stringify(state.circuit, null, 2);
  state.check = window.HALO2_EVAL.checkCircuit(state.circuit, state.derived);
  renderAll();
}

function loadCircuit(circuit) {
  const errors = validate(circuit);
  if (errors.length) {
    showErrors(errors);
    return false;
  }
  if (state.practice) {
    state.practice = false;
    state.solutions = null;
    els.practiceToggle.checked = false;
    document.body.classList.remove("practice");
    els.endBtn.title = "Show full trace";
  }
  stopPlay();
  document.getElementById("emptyState").hidden = true;
  document.body.classList.remove("no-circuit");
  state.circuit = circuit;
  state.derived = derive(circuit);
  state.check = window.HALO2_EVAL.checkCircuit(circuit, state.derived);
  state.selection = null;
  state.step = 0; // trace builds up via the player
  state.configOpen = new Set([0]);
  els.cellDetail.textContent = "click a cell in the trace";
  document.querySelector(".layout").classList.add("focus-shape");
  document.getElementById("wakeTrace").hidden = false;
  setStatus("rendered ✓", "ok");
  renderAll();
  return true;
}

function renderCheckBanner() {
  const el = document.getElementById("checkBanner");
  const c = state.check;
  if (!c || (!c.checked && !state.practice)) {
    el.textContent = "";
    el.className = "check-banner";
    return;
  }
  if (!c.checked && state.practice) {
    let left = 0;
    state.solutions?.forEach((_, key) => {
      const cell = cellAt(key);
      if (!cell || cell.value === undefined) left++;
    });
    el.textContent = `practice: ${left} cells left`;
    el.className = "check-banner";
    return;
  }
  const pairFails = c.pairs.filter((p) => p.ok === false).length;
  let remaining = 0;
  if (state.practice && state.solutions) {
    state.solutions.forEach((_, key) => {
      const cell = cellAt(key);
      if (!cell || cell.value === undefined) remaining++;
    });
    if (remaining === 0 && c.failures === 0 && c.incomplete === 0) {
      el.textContent = "solved ✓ — every constraint satisfied";
      el.className = "check-banner ok";
      return;
    }
  }
  const prefix = state.practice && remaining > 0 ? `practice: ${remaining} cells left · ` : "";
  if (c.failures) {
    el.textContent = prefix + `✗ ${c.failures} constraint${c.failures > 1 ? "s" : ""} failing`;
    el.className = "check-banner fail";
    el.title = c.pairs
      .filter((p) => p.ok === false)
      .map((p) => `✗ ${p.pair[0]} ↔ ${p.pair[1]}: ${p.detail}`)
      .join("\n") || "see ✗ rows in the trace";
  } else {
    el.textContent = prefix + (c.incomplete
      ? `✓ ${c.checked} checked · ${c.incomplete} skipped (missing values)`
      : `✓ all ${c.checked} constraints satisfied`);
    el.className = "check-banner ok";
    el.title = "gates, lookups, copies and instance pins — checked like MockProver";
  }
  void pairFails;
}

function showErrors(errors) {
  const msg = errors.join("\n");
  setStatus(msg, "error");
  openDrawer(true);
  document.querySelector(".render-error")?.remove();
  const box = document.createElement("div");
  box.className = "render-error";
  box.textContent = "circuit JSON invalid:\n" + msg;
  els.pageHead.appendChild(box);
}

function setStatus(text, cls) {
  els.parseStatus.textContent = text;
  els.parseStatus.className = "parse-status" + (cls ? " " + cls : "");
}

/* ---------- share links (circuit encoded in the URL hash) ---------- */

function b64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function encodeShareHash(circuit) {
  const bytes = new TextEncoder().encode(JSON.stringify(circuit));
  if (typeof CompressionStream === "function") {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const buf = new Uint8Array(await new Response(stream).arrayBuffer());
    return "c=" + b64url(buf);
  }
  return "u=" + b64url(bytes);
}

async function decodeShareHash(hash) {
  const tag = hash.slice(0, 2);
  const bytes = unb64url(hash.slice(2));
  if (tag === "c=") {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return JSON.parse(await new Response(stream).text());
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function shareCircuit() {
  if (!state.circuit) return;
  const btn = document.getElementById("shareBtn");
  try {
    location.hash = await encodeShareHash(state.circuit);
    await navigator.clipboard.writeText(location.href);
    btn.textContent = "copied ✓";
  } catch {
    btn.textContent = "link in URL bar";
  }
  setTimeout(() => (btn.textContent = "Share"), 1600);
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

  // selector cells: click to toggle the gate on/off for that row
  els.grid.querySelectorAll(".cell.sel-cell").forEach((td) => {
    const selName = td.dataset.sel;
    const rowId = td.closest("tr").dataset.row;
    const toggle = () => {
      const row = state.circuit.rows.find((r) => r.id === rowId);
      if (!row) return;
      if (!row.selectors) row.selectors = {};
      row.selectors[selName] = row.selectors[selName] ? 0 : 1;
      els.jsonInput.value = JSON.stringify(state.circuit, null, 2);
      state.check = window.HALO2_EVAL.checkCircuit(state.circuit, state.derived);
      renderAll();
    };
    td.addEventListener("click", toggle);
    td.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
    });
  });

  // empty non-selector cells: click to create a cell object, then open the editor
  els.grid.querySelectorAll(".cell[data-col]:not(.sel-cell):not(.assigned)").forEach((td) => {
    const col = td.dataset.col;
    const rowId = td.closest("tr")?.dataset.row;
    if (!rowId) return;
    const assign = () => {
      const row = state.circuit.rows.find((r) => r.id === rowId);
      if (!row) return;
      if (!row.cells) row.cells = {};
      row.cells[col] = { label: "" };
      els.jsonInput.value = JSON.stringify(state.circuit, null, 2);
      state.check = window.HALO2_EVAL.checkCircuit(state.circuit, state.derived);
      renderAll();
      selectCell(`${rowId}.${col}`);
    };
    td.addEventListener("click", assign);
    td.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); assign(); }
    });
  });
}

// reset a ghost drawer (build/design) to its closed state
function resetGhostDrawer(drawerId, toggleId, label) {
  document.getElementById(drawerId).hidden = true;
  const t = document.getElementById(toggleId);
  t.textContent = label + " ⌄";
  t.setAttribute("aria-expanded", "false");
}

function openDrawer(open) {
  els.jsonDrawer.hidden = !open;
  els.jsonBtn.setAttribute("aria-expanded", String(open));
  els.jsonBtn.textContent = open ? "JSON ⌃" : "JSON ⌄";
  if (open) {
    resetGhostDrawer("buildDrawer", "buildToggle", "Build");
    resetGhostDrawer("designDrawer", "designToggle", "Design");
  }
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
  els.exampleSelect.value = id;
  els.jsonInput.value = JSON.stringify(ex.circuit, null, 2);
  // deep-copy so value edits in one session don't mutate the pristine example
  loadCircuit(JSON.parse(JSON.stringify(ex.circuit)));
}

/* ---------- design drawer ---------- */

function addGateRow() {
  const div = document.createElement("div");
  div.className = "design-gate";
  div.innerHTML =
    `<input class="dg-chip" placeholder="chip (blank = inline)" spellcheck="false" />` +
    `<input class="dg-name" placeholder="gate name" spellcheck="false" />` +
    `<input class="dg-selector" placeholder="q_x" spellcheck="false" />` +
    `<input class="dg-constraints" placeholder="a * b - c; …" spellcheck="false" />` +
    `<button class="btn ghost dg-remove" type="button">✕</button>`;
  div.querySelector(".dg-remove").addEventListener("click", () => div.remove());
  document.getElementById("dGates").appendChild(div);
}

function applyDesign() {
  const list = (id) =>
    document.getElementById(id).value.split(",").map((s) => s.trim()).filter(Boolean);
  const witness = list("dWitness");
  const advice = list("dAdvice");
  const instance = list("dInstance");
  const fixed = list("dFixed");
  const equality = list("dEquality");

  const gates = [];
  const chipMap = new Map();
  const selectors = [];
  document.querySelectorAll("#dGates .design-gate").forEach((el) => {
    const selector = el.querySelector(".dg-selector").value.trim();
    if (!selector) return;
    const chip = el.querySelector(".dg-chip").value.trim();
    const name = el.querySelector(".dg-name").value.trim() || selector;
    const constraints = el.querySelector(".dg-constraints").value
      .split(";").map((s) => s.trim()).filter(Boolean);
    if (!selectors.includes(selector)) selectors.push(selector);
    const gate = { name, selector, constraints };
    if (chip) {
      if (!chipMap.has(chip)) chipMap.set(chip, { name: chip, columns: advice, gates: [] });
      chipMap.get(chip).gates.push(gate);
    } else {
      gates.push(gate);
    }
  });

  const rows = [];
  if (advice.length) {
    witness.forEach((f, i) =>
      rows.push({
        id: "w" + i,
        region: "unconstrained",
        op: "load private " + f,
        cells: { [advice[0]]: { label: f } },
        selectors: {}
      })
    );
  }
  const n = Number(document.getElementById("dRows").value) || 0;
  for (let i = 0; i < n; i++) {
    rows.push({ id: "r" + i, region: "region", op: "", cells: {}, selectors: {} });
  }

  const circuit = {
    title: "my design",
    subtitle: "designed by hand — toggle selector cells and set values in the trace",
    columns: { advice, selectors, instance, fixed },
    equality,
    chips: [...chipMap.values()],
    gates,
    rows,
    copyConstraints: [],
    instanceConstraints: []
  };

  els.jsonInput.value = JSON.stringify(circuit, null, 2);
  const st = document.getElementById("designStatus");
  if (loadCircuit(circuit)) {
    st.textContent = "applied ✓";
    st.className = "parse-status ok";
  } else {
    st.textContent = "see errors";
    st.className = "parse-status error";
  }
}

function init() {
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "examples…";
  els.exampleSelect.appendChild(placeholder);
  window.HALO2_EXAMPLES.forEach((ex) => {
    const opt = document.createElement("option");
    opt.value = ex.id;
    opt.textContent = ex.label;
    els.exampleSelect.appendChild(opt);
  });

  // empty landing state: example cards + inline builder
  const emptyExamples = document.getElementById("emptyExamples");
  window.HALO2_EXAMPLES.forEach((ex) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "example-card";
    card.innerHTML = `<span class="ex-name">${esc(ex.label)}</span><span class="ex-desc">${esc(ex.blurb || "")}</span>`;
    card.addEventListener("click", () => {
      els.exampleSelect.value = ex.id;
      loadExample(ex.id);
    });
    emptyExamples.appendChild(card);
  });
  document.getElementById("emptyBuildBtn").addEventListener("click", () => {
    const stmt = document.getElementById("emptyStmt").value.trim() || document.getElementById("emptyStmt").placeholder;
    const wit = document.getElementById("emptyWitness").value.trim();
    try {
      const circuit = window.buildCircuit(stmt, wit);
      els.jsonInput.value = JSON.stringify(circuit, null, 2);
      document.getElementById("buildStmt").value = stmt;
      document.getElementById("buildWitness").value = wit;
      loadCircuit(circuit);
    } catch (e) {
      const st = document.getElementById("emptyStatus");
      st.textContent = e.message;
      st.className = "parse-status error";
    }
  });
  ["emptyStmt", "emptyWitness"].forEach((id) =>
    document.getElementById(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("emptyBuildBtn").click();
    })
  );
  document.getElementById("emptyJsonBtn").addEventListener("click", () => {
    openDrawer(true);
    els.jsonInput.focus();
  });

  els.exampleSelect.addEventListener("change", () => {
    if (els.exampleSelect.value) loadExample(els.exampleSelect.value);
  });
  els.renderBtn.addEventListener("click", parseAndRender);
  els.jsonInput.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") parseAndRender();
  });
  els.jsonBtn.addEventListener("click", () => openDrawer(els.jsonDrawer.hidden));
  els.valuesToggle.addEventListener("change", () => {
    document.body.classList.toggle("show-values", els.valuesToggle.checked);
    drawWires();
  });
  els.practiceToggle.addEventListener("change", () => {
    if (els.practiceToggle.checked) enterPractice();
    else exitPractice();
  });

  els.prevBtn.addEventListener("click", () => setStep(state.step - 1));
  els.nextBtn.addEventListener("click", () => setStep(state.step + 1));
  els.endBtn.addEventListener("click", () => {
    if (state.practice) revealAll();
    setStep(state.circuit.rows.length - 1);
  });
  els.playBtn.addEventListener("click", togglePlay);

  els.propagateBtn = document.getElementById("propagateBtn");
  els.propagateBtn.addEventListener("click", () => {
    if (state.practice || !state.circuit) return;
    const n = window.HALO2_EVAL.propagate(state.circuit, state.derived);
    state.check = window.HALO2_EVAL.checkCircuit(state.circuit, state.derived);
    els.jsonInput.value = JSON.stringify(state.circuit, null, 2);
    renderAll();
    const btn = els.propagateBtn;
    btn.textContent = `↻ ${n} filled`;
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => {
      btn.textContent = "↻ propagate";
    }, 1500);
  });

  const witnessBar = document.getElementById("witnessBar");
  let witnessTimer = null;
  witnessBar.addEventListener("input", (e) => {
    if (!e.target.matches("[data-wvar]")) return;
    clearTimeout(witnessTimer);
    witnessTimer = setTimeout(rebuildFromWitnessBar, 180);
  });

  const buildDrawer = document.getElementById("buildDrawer");
  const buildToggle = document.getElementById("buildToggle");
  const buildStatus = document.getElementById("buildStatus");
  buildToggle.addEventListener("click", () => {
    if (buildDrawer.hidden) {
      openDrawer(false);
      resetGhostDrawer("designDrawer", "designToggle", "Design");
    }
    buildDrawer.hidden = !buildDrawer.hidden;
    buildToggle.setAttribute("aria-expanded", String(!buildDrawer.hidden));
    buildToggle.textContent = buildDrawer.hidden ? "Build ⌄" : "Build ⌃";
  });

  const designDrawer = document.getElementById("designDrawer");
  const designToggle = document.getElementById("designToggle");
  designToggle.addEventListener("click", () => {
    if (designDrawer.hidden) {
      openDrawer(false);
      resetGhostDrawer("buildDrawer", "buildToggle", "Build");
    }
    designDrawer.hidden = !designDrawer.hidden;
    designToggle.setAttribute("aria-expanded", String(!designDrawer.hidden));
    designToggle.textContent = designDrawer.hidden ? "Design ⌄" : "Design ⌃";
  });
  addGateRow();
  document.getElementById("dAddGate").addEventListener("click", addGateRow);
  document.getElementById("designApply").addEventListener("click", applyDesign);

  document.querySelectorAll(".drawer-close").forEach((btn) =>
    btn.addEventListener("click", () => {
      const d = btn.closest(".json-drawer");
      d.hidden = true;
      if (d.id === "jsonDrawer") openDrawer(false);
      else if (d.id === "designDrawer") resetGhostDrawer("designDrawer", "designToggle", "Design");
      else resetGhostDrawer("buildDrawer", "buildToggle", "Build");
    })
  );
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
    if (e.key === "Escape") {
      const openD = [...document.querySelectorAll(".json-drawer")].find((d) => !d.hidden);
      if (openD) {
        openD.querySelector(".drawer-close").click();
        return;
      }
    }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowLeft") setStep(state.step - 1);
    else if (e.key === "ArrowRight") setStep(state.step + 1);
    else if (e.key === "Escape") clearSelection();
  });

  window.addEventListener("resize", drawWires);
  document.getElementById("shareBtn").addEventListener("click", shareCircuit);

  const resizer = document.getElementById("paneResizer");
  const layoutEl = document.querySelector(".layout");
  resizer.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add("dragging");
    const left = layoutEl.getBoundingClientRect().left;
    const onMove = (ev) => {
      const w = Math.max(260, Math.min(760, ev.clientX - left));
      layoutEl.style.setProperty("--shape-w", w + "px");
    };
    const onUp = () => {
      resizer.classList.remove("dragging");
      resizer.removeEventListener("pointermove", onMove);
      resizer.removeEventListener("pointerup", onUp);
      drawWires();
    };
    resizer.addEventListener("pointermove", onMove);
    resizer.addEventListener("pointerup", onUp);
  });
  resizer.addEventListener("dblclick", () => {
    layoutEl.style.removeProperty("--shape-w");
    drawWires();
  });
  document.getElementById("wakeTrace").addEventListener("click", wakeTraceNow);

  document.querySelector(".layout").classList.add("code-collapsed");
  document.querySelectorAll(".pane-toggle, .pane-rail").forEach((el) =>
    el.addEventListener("click", () => {
      const pane = el.closest(".pane");
      const cls = pane.id === "paneShape" ? "shape-collapsed" : "code-collapsed";
      document.querySelector(".layout").classList.toggle(cls);
      drawWires();
    })
  );

  const hash = location.hash.slice(1);
  if (hash.startsWith("c=") || hash.startsWith("u=")) {
    decodeShareHash(hash)
      .then((circuit) => {
        els.jsonInput.value = JSON.stringify(circuit, null, 2);
        loadCircuit(circuit);
      })
      .catch(() => setStatus("could not decode shared link", "error"));
  } else {
    document.body.classList.add("no-circuit");
    document.getElementById("emptyState").hidden = false;
  }
}

init();
