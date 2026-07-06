/* Circuit JSON -> homework-style Rust skeleton.
 * Returns an array of lines: { text, section, col?, sel?, row? }
 * section: "witness" | "chipcfg" | "config" | "synth" | "" (plain)
 * col/sel/row: hover-sync targets in the trace grid. */

window.generateRust = function (circuit) {
  const lines = [];
  const push = (text, section = "", refs = {}) => lines.push({ text, section, ...refs });

  const advice = circuit.columns?.advice || [];
  const selectors = circuit.columns?.selectors || [];
  const instance = circuit.columns?.instance || [];
  const equality = circuit.equality || [];
  const chips = circuit.chips || [];
  const rows = circuit.rows || [];

  const colType = {};
  advice.forEach((c) => (colType[c] = "advice"));
  instance.forEach((c) => (colType[c] = "instance"));

  const ident = (label) => {
    const s = String(label).replace(/\W/g, "_");
    return /^[A-Za-z_]/.test(s) ? s : "_" + s;
  };

  const activeSel = (row) => Object.keys(row.selectors || {}).filter((s) => row.selectors[s]);

  // classify rows
  const isInstanceRow = (row) =>
    Object.keys(row.cells || {}).length > 0 &&
    Object.keys(row.cells).every((c) => colType[c] === "instance");
  const loadRows = rows.filter(
    (r) => !isInstanceRow(r) && activeSel(r).length === 0 &&
      Object.keys(r.cells || {}).every((c) => colType[c] === "advice")
  );
  const opRows = rows.filter((r) => activeSel(r).length > 0);
  const instanceRows = rows.filter(isInstanceRow);

  // witness vars: one per cell in load rows
  const witness = [];
  loadRows.forEach((r) =>
    Object.values(r.cells).forEach((cell) => witness.push({ name: ident(cell.label), row: r.id }))
  );

  // producer: cellRef -> variable name (load cell or op-row output cell)
  const producer = new Map();
  loadRows.forEach((r) =>
    Object.entries(r.cells).forEach(([c, cell]) => producer.set(`${r.id}.${c}`, ident(cell.label)))
  );

  const gateBySelector = new Map();
  chips.forEach((chip) => (chip.gates || []).forEach((g) => gateBySelector.set(g.selector, { chip, gate: g })));

  const methodName = (gate) =>
    gate.name
      ? ident(gate.name.replace(/\s*gate\s*$/i, "").trim() || gate.selector)
      : ident(gate.selector.replace(/^q_/, ""));

  // "q · (a + b − c) = 0" -> "a + b - c", or null if it doesn't match
  const gateBody = (expr) => {
    const m = String(expr).match(/\(([^()]+)\)\s*=\s*0\s*$/);
    return m ? m[1].replace(/·/g, "*").replace(/−/g, "-").trim() : null;
  };

  // output formula for chip methods: recognize a+b / a*b bodies
  const outFormula = (body, inA, inB) => {
    if (!body) return null;
    const norm = body.replace(/\s+/g, "");
    const out = norm.match(/^(.+)-([A-Za-z_]\w*)$/);
    if (!out) return null;
    const lhs = out[1];
    if (lhs === `${inA}+${inB}` || lhs === `${inB}+${inA}`) return "a_val + b_val";
    if (lhs === `${inA}*${inB}` || lhs === `${inB}*${inA}`) return "a_val * b_val";
    return null;
  };

  /* ---- MyCircuit: witness only ---- */

  push("// ── MyCircuit: ONLY the prover's private witness. No columns, no structure.", "witness");
  push("pub struct MyCircuit<F: PrimeField> {", "witness");
  if (witness.length) {
    witness.forEach((w) => push(`    ${w.name}: Value<F>,`, "witness", { row: w.row }));
  } else {
    push("    // no unconstrained loads in this trace — witness values are", "witness");
    push("    // assigned directly inside regions (e.g. Vec<Value<F>> fields)", "witness");
  }
  push("}", "witness");
  push("");

  /* ---- chip config(s): columns the chip USES, selectors + gates it OWNS ---- */

  chips.forEach((chip) => {
    const cname = ident(chip.name);
    const chipCols = chip.columns || [];
    const chipSels = selectors.filter((s) => gateBySelector.get(s)?.chip === chip);

    push(`// ── ${chip.name} config: borrows advice columns from the circuit,`, "chipcfg");
    push("//    creates and owns its selectors and gates.", "chipcfg");
    push("#[derive(Clone)]", "chipcfg");
    push(`pub struct ${cname}Config {`, "chipcfg");
    chipCols.forEach((c) => push(`    ${ident(c)}: Column<Advice>,`, "chipcfg", { col: c }));
    chipSels.forEach((s) => push(`    ${ident(s)}: Selector,`, "chipcfg", { col: s }));
    push("}", "chipcfg");
    push("");
    push(`pub struct ${cname}<F> {`, "chipcfg");
    push(`    config: ${cname}Config,`, "chipcfg");
    push("    _ph: PhantomData<F>,", "chipcfg");
    push("}", "chipcfg");
    push("");
    push(`impl<F: PrimeField> ${cname}<F> {`, "chipcfg");
    push(`    pub fn construct(config: ${cname}Config) -> Self {`, "chipcfg");
    push(`        ${cname} { config, _ph: PhantomData }`, "chipcfg");
    push("    }", "chipcfg");
    push("");
    push("    pub fn configure(", "chipcfg");
    push("        meta: &mut ConstraintSystem<F>,", "chipcfg");
    chipCols.forEach((c) =>
      push(`        ${ident(c)}: Column<Advice>,   // created by the circuit, passed in`, "chipcfg", { col: c })
    );
    push(`    ) -> ${cname}Config {`, "chipcfg");
    chipSels.forEach((s) =>
      push(`        let ${ident(s)} = meta.selector();   // chip-owned`, "chipcfg", { col: s })
    );
    push("");

    (chip.gates || []).forEach((g) => {
      const body = gateBody(g.expression);
      push(`        meta.create_gate("${g.name || g.selector}", |meta| {`, "chipcfg", { col: g.selector });
      chipCols.forEach((c) =>
        push(`            let ${ident(c)} = meta.query_advice(${ident(c)}, Rotation::cur());`, "chipcfg", { col: c })
      );
      push(`            let ${ident(g.selector)} = meta.query_selector(${ident(g.selector)});`, "chipcfg", { col: g.selector });
      if (body) {
        push(`            vec![${ident(g.selector)} * (${body})]`, "chipcfg", { col: g.selector });
      } else {
        push(`            // ${g.expression}`, "chipcfg");
        push(`            vec![/* TODO: express "${g.expression}" */]`, "chipcfg");
      }
      push("        });", "chipcfg");
      push("");
    });

    push(`        ${cname}Config { ${[...chipCols, ...chipSels].map(ident).join(", ")} }`, "chipcfg");
    push("    }", "chipcfg");

    // unconstrained loader if this circuit loads witness cells
    if (witness.length && chipCols.length) {
      const first = ident(chipCols[0]);
      push("");
      push("    pub fn unconstrained(", "chipcfg");
      push("        &self,", "chipcfg");
      push("        layouter: &mut impl Layouter<F>,", "chipcfg");
      push("        v: Value<F>,", "chipcfg");
      push("    ) -> Result<AssignedCell<F, F>, ErrorFront> {", "chipcfg");
      push('        layouter.assign_region(|| "unconstrained", |mut region| {', "chipcfg");
      push(`            region.assign_advice(|| "${chipCols[0]}", self.config.${first}, 0, || v)`, "chipcfg", { col: chipCols[0] });
      push("        })", "chipcfg");
      push("    }", "chipcfg");
    }

    // one method per gate (2-in 1-out convention: first two chip columns in, last out)
    (chip.gates || []).forEach((g) => {
      if (chipCols.length < 3) return;
      const [inA, inB, outC] = [chipCols[0], chipCols[1], chipCols[chipCols.length - 1]];
      const formula = outFormula(gateBody(g.expression), inA, inB);
      const region = `${methodName(g)} region`;
      push("");
      push(`    pub fn ${methodName(g)}(`, "chipcfg", { col: g.selector });
      push("        &self,", "chipcfg");
      push("        layouter: &mut impl Layouter<F>,", "chipcfg");
      push("        a: AssignedCell<F, F>,", "chipcfg");
      push("        b: AssignedCell<F, F>,", "chipcfg");
      push("    ) -> Result<AssignedCell<F, F>, ErrorFront> {", "chipcfg");
      push(`        layouter.assign_region(|| "${region}", |mut region| {`, "chipcfg");
      push(`            self.config.${ident(g.selector)}.enable(&mut region, 0)?;`, "chipcfg", { col: g.selector });
      push("            let a_val = a.value().copied();", "chipcfg");
      push("            let b_val = b.value().copied();", "chipcfg");
      push(`            let new_a = region.assign_advice(|| "${inA}", self.config.${ident(inA)}, 0, || a_val)?;`, "chipcfg", { col: inA });
      push(`            let new_b = region.assign_advice(|| "${inB}", self.config.${ident(inB)}, 0, || b_val)?;`, "chipcfg", { col: inB });
      push("            // copy constraints: pin this row's inputs to the caller's cells", "chipcfg");
      push("            region.constrain_equal(new_a.cell(), a.cell())?;", "chipcfg");
      push("            region.constrain_equal(new_b.cell(), b.cell())?;", "chipcfg");
      if (formula) {
        push(`            region.assign_advice(|| "${outC}", self.config.${ident(outC)}, 0, || ${formula})`, "chipcfg", { col: outC });
      } else {
        push(`            let out_val = a_val; // TODO: compute per gate "${g.expression}"`, "chipcfg");
        push(`            region.assign_advice(|| "${outC}", self.config.${ident(outC)}, 0, || out_val)`, "chipcfg", { col: outC });
      }
      push("        })", "chipcfg");
      push("    }", "chipcfg");
    });

    push("}", "chipcfg");
    push("");
  });

  /* ---- CircuitConfig + Circuit impl ---- */

  push("// ── CircuitConfig: the circuit's full shape — instance columns + chip configs.", "config");
  push("#[derive(Clone)]", "config");
  push("pub struct CircuitConfig {", "config");
  instance.forEach((c) => push(`    ${ident(c)}: Column<Instance>,`, "config", { col: c }));
  chips.forEach((chip) => push(`    config: ${ident(chip.name)}Config,`, "config"));
  push("}", "config");
  push("");
  push("impl<F: PrimeField> Circuit<F> for MyCircuit<F> {", "config");
  push("    type Config = CircuitConfig;", "config");
  push("    type FloorPlanner = SimpleFloorPlanner;", "config");
  push("");
  push("    fn without_witnesses(&self) -> Self {", "witness");
  if (witness.length) {
    push(`        MyCircuit { ${witness.map((w) => `${w.name}: Value::unknown()`).join(", ")} }`, "witness");
  } else {
    push("        todo!()", "witness");
  }
  push("    }", "witness");
  push("");
  push("    // runs once at compile time: create columns, allow equality, build gates", "config");
  push("    fn configure(meta: &mut ConstraintSystem<F>) -> Self::Config {", "config");
  advice.forEach((c) =>
    push(`        let ${ident(c)} = meta.advice_column();   // circuit-level, shareable`, "config", { col: c })
  );
  instance.forEach((c) => push(`        let ${ident(c)} = meta.instance_column();`, "config", { col: c }));
  push("");
  equality.forEach((c) =>
    push(`        meta.enable_equality(${ident(c)});   // allow copy constraints on ${c}`, "config", { col: c })
  );
  push("");
  chips.forEach((chip) => {
    const args = (chip.columns || []).map(ident).join(", ");
    push(`        let config = ${ident(chip.name)}::configure(meta, ${args});`, "config");
  });
  push(`        CircuitConfig { ${[...instance.map(ident), ...(chips.length ? ["config"] : [])].join(", ")} }`, "config");
  push("    }", "config");
  push("");

  /* ---- synthesize ---- */

  push("    // runs at proving time: fill rows, wire copies, pin public cells", "synth");
  push("    fn synthesize(", "synth");
  push("        &self,", "synth");
  push("        config: Self::Config,", "synth");
  push("        mut layouter: impl Layouter<F>,", "synth");
  push("    ) -> Result<(), ErrorFront> {", "synth");
  chips.forEach((chip) =>
    push(`        let chip = ${ident(chip.name)}::construct(config.config);`, "synth")
  );
  push("");

  loadRows.forEach((r) => {
    Object.values(r.cells).forEach((cell) => {
      const v = ident(cell.label);
      push(`        let ${v} = chip.unconstrained(&mut layouter, self.${v})?;   // row: ${r.op || r.id}`, "synth", { row: r.id });
    });
  });

  const findSource = (dstRef) => {
    for (const pair of circuit.copyConstraints || []) {
      if (pair[0] === dstRef) return pair[1];
      if (pair[1] === dstRef) return pair[0];
    }
    return null;
  };

  opRows.forEach((r) => {
    const sel = activeSel(r)[0];
    const hit = gateBySelector.get(sel);
    if (!hit) return push(`        // row ${r.id}: selector ${sel} has no gate defined`, "synth", { row: r.id });
    const chipCols = hit.chip.columns || [];
    if (chipCols.length < 3 || !r.cells?.[chipCols[chipCols.length - 1]]) {
      return push(`        // row ${r.id} (${r.op || ""}): does not fit the 2-in/1-out convention`, "synth", { row: r.id });
    }
    const outVar = ident(r.cells[chipCols[chipCols.length - 1]].label);
    producer.set(`${r.id}.${chipCols[chipCols.length - 1]}`, outVar);
    const args = [chipCols[0], chipCols[1]].map((c) => {
      const src = findSource(`${r.id}.${c}`);
      const v = src && producer.get(src);
      return v ? `${v}.clone()` : `/* ${r.cells?.[c]?.label ?? "?"}: assigned fresh in region */`;
    });
    push(
      `        let ${outVar} = chip.${methodName(hit.gate)}(&mut layouter, ${args.join(", ")})?;   // ${r.op || r.id}`,
      "synth",
      { row: r.id }
    );
  });

  push("");
  (circuit.instanceConstraints || []).forEach(([src, dst]) => {
    const dstRow = String(dst).split(".")[0];
    const idx = instanceRows.findIndex((r) => r.id === dstRow);
    const v = producer.get(src) || `/* ${src} */`;
    const instCol = instance[0] ? ident(instance[0]) : "instance";
    push(
      `        layouter.constrain_instance(${v}.cell(), config.${instCol}, ${idx === -1 ? 0 : idx})?;   // public: ${dst}`,
      "synth",
      { row: dstRow }
    );
  });
  push("        Ok(())", "synth");
  push("    }", "synth");
  push("}", "config");

  return lines;
};
