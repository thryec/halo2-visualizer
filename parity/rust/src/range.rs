// range-add: advice x,y,z; COMPLEX selector q (appears in lookup exprs); a 16-row
// lookup table 0..=15; three lookups (q*x),(q*y),(q*z) into the table; add gate
// q*(x+y-z). 2 rows.
use crate::common::{build, Cells};
use halo2_proofs::{
    circuit::{Layouter, Region, SimpleFloorPlanner, Value},
    dev::MockProver,
    halo2curves::bn256::Fr,
    plonk::{Advice, Circuit, Column, ConstraintSystem, ErrorFront, Selector, TableColumn},
    poly::Rotation,
};

#[derive(Clone)]
pub struct Cfg {
    x: Column<Advice>,
    y: Column<Advice>,
    z: Column<Advice>,
    q: Selector,
    table: TableColumn,
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

impl Circuit<Fr> for Circ {
    type Config = Cfg;
    type FloorPlanner = SimpleFloorPlanner;

    fn without_witnesses(&self) -> Self {
        Circ {
            cells: self.cells.clone(),
        }
    }

    fn configure(meta: &mut ConstraintSystem<Fr>) -> Cfg {
        let x = meta.advice_column();
        let y = meta.advice_column();
        let z = meta.advice_column();
        let q = meta.complex_selector();
        let table = meta.lookup_table_column();

        meta.create_gate("add gate", |m| {
            let x = m.query_advice(x, Rotation::cur());
            let y = m.query_advice(y, Rotation::cur());
            let z = m.query_advice(z, Rotation::cur());
            let s = m.query_selector(q);
            vec![s * (x + y - z)]
        });

        for (name, col) in [("range check x", x), ("range check y", y), ("range check z", z)] {
            meta.lookup(name, |m| {
                let s = m.query_selector(q);
                let v = m.query_advice(col, Rotation::cur());
                vec![(s * v, table)]
            });
        }

        Cfg { x, y, z, q, table }
    }

    fn synthesize(&self, cfg: Cfg, mut layouter: impl Layouter<Fr>) -> Result<(), ErrorFront> {
        let cells = &self.cells;

        layouter.assign_table(
            || "range16",
            |mut table| {
                for i in 0..=15u64 {
                    table.assign_cell(
                        || format!("range[{}]", i),
                        cfg.table,
                        i as usize,
                        || Value::known(Fr::from(i)),
                    )?;
                }
                Ok(())
            },
        )?;

        layouter.assign_region(
            || "region",
            |mut region| {
                for (off, id) in ["r0", "r1"].iter().enumerate() {
                    adv(&mut region, cells, off, &format!("{}.x", id), cfg.x)?;
                    adv(&mut region, cells, off, &format!("{}.y", id), cfg.y)?;
                    adv(&mut region, cells, off, &format!("{}.z", id), cfg.z)?;
                    cfg.q.enable(&mut region, off)?;
                }
                Ok(())
            },
        )
    }
}

pub fn honest() -> Cells {
    build(&[
        ("r0.x", "1"), ("r0.y", "1"), ("r0.z", "2"),
        ("r1.x", "1"), ("r1.y", "2"), ("r1.z", "3"),
    ])
}

pub fn run(cells: &Cells) -> bool {
    let circ = Circ {
        cells: cells.clone(),
    };
    MockProver::run(5, &circ, vec![]).unwrap().verify().is_ok()
}
