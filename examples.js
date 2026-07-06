// Built-in example circuits. Each entry: { id, label, circuit }.
// Schema documented in README.md.
window.HALO2_EXAMPLES = [
  {
    id: "week5-p3",
    label: "a^5 + a = b (AddMulChip)",
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
            { name: "add gate", selector: "q_add", expression: "q_add · (a + b − c) = 0" },
            { name: "mul gate", selector: "q_mul", expression: "q_mul · (a · b − c) = 0" }
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
    label: "Fibonacci (FibChip)",
    circuit: {
      title: "Fibonacci",
      subtitle:
        "Each row proves f(i) + f(i+1) = f(i+2); copy constraints slide the window down one row at a time.",
      columns: {
        advice: ["a", "b", "c"],
        selectors: ["q_fib"],
        instance: ["instance"],
        fixed: []
      },
      equality: ["a", "b", "c", "instance"],
      chips: [
        {
          name: "FibChip",
          columns: ["a", "b", "c"],
          gates: [
            { name: "fib gate", selector: "q_fib", expression: "q_fib · (a + b − c) = 0" }
          ]
        }
      ],
      rows: [
        {
          id: "r0",
          region: "fib region",
          op: "f2 = f0 + f1",
          cells: {
            a: { label: "f0", value: "1" },
            b: { label: "f1", value: "1" },
            c: { label: "f2", value: "2" }
          },
          selectors: { q_fib: 1 }
        },
        {
          id: "r1",
          region: "fib region",
          op: "f3 = f1 + f2",
          cells: {
            a: { label: "f1", value: "1" },
            b: { label: "f2", value: "2" },
            c: { label: "f3", value: "3" }
          },
          selectors: { q_fib: 1 }
        },
        {
          id: "r2",
          region: "fib region",
          op: "f4 = f2 + f3",
          cells: {
            a: { label: "f2", value: "2" },
            b: { label: "f3", value: "3" },
            c: { label: "f4", value: "5" }
          },
          selectors: { q_fib: 1 }
        },
        {
          id: "r3",
          region: "fib region",
          op: "f5 = f3 + f4",
          cells: {
            a: { label: "f3", value: "3" },
            b: { label: "f4", value: "5" },
            c: { label: "f5", value: "8" }
          },
          selectors: { q_fib: 1 }
        },
        {
          id: "i0",
          region: "instance",
          op: "public f0",
          cells: { instance: { label: "f0", value: "1" } },
          selectors: {}
        },
        {
          id: "i1",
          region: "instance",
          op: "public f1",
          cells: { instance: { label: "f1", value: "1" } },
          selectors: {}
        },
        {
          id: "i2",
          region: "instance",
          op: "public f5",
          cells: { instance: { label: "f5", value: "8" } },
          selectors: {}
        }
      ],
      copyConstraints: [
        ["r0.b", "r1.a"],
        ["r0.c", "r1.b"],
        ["r1.b", "r2.a"],
        ["r1.c", "r2.b"],
        ["r2.b", "r3.a"],
        ["r2.c", "r3.b"]
      ],
      instanceConstraints: [
        ["r0.a", "i0.instance"],
        ["r0.b", "i1.instance"],
        ["r3.c", "i2.instance"]
      ]
    }
  }
];
