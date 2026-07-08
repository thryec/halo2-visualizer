// iszero-multichip: advice a,b,c; selectors q_mul,q_iz; instance column.
// q_mul gate a*b-c; q_iz gate [a*c, 1-c-a*b]. 3 copies; 1 instance constraint.
// JSON declares modulus 17 for teaching; identities hold exactly over Fr here.
use crate::common::{build, Cells};
use ff::Field;
use halo2_proofs::{
    circuit::{AssignedCell, Layouter, Region, SimpleFloorPlanner, Value},
    dev::MockProver,
    halo2curves::bn256::Fr,
    plonk::{Advice, Circuit, Column, ConstraintSystem, ErrorFront, Expression, Instance, Selector},
    poly::Rotation,
};
use std::collections::BTreeMap;

#[derive(Clone)]
pub struct Cfg {
    a: Column<Advice>,
    b: Column<Advice>,
    c: Column<Advice>,
    inst: Column<Instance>,
    q_mul: Selector,
    q_iz: Selector,
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
        let q_mul = meta.selector();
        let q_iz = meta.selector();

        meta.create_gate("mul gate", |m| {
            let a = m.query_advice(a, Rotation::cur());
            let b = m.query_advice(b, Rotation::cur());
            let c = m.query_advice(c, Rotation::cur());
            let s = m.query_selector(q_mul);
            vec![s * (a * b - c)]
        });
        meta.create_gate("is zero gate", |m| {
            let a = m.query_advice(a, Rotation::cur());
            let b = m.query_advice(b, Rotation::cur());
            let c = m.query_advice(c, Rotation::cur());
            let s = m.query_selector(q_iz);
            let one = Expression::Constant(Fr::ONE);
            vec![
                s.clone() * (a.clone() * c.clone()),
                s * (one - c - a * b),
            ]
        });

        Cfg {
            a,
            b,
            c,
            inst,
            q_mul,
            q_iz,
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
                put(&mut region, cells, &mut m, 2, "r2.a", cfg.a)?;
                put(&mut region, cells, &mut m, 2, "r2.b", cfg.b)?;
                put(&mut region, cells, &mut m, 2, "r2.c", cfg.c)?;
                put(&mut region, cells, &mut m, 3, "r3.a", cfg.a)?;
                put(&mut region, cells, &mut m, 3, "r3.b", cfg.b)?;
                put(&mut region, cells, &mut m, 3, "r3.c", cfg.c)?;

                cfg.q_mul.enable(&mut region, 2)?;
                cfg.q_iz.enable(&mut region, 3)?;

                for (x, y) in [("r0.a", "r2.a"), ("r1.a", "r2.b"), ("r2.c", "r3.a")] {
                    region.constrain_equal(m[x].cell(), m[y].cell())?;
                }
                Ok(m)
            },
        )?;

        layouter.constrain_instance(map["r3.c"].cell(), cfg.inst, 0)?;
        Ok(())
    }
}

pub fn honest() -> Cells {
    build(&[
        ("r0.a", "3"),
        ("r1.a", "0"),
        ("r2.a", "3"),
        ("r2.b", "0"),
        ("r2.c", "0"),
        ("r3.a", "0"),
        ("r3.b", "0"),
        ("r3.c", "1"),
        ("i0.instance", "1"),
    ])
}

pub fn run(cells: &Cells) -> bool {
    let instance = vec![vec![*cells.get("i0.instance").unwrap()]];
    let circ = Circ {
        cells: cells.clone(),
    };
    MockProver::run(4, &circ, instance).unwrap().verify().is_ok()
}
