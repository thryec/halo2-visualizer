// fibonacci: single advice column `fib`; selector q_fib; gate
// fib + fib@next - fib@2 on rows 0..3. Instance column [1,1,8] pinned to r0,r1,r5.
use crate::common::{build, Cells};
use halo2_proofs::{
    circuit::{AssignedCell, Layouter, Region, SimpleFloorPlanner, Value},
    dev::MockProver,
    halo2curves::bn256::Fr,
    plonk::{Advice, Circuit, Column, ConstraintSystem, ErrorFront, Instance, Selector},
    poly::Rotation,
};
use std::collections::BTreeMap;

#[derive(Clone)]
pub struct Cfg {
    fib: Column<Advice>,
    inst: Column<Instance>,
    q_fib: Selector,
}

struct Circ {
    cells: Cells,
}

impl Circuit<Fr> for Circ {
    type Config = Cfg;
    type FloorPlanner = SimpleFloorPlanner;

    fn without_witnesses(&self) -> Self {
        Circ {
            cells: self.cells.clone(),
        }
    }

    fn configure(meta: &mut ConstraintSystem<Fr>) -> Cfg {
        let fib = meta.advice_column();
        let inst = meta.instance_column();
        meta.enable_equality(fib);
        meta.enable_equality(inst);
        let q_fib = meta.selector();

        meta.create_gate("fib gate", |m| {
            let cur = m.query_advice(fib, Rotation::cur());
            let next = m.query_advice(fib, Rotation::next());
            let two = m.query_advice(fib, Rotation(2));
            let s = m.query_selector(q_fib);
            vec![s * (cur + next - two)]
        });

        Cfg { fib, inst, q_fib }
    }

    fn synthesize(&self, cfg: Cfg, mut layouter: impl Layouter<Fr>) -> Result<(), ErrorFront> {
        let cells = &self.cells;
        let map = layouter.assign_region(
            || "fib region",
            |mut region: Region<Fr>| {
                let mut m: BTreeMap<String, AssignedCell<Fr, Fr>> = BTreeMap::new();
                for (off, id) in ["r0", "r1", "r2", "r3", "r4", "r5"].iter().enumerate() {
                    let key = format!("{}.fib", id);
                    let v = *cells.get(&key).unwrap();
                    let ac = region.assign_advice(|| key.clone(), cfg.fib, off, || Value::known(v))?;
                    m.insert(key, ac);
                }
                // q_fib on rows 0..3
                for off in 0..4 {
                    cfg.q_fib.enable(&mut region, off)?;
                }
                Ok(m)
            },
        )?;

        // instance [1,1,8]: r0.fib->0, r1.fib->1, r5.fib->2
        layouter.constrain_instance(map["r0.fib"].cell(), cfg.inst, 0)?;
        layouter.constrain_instance(map["r1.fib"].cell(), cfg.inst, 1)?;
        layouter.constrain_instance(map["r5.fib"].cell(), cfg.inst, 2)?;
        Ok(())
    }
}

pub fn honest() -> Cells {
    // instance cells stored under their row ids too, for uniform mutation.
    build(&[
        ("r0.fib", "1"),
        ("r1.fib", "1"),
        ("r2.fib", "2"),
        ("r3.fib", "3"),
        ("r4.fib", "5"),
        ("r5.fib", "8"),
        ("r0.instance", "1"),
        ("r1.instance", "1"),
        ("r2.instance", "8"),
    ])
}

pub fn run(cells: &Cells) -> bool {
    let instance = vec![vec![
        *cells.get("r0.instance").unwrap(),
        *cells.get("r1.instance").unwrap(),
        *cells.get("r2.instance").unwrap(),
    ]];
    let circ = Circ {
        cells: cells.clone(),
    };
    MockProver::run(5, &circ, instance).unwrap().verify().is_ok()
}
