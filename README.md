# Halo2 Trace Inspector

**Live: https://thryec.github.io/halo2-visualizer/**

Static web app for learning Halo2 by looking at circuits as a PLONKish trace: typed columns, regions, assigned cells, selectors, rotation gates, copy constraints, lookup tables, and public instance pins. Every constraint is also *checked* against the assigned values, MockProver-style — edit a cell and watch exactly which constraint breaks.

Built alongside the RareSkills Halo2 course. Examples: `a^5 + a = b` (chip + copy constraints), Fibonacci (one column + rotation gate), and a range-checked add (lookups).

## Run

```sh
python3 -m http.server 8000
```

Open http://localhost:8000. No build step, no dependencies. Opening `index.html` directly also works.

## Views

- **configure** — the ownership story: `MyCircuit` holds only witness values; `Circuit::configure()` creates every column (advice at circuit level so chips can share) and enables equality; each chip borrows the advice columns passed to it and owns its selectors and gates. Gates can live inside chips (reusable) or at the top level (inline, one-off) — the configure walkthrough shows which is which. Lookup arguments and their tables get their own box. Gates that read multiple rows show a `↕ n rows` rotation badge.
- **synthesize** — the filled trace. Step through rows with the player (or ←/→) to watch cells get assigned, selectors switch on, and copy wires land. Consecutive rows in the same region are grouped with a heavier border. Cells sharing a color square belong to the same equality net; click a cell to see its wires and details. The **ok** column shows per-row gate + lookup results; the banner in the player bar totals every check. Lookup tables render under the trace; hovering a lookup card highlights the cells it constrains.
- **code** — homework-style Rust generated from the loaded circuit, color-coded by where each piece lives (`MyCircuit` / chip config / `CircuitConfig` / `synthesize()`), shown next to the trace. Hover a line to light up the column or row it creates or fills. Rotation gates emit `Rotation::next()` / `Rotation(2)` queries; lookups emit `meta.lookup` blocks and an `assign_table` skeleton. Rows that don't fit a generatable convention get honest `/* ... */` comments instead of guesses.

The **values** toggle shows concrete assignments (`a2 = 4`). Select any cell and use the **set** field in the side panel to change its value — all gates, lookups, copies and instance pins re-check immediately.

## Builder

The **Build** drawer turns an arithmetic statement into a full trace — no JSON needed. Enter something like `x^3 + x*y + y = out` with optional witness values (`x = 2, y = 3`) and Generate. Each `+` / `*` becomes one AddMulChip row, `^` is lowered by square-and-multiply, and repeated subexpressions are computed once and reused through copy constraints. Supported: variables, `+`, `*`, `^n`, parentheses; the right side is a single public input.

## Circuit JSON

Edit via the JSON drawer and press Render (or Cmd/Ctrl+Enter). Schema:

```jsonc
{
  "title": "…", "subtitle": "…",
  "modulus": "17",                      // optional: check arithmetic mod p
  "columns": {
    "advice": ["a", "b", "c"],
    "selectors": ["q_add", "q_mul"],
    "instance": ["instance"],
    "fixed": []
  },
  "equality": ["a", "b", "c", "instance"],    // columns with enable_equality
  "chips": [{
    "name": "AddMulChip",
    "columns": ["a", "b", "c"],
    "gates": [
      // constraints hold when the selector is on: q · (expr) = 0.
      // expression language: column names, rotations col@next / col@prev / col@2,
      // integers, + - *, parentheses. Multiple constraints per gate allowed.
      { "name": "mul gate", "selector": "q_mul", "constraints": ["a * b - c"] },
      { "name": "fib gate", "selector": "q_fib", "constraints": ["fib + fib@next - fib@2"] }
    ]
  }],
  "gates": [                            // optional: circuit-owned gates, declared inline
    { "name": "fib gate", "selector": "q_fib", "constraints": ["fib + fib@next - fib@2"] }
  ],
  "tables": [{                          // lookup tables, filled via assign_table
    "name": "range16",
    "columns": ["range"],
    "rows": [["0"], ["1"], ["2"]]
  }],
  "lookups": [{                         // each input tuple must equal some table row
    "name": "range check x",
    "selector": "q",                    // optional: only checked on selector-on rows
    "inputs": ["x"],                    // expressions, same language as gates
    "table": "range16",
    "tableColumns": ["range"]
  }],
  "rows": [{
    "id": "r1",                         // unique, used in constraint refs
    "region": "mul region",             // consecutive rows with the same region group together
    "op": "a2 = a · a",
    "cells": { "a": { "label": "a", "value": "2" } },   // value optional; enables checking
    "selectors": { "q_mul": 1 }
  }],
  "copyConstraints": [["r0.a", "r1.a"]],            // constrain_equal pairs, "rowId.column"
  "instanceConstraints": [["r4.c", "i0.instance"]]  // constrain_instance pairs
}
```

Validation reports unknown columns, bad refs, duplicate row ids, unparseable expressions, and mismatched lookup shapes with exact locations. Copy-net colors, region grouping, rotation footprints, and all checking are computed from the JSON, so any circuit expressible in this schema renders and verifies without code changes.

## Sharing

The **Share** button copies a link with the current circuit compressed into the URL hash — no backend, the whole circuit travels in the link. Anyone opening it sees exactly what you see.

## License

MIT
