/* Expression -> circuit compiler.
 * Lowers an arithmetic statement like "a^5 + a = b" onto AddMulChip rows:
 * one row per + / ·, square-and-multiply for ^, CSE via memoization so
 * repeated subexpressions are computed once and wired with copy constraints. */

window.buildCircuit = function (statement, witnessStr) {
  const witness = {};
  if (witnessStr && witnessStr.trim()) {
    witnessStr.split(",").forEach((part) => {
      const m = part.trim().match(/^([A-Za-z_]\w*)\s*=\s*(-?\d+)$/);
      if (!m) throw new Error(`bad witness entry "${part.trim()}" — expected: name = integer`);
      witness[m[1]] = BigInt(m[2]);
    });
  }
  const hasWitness = Object.keys(witness).length > 0;

  const sides = statement.split("=");
  if (sides.length !== 2) throw new Error('statement must be "<expression> = <public name>", e.g. "a^5 + a = b"');
  const exprSrc = sides[0].trim();
  const pubName = sides[1].trim();
  if (!/^[A-Za-z_]\w*$/.test(pubName)) {
    throw new Error(`right side must be a single public input name, got "${pubName}"`);
  }

  /* ---- parse ---- */

  const tokens = exprSrc.match(/[A-Za-z_]\w*|\d+|[()+*^·]|\S/g) || [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function fail(tok) {
    if (tok === "-" || tok === "/") {
      throw new Error(`"${tok}" not supported — AddMulChip only has add and mul gates (use + · ^)`);
    }
    throw new Error(`unexpected token "${tok}" in expression`);
  }

  function parseExpr() {
    let node = parseTerm();
    while (peek() === "+") {
      next();
      node = { op: "add", l: node, r: parseTerm() };
    }
    return node;
  }

  function parseTerm() {
    let node = parseFactor();
    while (peek() === "*" || peek() === "·") {
      next();
      node = { op: "mul", l: node, r: parseFactor() };
    }
    return node;
  }

  function parseFactor() {
    let node = parsePrimary();
    if (peek() === "^") {
      next();
      const e = next();
      if (!/^\d+$/.test(e || "")) throw new Error(`"^" needs an integer exponent, got "${e}"`);
      const n = parseInt(e, 10);
      if (n < 1) throw new Error("exponent must be >= 1");
      if (n > 64) throw new Error("exponent too large (max 64)");
      node = pow(node, n);
    }
    return node;
  }

  function parsePrimary() {
    const tok = next();
    if (tok === undefined) throw new Error("expression ended unexpectedly");
    if (tok === "(") {
      const node = parseExpr();
      if (next() !== ")") throw new Error("missing closing )");
      return node;
    }
    if (/^\d+$/.test(tok)) {
      throw new Error(`constant "${tok}" not supported — AddMulChip has no constant/fixed gate; use variables`);
    }
    if (/^[A-Za-z_]\w*$/.test(tok)) {
      if (tok === pubName) throw new Error(`"${tok}" is the public output — it cannot appear on the left side`);
      return { op: "var", name: tok };
    }
    fail(tok);
  }

  // square-and-multiply, produces shared subtrees that CSE turns into copies
  function pow(base, n) {
    if (n === 1) return base;
    if (n % 2 === 0) {
      const half = pow(base, n / 2);
      return { op: "mul", l: half, r: half };
    }
    return { op: "mul", l: pow(base, n - 1), r: base };
  }

  const root = parseExpr();
  if (pos < tokens.length) fail(tokens[pos]);

  /* ---- lower to rows ---- */

  const rows = [];
  const copies = [];
  const memo = new Map();
  let tmpCount = 0;

  // canonical key; sort operands so a*b and b*a share a row
  function keyOf(node) {
    if (node.op === "var") return node.name;
    const [x, y] = [keyOf(node.l), keyOf(node.r)].sort();
    return `(${x}${node.op === "add" ? "+" : "*"}${y})`;
  }

  function emit(node) {
    const key = keyOf(node);
    if (memo.has(key)) return memo.get(key);

    let result;
    if (node.op === "var") {
      const id = `r${rows.length}`;
      const value = hasWitness ? witness[node.name] : undefined;
      if (hasWitness && value === undefined) {
        throw new Error(`no witness value given for "${node.name}"`);
      }
      rows.push({
        id,
        region: "unconstrained",
        op: `load private ${node.name}`,
        cells: { a: cell(node.name, value) },
        selectors: {}
      });
      result = { ref: `${id}.a`, label: node.name, value, pow: { base: node.name, exp: 1 } };
    } else {
      const l = emit(node.l);
      const r = emit(node.r);
      const id = `r${rows.length}`;

      let value;
      if (l.value !== undefined && r.value !== undefined) {
        value = node.op === "add" ? l.value + r.value : l.value * r.value;
      }

      // label: pure powers of one variable get "a2"-style names, else t1, t2, ...
      let powInfo = null;
      if (node.op === "mul" && l.pow && r.pow && l.pow.base === r.pow.base) {
        powInfo = { base: l.pow.base, exp: l.pow.exp + r.pow.exp };
      }
      const isOut = keyOf(node) === keyOf(root);
      const label = isOut ? "out" : powInfo ? `${powInfo.base}${powInfo.exp}` : `t${++tmpCount}`;

      const sym = node.op === "add" ? "+" : "·";
      rows.push({
        id,
        region: node.op === "add" ? "add region" : "mul region",
        op: `${label} = ${l.label} ${sym} ${r.label}`,
        cells: { a: cell(l.label, l.value), b: cell(r.label, r.value), c: cell(label, value) },
        selectors: node.op === "add" ? { q_add: 1 } : { q_mul: 1 }
      });
      copies.push([l.ref, `${id}.a`], [r.ref, `${id}.b`]);
      result = { ref: `${id}.c`, label, value, pow: powInfo };
    }

    if (rows.length > 200) throw new Error("circuit too large (over 200 rows)");
    memo.set(key, result);
    return result;
  }

  function cell(label, value) {
    return value !== undefined ? { label, value: value.toString() } : { label };
  }

  const out = emit(root);

  rows.push({
    id: "i0",
    region: "instance",
    op: `public input ${pubName}`,
    cells: { instance: cell(pubName, out.value) },
    selectors: {}
  });

  return {
    title: `${exprSrc} = ${pubName}`,
    subtitle:
      "generated by the builder: each + / · is one AddMulChip row; repeated subexpressions are computed once and reused via copy constraints.",
    columns: {
      advice: ["a", "b", "c"],
      selectors: ["q_add", "q_mul"],
      instance: ["instance"],
      fixed: []
    },
    equality: ["a", "b", "c", "instance"],
    chips: [
      {
        name: "AddMulChip",
        columns: ["a", "b", "c"],
        gates: [
          { name: "add gate", selector: "q_add", constraints: ["a + b - c"] },
          { name: "mul gate", selector: "q_mul", constraints: ["a * b - c"] }
        ]
      }
    ],
    rows,
    copyConstraints: copies,
    instanceConstraints: [[out.ref, "i0.instance"]]
  };
};
