// Runs the repo's JS constraint checker (eval.js checkCircuit) over the shared
// cases.json mutation matrix. Prints "<circuitId>,<caseId>,<pass|fail>" lines,
// sorted. Zero npm deps.
const fs = require("fs");
const path = require("path");

global.window = {};
require("../../eval.js");
require("../../examples.js");

const { checkCircuit } = window.HALO2_EVAL;
const examples = window.HALO2_EXAMPLES;
const byId = new Map(examples.map((e) => [e.id, e.circuit]));

const cases = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "cases.json"), "utf8")
);

const lines = cases.map(({ circuit, case: caseId, cell, value }) => {
  const c = JSON.parse(JSON.stringify(byId.get(circuit))); // deep copy
  if (cell !== undefined) {
    const dot = cell.indexOf(".");
    const rowId = cell.slice(0, dot);
    const col = cell.slice(dot + 1);
    const row = c.rows.find((r) => r.id === rowId);
    row.cells[col].value = value;
  }
  const derived = { rowIndex: new Map(c.rows.map((r, i) => [r.id, i])) };
  const res = checkCircuit(c, derived);
  const verdict = res.failures === 0 && res.incomplete === 0 ? "pass" : "fail";
  return `${circuit},${caseId},${verdict}`;
});

lines.sort();
process.stdout.write(lines.join("\n") + "\n");
