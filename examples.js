// Built-in example circuits. Each entry: { id, label, circuit }.
// Schema documented in README.md. Gate `constraints` and lookup `inputs` use the
// expression language from eval.js: columns, rotations (col@next, col@2), + - *, ints.
window.HALO2_EXAMPLES = [
  {
    id: "week5-p3",
    label: "a^5 + a = b (AddMulChip)",
    blurb: "one chip, values wired between rows with copy constraints",
    circuit: {
      title: "a⁵ + a = b",
      subtitle:
        "Private witness a flows through AddMulChip mul/add rows; the result is pinned to public input b.",
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
      rows: [
        {
          id: "r0",
          region: "unconstrained",
          op: "load private a",
          cells: { a: { label: "a", value: "2" } },
          selectors: {}
        },
        {
          id: "r1",
          region: "mul region",
          op: "a2 = a · a",
          cells: {
            a: { label: "a", value: "2" },
            b: { label: "a", value: "2" },
            c: { label: "a2", value: "4" }
          },
          selectors: { q_mul: 1 }
        },
        {
          id: "r2",
          region: "mul region",
          op: "a4 = a2 · a2",
          cells: {
            a: { label: "a2", value: "4" },
            b: { label: "a2", value: "4" },
            c: { label: "a4", value: "16" }
          },
          selectors: { q_mul: 1 }
        },
        {
          id: "r3",
          region: "mul region",
          op: "a5 = a4 · a",
          cells: {
            a: { label: "a4", value: "16" },
            b: { label: "a", value: "2" },
            c: { label: "a5", value: "32" }
          },
          selectors: { q_mul: 1 }
        },
        {
          id: "r4",
          region: "add region",
          op: "out = a5 + a",
          cells: {
            a: { label: "a5", value: "32" },
            b: { label: "a", value: "2" },
            c: { label: "out", value: "34" }
          },
          selectors: { q_add: 1 }
        },
        {
          id: "i0",
          region: "instance",
          op: "public input b",
          cells: { instance: { label: "b", value: "34" } },
          selectors: {}
        }
      ],
      copyConstraints: [
        ["r0.a", "r1.a"],
        ["r0.a", "r1.b"],
        ["r1.c", "r2.a"],
        ["r1.c", "r2.b"],
        ["r2.c", "r3.a"],
        ["r0.a", "r3.b"],
        ["r3.c", "r4.a"],
        ["r0.a", "r4.b"]
      ],
      instanceConstraints: [["r4.c", "i0.instance"]]
    }
  },
  {
    id: "fibonacci",
    label: "Fibonacci (rotation gate)",
    blurb: "chipless — the gate is declared inline in configure(), like one-off logic usually is",
    circuit: {
      title: "Fibonacci — one column, rotation gate",
      subtitle:
        "One advice column; the gate reads three rows at once (fib, fib@next, fib@2), so no copy constraints are needed. Compare with AddMulChip, which wires values with copies instead. The gate is declared inline — no chip — because nothing else reuses it.",
      columns: {
        advice: ["fib"],
        selectors: ["q_fib"],
        instance: ["instance"],
        fixed: []
      },
      equality: ["fib", "instance"],
      chips: [],
      gates: [
        { name: "fib gate", selector: "q_fib", constraints: ["fib + fib@next - fib@2"] }
      ],
      rows: [
        {
          id: "r0",
          region: "fib region",
          op: "f0 (witness)",
          cells: { fib: { label: "f0", value: "1" }, instance: { label: "f0", value: "1" } },
          selectors: { q_fib: 1 }
        },
        {
          id: "r1",
          region: "fib region",
          op: "f1 (witness)",
          cells: { fib: { label: "f1", value: "1" }, instance: { label: "f1", value: "1" } },
          selectors: { q_fib: 1 }
        },
        {
          id: "r2",
          region: "fib region",
          op: "f2 = f0 + f1",
          cells: { fib: { label: "f2", value: "2" }, instance: { label: "f5", value: "8" } },
          selectors: { q_fib: 1 }
        },
        {
          id: "r3",
          region: "fib region",
          op: "f3 = f1 + f2",
          cells: { fib: { label: "f3", value: "3" } },
          selectors: { q_fib: 1 }
        },
        {
          id: "r4",
          region: "fib region",
          op: "f4 = f2 + f3",
          cells: { fib: { label: "f4", value: "5" } },
          selectors: {}
        },
        {
          id: "r5",
          region: "fib region",
          op: "f5 = f3 + f4",
          cells: { fib: { label: "f5", value: "8" } },
          selectors: {}
        }
      ],
      copyConstraints: [],
      instanceConstraints: [
        ["r0.fib", "r0.instance"],
        ["r1.fib", "r1.instance"],
        ["r5.fib", "r2.instance"]
      ]
    }
  },
  {
    id: "iszero-multichip",
    label: "isZero(x·y) — two chips, shared columns",
    blurb: "two chips borrow the same advice columns; inverse-trick aux witness",
    circuit: {
      title: "isZero(x · y) — two chips share a, b, c",
      subtitle:
        "AddMulChip computes x·y, IsZeroChip tests it — both borrow the same three advice columns, each owns its own selector and gates. isZero needs an auxiliary witness: the inverse (mod 17 here).",
      modulus: "17",
      columns: {
        advice: ["a", "b", "c"],
        selectors: ["q_mul", "q_iz"],
        instance: ["instance"],
        fixed: []
      },
      equality: ["a", "b", "c", "instance"],
      chips: [
        {
          name: "AddMulChip",
          columns: ["a", "b", "c"],
          gates: [{ name: "mul gate", selector: "q_mul", constraints: ["a * b - c"] }]
        },
        {
          name: "IsZeroChip",
          columns: ["a", "b", "c"],
          gates: [
            {
              name: "is zero gate",
              selector: "q_iz",
              constraints: ["a * c", "1 - c - a * b"]
            }
          ]
        }
      ],
      rows: [
        {
          id: "r0",
          region: "unconstrained",
          op: "load private x",
          cells: { a: { label: "x", value: "3" } },
          selectors: {}
        },
        {
          id: "r1",
          region: "unconstrained",
          op: "load private y",
          cells: { a: { label: "y", value: "0" } },
          selectors: {}
        },
        {
          id: "r2",
          region: "mul region",
          op: "p = x · y",
          cells: {
            a: { label: "x", value: "3" },
            b: { label: "y", value: "0" },
            c: { label: "p", value: "0" }
          },
          selectors: { q_mul: 1 }
        },
        {
          id: "r3",
          region: "is zero region",
          op: "out = isZero(p)",
          cells: {
            a: { label: "p", value: "0" },
            b: { label: "p_inv", value: "0" },
            c: { label: "out", value: "1" }
          },
          selectors: { q_iz: 1 }
        },
        {
          id: "i0",
          region: "instance",
          op: "public out",
          cells: { instance: { label: "out", value: "1" } },
          selectors: {}
        }
      ],
      copyConstraints: [
        ["r0.a", "r2.a"],
        ["r1.a", "r2.b"],
        ["r2.c", "r3.a"]
      ],
      instanceConstraints: [["r3.c", "i0.instance"]]
    }
  },
  {
    id: "range-add",
    label: "x + y = z, range-checked (lookup)",
    blurb: "lookup argument pins every value into a 16-row table",
    circuit: {
      title: "x + y = z with 4-bit range checks",
      subtitle:
        "lec-6 pattern: an add gate plus three lookups pin x, y and z into a 16-row table. A lookup says: this value must appear somewhere in the table.",
      columns: {
        advice: ["x", "y", "z"],
        selectors: ["q"],
        instance: [],
        fixed: []
      },
      equality: [],
      chips: [
        {
          name: "AddChip",
          columns: ["x", "y", "z"],
          gates: [{ name: "add gate", selector: "q", constraints: ["x + y - z"] }]
        }
      ],
      tables: [
        {
          name: "range16",
          columns: ["range"],
          rows: [
            ["0"], ["1"], ["2"], ["3"], ["4"], ["5"], ["6"], ["7"],
            ["8"], ["9"], ["10"], ["11"], ["12"], ["13"], ["14"], ["15"]
          ]
        }
      ],
      lookups: [
        { name: "range check x", selector: "q", inputs: ["x"], table: "range16", tableColumns: ["range"] },
        { name: "range check y", selector: "q", inputs: ["y"], table: "range16", tableColumns: ["range"] },
        { name: "range check z", selector: "q", inputs: ["z"], table: "range16", tableColumns: ["range"] }
      ],
      rows: [
        {
          id: "r0",
          region: "region",
          op: "1 + 1 = 2",
          cells: {
            x: { label: "x0", value: "1" },
            y: { label: "y0", value: "1" },
            z: { label: "z0", value: "2" }
          },
          selectors: { q: 1 }
        },
        {
          id: "r1",
          region: "region",
          op: "1 + 2 = 3",
          cells: {
            x: { label: "x1", value: "1" },
            y: { label: "y1", value: "2" },
            z: { label: "z1", value: "3" }
          },
          selectors: { q: 1 }
        }
      ],
      copyConstraints: [],
      instanceConstraints: []
    }
  }
];
