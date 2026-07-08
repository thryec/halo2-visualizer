// vanilla-plonk: advice a,b,c; fixed qa,qb,qm,qc,k; selector q; single gate
// q*(qa*a + qb*b + qm*a*b + qc*c + k). 4 rows, no copies, no instance.
use crate::common::{build, Cells};
use halo2_proofs::{
    circuit::{Layouter, Region, SimpleFloorPlanner, Value},
    dev::MockProver,
    halo2curves::bn256::Fr,
    plonk::{Advice, Circuit, Column, ConstraintSystem, ErrorFront, Fixed, Selector},
    poly::Rotation,
};

#[derive(Clone)]
pub struct Cfg {
    a: Column<Advice>,
    b: Column<Advice>,
    c: Column<Advice>,
    qa: Column<Fixed>,
    qb: Column<Fixed>,
    qm: Column<Fixed>,
    qc: Column<Fixed>,
    k: Column<Fixed>,
    q: Selector,
}

struct Circ {
    cells: Cells,
}

fn adv(
    region: &mut Region<Fr>,
    cells: &Cells,
    off: usize,
    key: &str,
    col: Column<Advice>,
) -> Result<(), ErrorFront> {
    let v = *cells.get(key).unwrap();
    region.assign_advice(|| key.to_string(), col, off, || Value::known(v))?;
    Ok(())
}

fn fix(
    region: &mut Region<Fr>,
    cells: &Cells,
    off: usize,
    key: &str,
    col: Column<Fixed>,
) -> Result<(), ErrorFront> {
    let v = *cells.get(key).unwrap();
    region.assign_fixed(|| key.to_string(), col, off, || Value::known(v))?;
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
        let qa = meta.fixed_column();
        let qb = meta.fixed_column();
        let qm = meta.fixed_column();
        let qc = meta.fixed_column();
        let k = meta.fixed_column();
        let q = meta.selector();

        meta.create_gate("plonk gate", |m| {
            let a = m.query_advice(a, Rotation::cur());
            let b = m.query_advice(b, Rotation::cur());
            let c = m.query_advice(c, Rotation::cur());
            let qa = m.query_fixed(qa, Rotation::cur());
            let qb = m.query_fixed(qb, Rotation::cur());
            let qm = m.query_fixed(qm, Rotation::cur());
            let qc = m.query_fixed(qc, Rotation::cur());
            let k = m.query_fixed(k, Rotation::cur());
            let s = m.query_selector(q);
            vec![s * (qa * a.clone() + qb * b.clone() + qm * a * b + qc * c + k)]
        });

        Cfg {
            a,
            b,
            c,
            qa,
            qb,
            qm,
            qc,
            k,
            q,
        }
    }

    fn synthesize(&self, cfg: Cfg, mut layouter: impl Layouter<Fr>) -> Result<(), ErrorFront> {
        let cells = &self.cells;
        layouter.assign_region(
            || "region",
            |mut region| {
                for (off, id) in ["r0", "r1", "r2", "r3"].iter().enumerate() {
                    adv(&mut region, cells, off, &format!("{}.a", id), cfg.a)?;
                    adv(&mut region, cells, off, &format!("{}.b", id), cfg.b)?;
                    adv(&mut region, cells, off, &format!("{}.c", id), cfg.c)?;
                    fix(&mut region, cells, off, &format!("{}.qa", id), cfg.qa)?;
                    fix(&mut region, cells, off, &format!("{}.qb", id), cfg.qb)?;
                    fix(&mut region, cells, off, &format!("{}.qm", id), cfg.qm)?;
                    fix(&mut region, cells, off, &format!("{}.qc", id), cfg.qc)?;
                    fix(&mut region, cells, off, &format!("{}.k", id), cfg.k)?;
                    cfg.q.enable(&mut region, off)?;
                }
                Ok(())
            },
        )
    }
}

pub fn honest() -> Cells {
    build(&[
        ("r0.a", "2"), ("r0.b", "3"), ("r0.c", "5"),
        ("r0.qa", "1"), ("r0.qb", "1"), ("r0.qm", "0"), ("r0.qc", "-1"), ("r0.k", "0"),
        ("r1.a", "2"), ("r1.b", "3"), ("r1.c", "6"),
        ("r1.qa", "0"), ("r1.qb", "0"), ("r1.qm", "1"), ("r1.qc", "-1"), ("r1.k", "0"),
        ("r2.a", "7"), ("r2.b", "3"), ("r2.c", "4"),
        ("r2.qa", "1"), ("r2.qb", "-1"), ("r2.qm", "0"), ("r2.qc", "-1"), ("r2.k", "0"),
        ("r3.a", "5"), ("r3.b", "0"), ("r3.c", "15"),
        ("r3.qa", "1"), ("r3.qb", "0"), ("r3.qm", "0"), ("r3.qc", "-1"), ("r3.k", "10"),
    ])
}

pub fn run(cells: &Cells) -> bool {
    let circ = Circ {
        cells: cells.clone(),
    };
    MockProver::run(4, &circ, vec![]).unwrap().verify().is_ok()
}
