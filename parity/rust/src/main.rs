// Parity harness (halo2 ground truth). For each (circuit, case) in ../cases.json,
// build the real halo2 circuit with honest witness, apply the case's single-cell
// mutation, run MockProver, and print "<circuitId>,<caseId>,<pass|fail>" (sorted).
mod common;
mod fibonacci;
mod iszero;
mod range;
mod vanilla;
mod week5;

use common::{fr, Cells};

fn honest(circuit: &str) -> Cells {
    match circuit {
        "week5-p3" => week5::honest(),
        "fibonacci" => fibonacci::honest(),
        "iszero-multichip" => iszero::honest(),
        "vanilla-plonk" => vanilla::honest(),
        "range-add" => range::honest(),
        other => panic!("unknown circuit {other}"),
    }
}

fn run(circuit: &str, cells: &Cells) -> bool {
    match circuit {
        "week5-p3" => week5::run(cells),
        "fibonacci" => fibonacci::run(cells),
        "iszero-multichip" => iszero::run(cells),
        "vanilla-plonk" => vanilla::run(cells),
        "range-add" => range::run(cells),
        other => panic!("unknown circuit {other}"),
    }
}

fn main() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../cases.json");
    let text = std::fs::read_to_string(path).expect("read cases.json");
    let cases: serde_json::Value = serde_json::from_str(&text).expect("parse cases.json");

    let mut lines: Vec<String> = Vec::new();
    for case in cases.as_array().expect("cases is array") {
        let circuit = case["circuit"].as_str().unwrap();
        let case_id = case["case"].as_str().unwrap();
        let mut cells = honest(circuit);
        if let Some(cell) = case.get("cell").and_then(|v| v.as_str()) {
            let value = case["value"].as_str().expect("mutation value");
            cells.insert(cell.to_string(), fr(value));
        }
        let verdict = if run(circuit, &cells) { "pass" } else { "fail" };
        lines.push(format!("{circuit},{case_id},{verdict}"));
    }

    lines.sort();
    for l in lines {
        println!("{l}");
    }
}
