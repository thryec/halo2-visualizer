// Shared helpers: the injected per-cell value map and small-int -> Fr parsing.
// A `Cells` map is keyed "rowId.column" mirroring the eval.js JSON rows, so a
// mutation is exactly one map insert.
use halo2_proofs::halo2curves::bn256::Fr;
use std::collections::BTreeMap;

pub type Cells = BTreeMap<String, Fr>;

/// Parse a signed decimal integer (as it appears in the JSON) into Fr.
pub fn fr(s: &str) -> Fr {
    let (neg, digits) = match s.strip_prefix('-') {
        Some(d) => (true, d),
        None => (false, s),
    };
    let mag = Fr::from(digits.parse::<u64>().expect("integer literal"));
    if neg {
        -mag
    } else {
        mag
    }
}

/// Build a Cells map from a list of ("rowId.col", "intLiteral") pairs.
pub fn build(pairs: &[(&str, &str)]) -> Cells {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), fr(v)))
        .collect()
}
