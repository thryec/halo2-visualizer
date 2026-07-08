// week5-p3: a^5 + a = b via AddMulChip. advice a,b,c; selectors q_add,q_mul;
// one instance column; 8 copy constraints; 1 instance constraint.
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
    a: Column<Advice>,
    b: Column<Advice>,
    c: Column<Advice>,
    inst: Column<Instance>,
    q_add: Selector,
    q_mul: Selector,
}

struct Circ {
    cells: Cells,
}

fn put(
    region: &mut Region<Fr>,
    cells: &Cells,
    m: &mut BTreeMap<String, AssignedCell<Fr, Fr>>,
    off: usize,
    key: &str,
    col: Column<Advice>,
) -> Result<(), ErrorFront> {
    let v = *cells.get(key).unwrap();
    let ac = region.assign_advice(|| key.to_string(), col, off, || Value::known(v))?;
    m.insert(key.to_string(), ac);
    Ok(())
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
        let a = meta.advice_column();
        let b = meta.advice_column();
        let c = meta.advice_column();
        let inst = meta.instance_column();
        meta.enable_equality(a);
        meta.enable_equality(b);
        meta.enable_equality(c);
        meta.enable_equality(inst);
        let q_add = meta.selector();
        let q_mul = meta.selector();

        meta.create_gate("add gate", |m| {
            let a = m.query_advice(a, Rotation::cur());
            let b = m.query_advice(b, Rotation::cur());
            let c = m.query_advice(c, Rotation::cur());
            let s = m.query_selector(q_add);
            vec![s * (a + b - c)]
        });
        meta.create_gate("mul gate", |m| {
            let a = m.query_advice(a, Rotation::cur());
            let b = m.query_advice(b, Rotation::cur());
            let c = m.query_advice(c, Rotation::cur());
            let s = m.query_selector(q_mul);
            vec![s * (a * b - c)]
        });

        Cfg {
            a,
            b,
            c,
            inst,
            q_add,
            q_mul,
        }
    }

    fn synthesize(&self, cfg: Cfg, mut layouter: impl Layouter<Fr>) -> Result<(), ErrorFront> {
        let cells = &self.cells;
        let map = layouter.assign_region(
            || "main",
            |mut region| {
                let mut m: BTreeMap<String, AssignedCell<Fr, Fr>> = BTreeMap::new();
                put(&mut region, cells, &mut m, 0, "r0.a", cfg.a)?;
                put(&mut region, cells, &mut m, 1, "r1.a", cfg.a)?;
                put(&mut region, cells, &mut m, 1, "r1.b", cfg.b)?;
                put(&mut region, cells, &mut m, 1, "r1.c", cfg.c)?;
                put(&mut region, cells, &mut m, 2, "r2.a", cfg.a)?;
                put(&mut region, cells, &mut m, 2, "r2.b", cfg.b)?;
                put(&mut region, cells, &mut m, 2, "r2.c", cfg.c)?;
                put(&mut region, cells, &mut m, 3, "r3.a", cfg.a)?;
                put(&mut region, cells, &mut m, 3, "r3.b", cfg.b)?;
                put(&mut region, cells, &mut m, 3, "r3.c", cfg.c)?;
                put(&mut region, cells, &mut m, 4, "r4.a", cfg.a)?;
                put(&mut region, cells, &mut m, 4, "r4.b", cfg.b)?;
                put(&mut region, cells, &mut m, 4, "r4.c", cfg.c)?;

                cfg.q_mul.enable(&mut region, 1)?;
                cfg.q_mul.enable(&mut region, 2)?;
                cfg.q_mul.enable(&mut region, 3)?;
                cfg.q_add.enable(&mut region, 4)?;

                for (x, y) in [
                    ("r0.a", "r1.a"),
                    ("r0.a", "r1.b"),
                    ("r1.c", "r2.a"),
                    ("r1.c", "r2.b"),
                    ("r2.c", "r3.a"),
                    ("r0.a", "r3.b"),
                    ("r3.c", "r4.a"),
                    ("r0.a", "r4.b"),
                ] {
                    region.constrain_equal(m[x].cell(), m[y].cell())?;
                }
                Ok(m)
            },
        )?;

        layouter.constrain_instance(map["r4.c"].cell(), cfg.inst, 0)?;
        Ok(())
    }
}

pub fn honest() -> Cells {
    build(&[
        ("r0.a", "2"),
        ("r1.a", "2"),
        ("r1.b", "2"),
        ("r1.c", "4"),
        ("r2.a", "4"),
        ("r2.b", "4"),
        ("r2.c", "16"),
        ("r3.a", "16"),
        ("r3.b", "2"),
        ("r3.c", "32"),
        ("r4.a", "32"),
        ("r4.b", "2"),
        ("r4.c", "34"),
        ("i0.instance", "34"),
    ])
}

pub fn run(cells: &Cells) -> bool {
    let instance = vec![vec![*cells.get("i0.instance").unwrap()]];
    let circ = Circ {
        cells: cells.clone(),
    };
    MockProver::run(4, &circ, instance).unwrap().verify().is_ok()
}
