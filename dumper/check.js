// Acceptance test: load the app's real eval.js and verify every dumped circuit.
// For each out/*.json: parse every (non-unsupported) gate constraint + lookup input,
// assert refs are advice/fixed columns present, then run checkCircuit and require
// failures === 0 (honest witness => every constraint satisfied).
global.window = {};
require("/Users/chloet/Desktop/Rareskills/halo2-visualizer/eval.js");
const { parseExpr, refsOf, checkCircuit } = window.HALO2_EVAL;

const fs = require("fs");
const path = require("path");

const outDir = path.join(__dirname, "out");
const files = fs.readdirSync(outDir).filter((f) => f.endsWith(".json")).sort();

let hadError = false;

for (const file of files) {
  const circuit = JSON.parse(fs.readFileSync(path.join(outDir, file), "utf8"));
  const exprCols = new Set([
    ...(circuit.columns.advice || []),
    ...(circuit.columns.fixed || []),
  ]);

  let translated = 0;
  let unsupported = 0;
  const errors = [];

  const checkExpr = (src, where) => {
    try {
      refsOf(parseExpr(src)).forEach((r) => {
        if (!exprCols.has(r.col)) errors.push(`${where}: ref "${r.col}" not an advice/fixed column`);
      });
    } catch (e) {
      errors.push(`${where}: ${e.message}`);
    }
  };

  (circuit.gates || []).forEach((g, i) => {
    if (g.unsupported) {
      unsupported++;
      return;
    }
    (g.constraints || []).forEach((c) => {
      translated++;
      checkExpr(c, `gate[${i}] ${g.name}`);
    });
  });

  (circuit.lookups || []).forEach((lk, i) => {
    (lk.inputs || []).forEach((c) => checkExpr(c, `lookup[${i}] ${lk.name}`));
  });

  const rowIndex = new Map(circuit.rows.map((r, i) => [r.id, i]));
  const result = checkCircuit(circuit, { rowIndex });

  if (result.failures !== 0) {
    errors.push(`checkCircuit reported ${result.failures} failing constraint(s)`);
    result.rows.forEach((checks, rowId) => {
      checks.filter((c) => c.ok === false).forEach((c) => errors.push(`  ${rowId}: ${c.name} ${c.detail}`));
    });
  }

  const status = errors.length ? "FAIL" : "ok";
  console.log(
    `${file}: ${status} — gates ${translated} translated / ${unsupported} unsupported, ` +
      `lookups ${(circuit.lookups || []).length}, checked ${result.checked}, failures ${result.failures}`
  );
  errors.forEach((e) => console.log("  " + e));
  if (errors.length) hadError = true;
}

process.exit(hadError ? 1 : 0);
