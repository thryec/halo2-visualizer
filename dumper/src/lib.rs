//! Dump a synthesized halo2 circuit into the Halo2 Trace Inspector JSON schema.
//!
//! Structure (columns, gates, lookups, permutation) is read from a fresh, *uncompressed*
//! `ConstraintSystem` built by calling `Circuit::configure` directly. Cell values come from
//! `MockProver`, whose own `cs` is selector-compressed and therefore useless for reading back
//! the original selector-carrying gate polynomials.

use ff::{FromUniformBytes, PrimeField};
use halo2_proofs::dev::{CellValue, InstanceValue, MockProver};
use halo2_proofs::plonk::{Any, Circuit, ConstraintSystem, Expression};
use serde_json::{json, Map, Value};

/// Dump `circuit` (already known to verify) to a pretty JSON string.
pub fn dump<F, C>(k: u32, circuit: &C, instances: Vec<Vec<F>>) -> String
where
    F: PrimeField + FromUniformBytes<64> + Ord,
    C: Circuit<F>,
{
    // Uncompressed constraint system: selectors survive as `Expression::Selector`.
    let mut cs = ConstraintSystem::<F>::default();
    let _ = C::configure(&mut cs);

    let prover = MockProver::run(k, circuit, instances).expect("MockProver::run failed");

    let n_advice = cs.num_advice_columns();
    let n_fixed = cs.num_fixed_columns();
    let n_instance = cs.num_instance_columns();
    let n_selectors = cs.num_selectors();

    let advice_names: Vec<String> = (0..n_advice).map(|i| format!("a{i}")).collect();
    let fixed_names: Vec<String> = (0..n_fixed).map(|i| format!("f{i}")).collect();
    let instance_names: Vec<String> = (0..n_instance).map(|i| format!("i{i}")).collect();
    let selector_names: Vec<String> = (0..n_selectors).map(|i| format!("q{i}")).collect();

    let mut notes: Vec<String> = Vec::new();
    notes.push(
        "copy constraints not exposed by halo2 public API (permutation assembly is private); \
         region names unavailable (dev::Region is private)"
            .to_string(),
    );

    // ---- gates ----
    let mut gates_json: Vec<Value> = Vec::new();
    for gate in cs.gates() {
        translate_gate(gate.name(), gate.polynomials(), &mut gates_json, &mut notes);
    }

    // ---- lookups + their tables ----
    // Fixed columns consumed as lookup tables are excluded from columns.fixed / row cells.
    let mut lookup_table_cols: Vec<usize> = Vec::new();
    let mut tables_json: Vec<Value> = Vec::new();
    let mut lookups_json: Vec<Value> = Vec::new();
    for (n, arg) in cs.lookups().iter().enumerate() {
        translate_lookup(
            n,
            arg.name(),
            arg.input_expressions(),
            arg.table_expressions(),
            &prover,
            &mut tables_json,
            &mut lookups_json,
            &mut lookup_table_cols,
            &mut notes,
        );
    }

    // fixed columns to render as ordinary columns (exclude ones used as lookup tables)
    let visible_fixed: Vec<usize> = (0..n_fixed)
        .filter(|i| !lookup_table_cols.contains(i))
        .collect();
    let fixed_col_names: Vec<String> = visible_fixed.iter().map(|&i| fixed_names[i].clone()).collect();

    // ---- equality (permutation-enabled columns) ----
    let equality: Vec<String> = cs
        .permutation()
        .get_columns()
        .iter()
        .map(|c| column_name(c.column_type(), c.index()))
        .collect();

    // ---- rows ----
    let usable = prover.usable_rows().end;
    let advice = prover.advice();
    let fixed = prover.fixed();
    let instance = prover.instance();
    let selectors = prover.selectors();

    let mut rows: Vec<(usize, Value)> = Vec::new();
    for row in 0..usable {
        let mut cells = Map::new();
        let mut any_cell = false;

        for i in 0..n_advice {
            if let CellValue::Assigned(v) = advice[i][row] {
                cells.insert(advice_names[i].clone(), cell_value(v));
                any_cell = true;
            }
        }
        for &i in &visible_fixed {
            if let CellValue::Assigned(v) = fixed[i][row] {
                cells.insert(fixed_names[i].clone(), cell_value(v));
                any_cell = true;
            }
        }
        for i in 0..n_instance {
            if let InstanceValue::Assigned(v) = instance[i][row] {
                cells.insert(instance_names[i].clone(), cell_value(v));
                any_cell = true;
            }
        }

        let mut sels = Map::new();
        let mut any_sel = false;
        for i in 0..n_selectors {
            if selectors[i][row] {
                sels.insert(selector_names[i].clone(), json!(1));
                any_sel = true;
            }
        }

        if !any_cell && !any_sel {
            rows.push((row, Value::Null)); // placeholder; trimmed if trailing
        } else {
            rows.push((
                row,
                json!({
                    "id": format!("r{row}"),
                    "region": "",
                    "op": "",
                    "cells": Value::Object(cells),
                    "selectors": Value::Object(sels),
                }),
            ));
        }
    }

    // trim trailing empty rows
    while matches!(rows.last(), Some((_, Value::Null))) {
        rows.pop();
    }
    // empty interior rows still need a valid id so refs stay stable
    let rows_json: Vec<Value> = rows
        .into_iter()
        .map(|(row, v)| {
            if v.is_null() {
                json!({
                    "id": format!("r{row}"),
                    "region": "",
                    "op": "",
                    "cells": {},
                    "selectors": {},
                })
            } else {
                v
            }
        })
        .collect();

    let modulus = hex_to_decimal(F::MODULUS);

    let out = json!({
        "title": "dumped circuit",
        "subtitle": "structure from a fresh ConstraintSystem; values from MockProver",
        "modulus": modulus,
        "columns": {
            "advice": advice_names,
            "selectors": selector_names,
            "instance": instance_names,
            "fixed": fixed_col_names,
        },
        "equality": equality,
        "chips": [],
        "gates": gates_json,
        "tables": tables_json,
        "lookups": lookups_json,
        "rows": rows_json,
        "copyConstraints": [],
        "instanceConstraints": [],
        "dumperNotes": notes.join(" | "),
    });

    serde_json::to_string_pretty(&out).expect("serialize")
}

/// A translated expression fragment.
struct Node {
    text: String,
    prec: u8, // 0 = atom, 1 = product/negation, 2 = sum
    ok: bool,
    reason: Option<String>,
}

fn column_name(ty: &Any, index: usize) -> String {
    let p = match ty {
        Any::Advice => "a",
        Any::Fixed => "f",
        Any::Instance => "i",
    };
    format!("{p}{index}")
}

/// Cell JSON: label and value are both the decimal of the field element's canonical repr.
fn cell_value<F: PrimeField>(v: F) -> Value {
    let d = field_to_decimal(&v);
    json!({ "label": d, "value": d })
}

/// Flatten a top-level product tree into its factor list (only splitting on `Product`).
fn collect_factors<'a, F: PrimeField>(e: &'a Expression<F>, out: &mut Vec<&'a Expression<F>>) {
    match e {
        Expression::Product(a, b) => {
            collect_factors(a, out);
            collect_factors(b, out);
        }
        _ => out.push(e),
    }
}

fn as_selector<F: PrimeField>(e: &Expression<F>) -> Option<usize> {
    match e {
        Expression::Selector(s) => Some(s.index()),
        _ => None,
    }
}

/// Translate one halo2 gate into JSON entries (one per stripped selector) appended to `gates_json`.
fn translate_gate<F: PrimeField>(
    gate_name: &str,
    polys: &[Expression<F>],
    gates_json: &mut Vec<Value>,
    notes: &mut Vec<String>,
) {
    // group polynomials by the selector they are gated on
    let mut groups: Vec<(usize, Vec<String>)> = Vec::new(); // (selector idx, constraints)
    let mut unsupported: Vec<(String, String)> = Vec::new(); // (raw, reason)

    for poly in polys {
        let mut factors = Vec::new();
        collect_factors(poly, &mut factors);
        let sels: Vec<usize> = factors.iter().filter_map(|f| as_selector(f)).collect();
        let rest: Vec<&Expression<F>> = factors
            .iter()
            .copied()
            .filter(|f| as_selector(f).is_none())
            .collect();

        if sels.len() == 1 && !rest.is_empty() {
            let nodes: Vec<Node> = rest.iter().map(|e| translate(e)).collect();
            if let Some(bad) = nodes.iter().find(|n| !n.ok) {
                unsupported.push((
                    translate(poly).text,
                    bad.reason.clone().unwrap_or_else(|| "unsupported leaf".into()),
                ));
            } else {
                let text = join_product(&nodes);
                let sel = sels[0];
                if let Some(g) = groups.iter_mut().find(|(s, _)| *s == sel) {
                    g.1.push(text);
                } else {
                    groups.push((sel, vec![text]));
                }
            }
        } else {
            let reason = if sels.is_empty() {
                "polynomial has no selector factor".to_string()
            } else if sels.len() > 1 {
                "polynomial has more than one selector factor".to_string()
            } else {
                "polynomial is a bare selector".to_string()
            };
            unsupported.push((translate(poly).text, reason));
        }
    }

    let split = groups.len() > 1;
    for (idx, (sel, constraints)) in groups.into_iter().enumerate() {
        let name = if split && idx > 0 {
            format!("{} #{}", gate_name, idx + 1)
        } else {
            gate_name.to_string()
        };
        gates_json.push(json!({
            "name": name,
            "selector": format!("q{sel}"),
            "constraints": constraints,
        }));
    }

    for (raw, reason) in unsupported {
        gates_json.push(json!({
            "name": gate_name,
            "selector": "q0",
            "constraints": [],
            "unsupported": true,
            "raw": raw,
        }));
        notes.push(format!("gate \"{}\" polynomial not dumpable: {} (raw: {})", gate_name, reason, raw));
    }
}

/// Translate a lookup argument. Emits a table + lookup when the shape is supported.
fn translate_lookup<F: PrimeField + Ord + FromUniformBytes<64>>(
    n: usize,
    lk_name: &str,
    input_exprs: &[Expression<F>],
    table_exprs: &[Expression<F>],
    prover: &MockProver<F>,
    tables_json: &mut Vec<Value>,
    lookups_json: &mut Vec<Value>,
    lookup_table_cols: &mut Vec<usize>,
    notes: &mut Vec<String>,
) {
    // inputs: each must be Product(Selector, X) with one shared selector, or all bare (no selector)
    let mut sel: Option<usize> = None;
    let mut ok = true;
    let mut inputs_text: Vec<String> = Vec::new();
    let mut sel_count = 0usize;

    for expr in input_exprs {
        let mut factors = Vec::new();
        collect_factors(expr, &mut factors);
        let sels: Vec<usize> = factors.iter().filter_map(|f| as_selector(f)).collect();
        let rest: Vec<&Expression<F>> = factors
            .iter()
            .copied()
            .filter(|f| as_selector(f).is_none())
            .collect();
        if sels.len() > 1 || rest.is_empty() {
            ok = false;
            break;
        }
        if let Some(&s) = sels.first() {
            sel_count += 1;
            match sel {
                Some(prev) if prev != s => {
                    ok = false;
                    break;
                }
                _ => sel = Some(s),
            }
        }
        let nodes: Vec<Node> = rest.iter().map(|e| translate(e)).collect();
        if nodes.iter().any(|nn| !nn.ok) {
            ok = false;
            break;
        }
        inputs_text.push(join_product(&nodes));
    }
    // selectors must be all-present or all-absent
    if sel_count != 0 && sel_count != input_exprs.len() {
        ok = false;
    }

    // table expressions: every one a bare Fixed query at rotation 0
    let mut table_fixed_cols: Vec<usize> = Vec::new();
    if ok {
        for expr in table_exprs {
            match expr {
                Expression::Fixed(q) if q.rotation().0 == 0 => table_fixed_cols.push(q.column_index()),
                _ => {
                    ok = false;
                    break;
                }
            }
        }
    }
    if table_exprs.is_empty() {
        ok = false;
    }

    if !ok {
        notes.push(format!(
            "lookup \"{}\" skipped: unsupported shape (inputs must be selector·expr or bare; table must be bare fixed columns)",
            lk_name
        ));
        return;
    }

    // build table rows from the fixed columns' assigned values across usable rows
    let fixed = prover.fixed();
    let usable = prover.usable_rows().end;
    let table_names: Vec<String> = table_fixed_cols.iter().map(|&i| format!("f{i}")).collect();
    let mut table_rows: Vec<Value> = Vec::new();
    for row in 0..usable {
        let mut tuple: Vec<String> = Vec::new();
        let mut complete = true;
        for &c in &table_fixed_cols {
            if let CellValue::Assigned(v) = fixed[c][row] {
                tuple.push(field_to_decimal(&v));
            } else {
                complete = false;
                break;
            }
        }
        if !complete {
            break;
        }
        table_rows.push(json!(tuple));
    }

    let table_name = format!("table{n}");
    tables_json.push(json!({
        "name": table_name,
        "columns": table_names,
        "rows": table_rows,
    }));

    let mut lookup = Map::new();
    lookup.insert("name".into(), json!(format!("lookup{n}")));
    if let Some(s) = sel {
        lookup.insert("selector".into(), json!(format!("q{s}")));
    }
    lookup.insert("inputs".into(), json!(inputs_text));
    lookup.insert("table".into(), json!(table_name));
    lookup.insert("tableColumns".into(), json!(table_names));
    lookups_json.push(Value::Object(lookup));

    for c in table_fixed_cols {
        if !lookup_table_cols.contains(&c) {
            lookup_table_cols.push(c);
        }
    }
    notes.push(format!(
        "lookup \"{}\" table stored as fixed columns; those columns excluded from the trace",
        lk_name
    ));
}

/// Wrap a factor's text in parens when it is a top-level sum.
fn wrap(n: &Node) -> String {
    if n.prec >= 2 {
        format!("({})", n.text)
    } else {
        n.text.clone()
    }
}

/// Join product factors, parenthesizing sums when more than one factor is present.
fn join_product(nodes: &[Node]) -> String {
    if nodes.len() == 1 {
        return nodes[0].text.clone();
    }
    nodes.iter().map(wrap).collect::<Vec<_>>().join(" * ")
}

/// Structural translation of an expression (no top-level selector expected).
fn translate<F: PrimeField>(e: &Expression<F>) -> Node {
    match e {
        Expression::Constant(c) => Node {
            text: field_to_decimal(c),
            prec: 0,
            ok: true,
            reason: None,
        },
        Expression::Selector(s) => Node {
            text: format!("q{}", s.index()),
            prec: 0,
            ok: false,
            reason: Some("selector not a top-level product factor".into()),
        },
        Expression::Fixed(q) => Node {
            text: query_name("f", q.column_index(), q.rotation().0),
            prec: 0,
            ok: true,
            reason: None,
        },
        Expression::Advice(q) => Node {
            text: query_name("a", q.column_index(), q.rotation().0),
            prec: 0,
            ok: true,
            reason: None,
        },
        Expression::Instance(q) => Node {
            text: query_name("i", q.column_index(), q.rotation().0),
            prec: 0,
            ok: false,
            reason: Some("instance query in gate".into()),
        },
        Expression::Challenge(_) => Node {
            text: "challenge".into(),
            prec: 0,
            ok: false,
            reason: Some("challenge".into()),
        },
        Expression::Negated(a) => {
            let inner = translate(a);
            Node {
                text: format!("-({})", inner.text),
                prec: 1,
                ok: inner.ok,
                reason: inner.reason,
            }
        }
        Expression::Sum(a, b) => {
            let la = translate(a);
            let lb = translate(b);
            let reason = la.reason.clone().or_else(|| lb.reason.clone());
            Node {
                text: format!("{} + {}", la.text, lb.text),
                prec: 2,
                ok: la.ok && lb.ok,
                reason,
            }
        }
        Expression::Product(a, b) => {
            let la = translate(a);
            let lb = translate(b);
            let reason = la.reason.clone().or_else(|| lb.reason.clone());
            Node {
                text: format!("{} * {}", wrap(&la), wrap(&lb)),
                prec: 1,
                ok: la.ok && lb.ok,
                reason,
            }
        }
        Expression::Scaled(a, c) => {
            let la = translate(a);
            Node {
                text: format!("{} * {}", field_to_decimal(c), wrap(&la)),
                prec: 1,
                ok: la.ok,
                reason: la.reason,
            }
        }
    }
}

fn query_name(prefix: &str, col: usize, rot: i32) -> String {
    if rot == 0 {
        format!("{prefix}{col}")
    } else {
        format!("{prefix}{col}@{rot}")
    }
}

/// Decimal of a field element from its little-endian canonical repr.
fn field_to_decimal<F: PrimeField>(f: &F) -> String {
    bytes_le_to_decimal(f.to_repr().as_ref())
}

/// Convert little-endian bytes to a base-10 decimal string.
fn bytes_le_to_decimal(bytes: &[u8]) -> String {
    let mut digits: Vec<u8> = vec![0]; // big-endian decimal digits
    for &byte in bytes.iter().rev() {
        let mut carry = byte as u32;
        for d in digits.iter_mut().rev() {
            let v = (*d as u32) * 256 + carry;
            *d = (v % 10) as u8;
            carry = v / 10;
        }
        while carry > 0 {
            digits.insert(0, (carry % 10) as u8);
            carry /= 10;
        }
    }
    strip(digits)
}

/// Convert a hex string (optionally `0x`-prefixed) to a base-10 decimal string.
fn hex_to_decimal(hex: &str) -> String {
    let hex = hex.trim_start_matches("0x").trim_start_matches("0X");
    let mut digits: Vec<u8> = vec![0];
    for c in hex.chars() {
        let nib = match c.to_digit(16) {
            Some(v) => v,
            None => continue,
        };
        let mut carry = nib;
        for d in digits.iter_mut().rev() {
            let v = (*d as u32) * 16 + carry;
            *d = (v % 10) as u8;
            carry = v / 10;
        }
        while carry > 0 {
            digits.insert(0, (carry % 10) as u8);
            carry /= 10;
        }
    }
    strip(digits)
}

fn strip(digits: Vec<u8>) -> String {
    let s: String = digits.iter().map(|d| (b'0' + d) as char).collect();
    let t = s.trim_start_matches('0');
    if t.is_empty() {
        "0".to_string()
    } else {
        t.to_string()
    }
}
