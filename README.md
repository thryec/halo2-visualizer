# Halo2 Trace Inspector

Static web app for visualizing Halo2 circuits as a PLONKish trace: typed columns, regions, assigned cells, selectors, copy constraints, and public instance pins. Built as a learning aid for the RareSkills Halo2 course; the default example is week 5 problem 3 (`a^5 + a = b` via AddMulChip).

## Run

```sh
cd visualizer
python3 -m http.server 8000
```

Open http://localhost:8000. No build step, no dependencies. Opening `index.html` directly also works.

## Views

- **synthesize** — the filled trace. Step through rows with the player (or ←/→) to watch cells get assigned, selectors switch on, and copy wires land. Cells sharing a color square belong to the same equality net. Click a cell to see all wires in its net plus its details in the side panel; click a constraint in the side lists to highlight just that pair. Dashed violet wires are public instance pins.
- **configure** — the ownership story: `MyCircuit` holds only witness values; `Circuit::configure()` creates every column (advice at circuit level so chips can share) and enables equality; each chip borrows the advice columns passed to it and owns its selectors and gates.
- **code** — homework-style Rust generated from the loaded circuit, color-coded by where each piece lives (`MyCircuit` / chip config / `CircuitConfig` / `synthesize()`), shown next to the trace. Hover a line to light up the column or row it creates or fills. Circuits that fit the 2-in/1-out chip convention (like anything the builder emits) produce complete code; rows that don't fit get honest `/* ... */` comments instead of guesses.

The **values** toggle shows concrete assignments (`a2 = 4`) so gate identities can be checked by hand.

## Builder

The **Build** drawer turns an arithmetic statement into a full trace — no JSON needed. Enter something like `x^3 + x*y + y = out` with optional witness values (`x = 2, y = 3`) and Generate. Each `+` / `*` becomes one AddMulChip row, `^` is lowered by square-and-multiply, and repeated subexpressions are computed once and reused through copy constraints. The generated JSON lands in the JSON drawer so you can inspect or tweak it. Supported: variables, `+`, `*`, `^n`, parentheses; the right side is a single public input. Constants and `-` are rejected because AddMulChip has no gate for them.

## Circuit JSON

Edit via the JSON drawer (top right) and press Render. Schema:

```jsonc
{
  "title": "a⁵ + a = b",
  "subtitle": "optional one-liner",
  "columns": {
    "advice": ["a", "b", "c"],
    "selectors": ["q_add", "q_mul"],
    "instance": ["instance"],
    "fixed": []                      // optional
  },
  "equality": ["a", "b", "c", "instance"],   // columns with enable_equality
  "chips": [
    {
      "name": "AddMulChip",
      "columns": ["a", "b", "c"],
      "gates": [
        { "name": "mul gate", "selector": "q_mul", "expression": "q_mul · (a · b − c) = 0" }
      ]
    }
  ],
  "rows": [
    {
      "id": "r1",                    // unique, used in constraint refs
      "region": "mul region",        // layouter region name
      "op": "a2 = a · a",            // what this row computes
      "cells": {
        "a": { "label": "a", "value": "2" }   // value optional
      },
      "selectors": { "q_mul": 1 }
    }
  ],
  "copyConstraints": [["r0.a", "r1.a"]],      // constrain_equal pairs, "rowId.column"
  "instanceConstraints": [["r4.c", "i0.instance"]]  // constrain_instance pairs
}
```

Validation reports unknown columns, bad refs, and duplicate row ids with exact locations. Copy-net colors are computed automatically from the constraint graph, so any circuit expressible in this schema renders without code changes — a second built-in example (Fibonacci) is included in `examples.js`.
