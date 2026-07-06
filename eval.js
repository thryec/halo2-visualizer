/* Gate-expression language + constraint checker (MockProver-style).
 *
 * Expression grammar (used in chip gate `constraints` and lookup `inputs`):
 *   expr    := term (('+'|'-') term)*
 *   term    := factor ('*' factor)*
 *   factor  := INT | colref | '(' expr ')' | '-' factor
 *   colref  := column ('@' rotation)?      rotation: next | prev | integer
 * A constraint holds when (selector on) => expr == 0.
 */

(() => {
  function tokenize(src) {
    const tokens = src.match(/[A-Za-z_]\w*(@(-?\d+|next|prev))?|\d+|[()+\-*·−]/g) || [];
    if (tokens.join("").replace(/\s/g, "") !== src.replace(/\s/g, "")) {
      throw new Error(`unrecognized characters in "${src}"`);
    }
    return tokens.map((t) => (t === "·" ? "*" : t === "−" ? "-" : t));
  }

  // parse to AST: {op:'num',v} | {op:'ref',col,rot} | {op:'+'|'-'|'*',l,r} | {op:'neg',e}
  function parseExpr(src) {
    const tokens = tokenize(src);
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];

    function expr() {
      let n = term();
      while (peek() === "+" || peek() === "-") {
        const op = next();
        n = { op, l: n, r: term() };
      }
      return n;
    }
    function term() {
      let n = factor();
      while (peek() === "*") {
        next();
        n = { op: "*", l: n, r: factor() };
      }
      return n;
    }
    function factor() {
      const tok = next();
      if (tok === undefined) throw new Error(`"${src}": ended unexpectedly`);
      if (tok === "-") return { op: "neg", e: factor() };
      if (tok === "(") {
        const n = expr();
        if (next() !== ")") throw new Error(`"${src}": missing )`);
        return n;
      }
      if (/^\d+$/.test(tok)) return { op: "num", v: BigInt(tok) };
      const m = tok.match(/^([A-Za-z_]\w*)(?:@(-?\d+|next|prev))?$/);
      if (!m) throw new Error(`"${src}": unexpected token "${tok}"`);
      const rot = m[2] === undefined ? 0 : m[2] === "next" ? 1 : m[2] === "prev" ? -1 : parseInt(m[2], 10);
      return { op: "ref", col: m[1], rot };
    }

    const root = expr();
    if (pos < tokens.length) throw new Error(`"${src}": unexpected token "${tokens[pos]}"`);
    return root;
  }

  function refsOf(ast, out = []) {
    if (!ast) return out;
    if (ast.op === "ref") out.push({ col: ast.col, rot: ast.rot });
    if (ast.l) refsOf(ast.l, out);
    if (ast.r) refsOf(ast.r, out);
    if (ast.e) refsOf(ast.e, out);
    return out;
  }

  // evaluate at rowIdx; getValue(col, rowIdx) -> BigInt | undefined
  // returns BigInt, or undefined if any referenced cell has no value
  function evalAt(ast, rowIdx, getValue) {
    switch (ast.op) {
      case "num":
        return ast.v;
      case "ref":
        return getValue(ast.col, rowIdx + ast.rot);
      case "neg": {
        const v = evalAt(ast.e, rowIdx, getValue);
        return v === undefined ? undefined : -v;
      }
      default: {
        const l = evalAt(ast.l, rowIdx, getValue);
        const r = evalAt(ast.r, rowIdx, getValue);
        if (l === undefined || r === undefined) return undefined;
        return ast.op === "+" ? l + r : ast.op === "-" ? l - r : l * r;
      }
    }
  }

  /* Check every constraint. Returns:
   * {
   *   rows: Map(rowId -> [{kind, name, detail, ok}]),   // gate + lookup results per row
   *   pairs: [{pair, kind:'copy'|'public', ok, detail}],
   *   failures: number, checked: number, incomplete: number
   * }
   */
  function checkCircuit(circuit, derived) {
    const mod = circuit.modulus ? BigInt(circuit.modulus) : null;
    const norm = (v) => (mod ? ((v % mod) + mod) % mod : v);

    const rows = circuit.rows || [];
    const valueAt = (col, i) => {
      if (i < 0 || i >= rows.length) return undefined;
      const raw = rows[i].cells?.[col]?.value;
      if (raw === undefined) return undefined;
      try {
        return BigInt(raw);
      } catch {
        return undefined;
      }
    };

    const result = { rows: new Map(), pairs: [], failures: 0, checked: 0, incomplete: 0 };
    const rowResult = (id) => {
      if (!result.rows.has(id)) result.rows.set(id, []);
      return result.rows.get(id);
    };
    const record = (rowId, kind, name, ok, detail) => {
      rowResult(rowId).push({ kind, name, ok, detail });
      if (ok === false) result.failures++;
      if (ok === undefined) result.incomplete++;
      else result.checked++;
    };

    // gates
    [...(circuit.gates || []), ...(circuit.chips || []).flatMap((c) => c.gates || [])].forEach((gate) => {
      let asts;
      try {
        asts = (gate.constraints || []).map(parseExpr);
      } catch (e) {
        rows.forEach(() => {});
        return; // parse errors surface via validate(), not here
      }
      rows.forEach((row, i) => {
        if (!row.selectors?.[gate.selector]) return;
        asts.forEach((ast, ci) => {
          const v = evalAt(ast, i, valueAt);
          const name = `${gate.name || gate.selector}[${ci}]`;
          if (v === undefined) record(row.id, "gate", name, undefined, "missing values");
          else {
            const ok = norm(v) === 0n;
            record(row.id, "gate", name, ok, ok ? "" : `${gate.constraints[ci]} = ${norm(v)} ≠ 0`);
          }
        });
      });
    });

    // lookups
    const tableByName = new Map((circuit.tables || []).map((t) => [t.name, t]));
    (circuit.lookups || []).forEach((lk) => {
      const table = tableByName.get(lk.table);
      if (!table) return;
      let asts;
      try {
        asts = (lk.inputs || []).map(parseExpr);
      } catch {
        return;
      }
      const tupleSet = new Set(
        (table.rows || []).map((r) =>
          (lk.tableColumns || table.columns)
            .map((c) => {
              const idx = table.columns.indexOf(c);
              return norm(BigInt(r[idx])).toString();
            })
            .join(",")
        )
      );
      rows.forEach((row, i) => {
        if (lk.selector && !row.selectors?.[lk.selector]) return;
        const tuple = asts.map((ast) => evalAt(ast, i, valueAt));
        if (tuple.some((v) => v === undefined)) {
          if (!lk.selector) return; // unselected sparse rows: skip silently
          record(row.id, "lookup", lk.name, undefined, "missing values");
          return;
        }
        const key = tuple.map((v) => norm(v).toString()).join(",");
        const ok = tupleSet.has(key);
        record(row.id, "lookup", lk.name, ok, ok ? "" : `(${key}) not in table "${lk.table}"`);
      });
    });

    // copy constraints: both endpoint values must match
    const refValue = (ref) => {
      const i = ref.indexOf(".");
      const rowIdx = derived.rowIndex.get(ref.slice(0, i));
      return rowIdx === undefined ? undefined : valueAt(ref.slice(i + 1), rowIdx);
    };
    const checkPair = (pair, kind) => {
      const [a, b] = pair.map(refValue);
      if (a === undefined || b === undefined) {
        result.pairs.push({ pair, kind, ok: undefined, detail: "missing values" });
        result.incomplete++;
        return;
      }
      const ok = norm(a) === norm(b);
      result.pairs.push({ pair, kind, ok, detail: ok ? "" : `${norm(a)} ≠ ${norm(b)}` });
      if (!ok) result.failures++;
      result.checked++;
    };
    (circuit.copyConstraints || []).forEach((p) => checkPair(p, "copy"));
    (circuit.instanceConstraints || []).forEach((p) => checkPair(p, "public"));

    return result;
  }

  window.HALO2_EVAL = { parseExpr, refsOf, evalAt, checkCircuit };
})();
