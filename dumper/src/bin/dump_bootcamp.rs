//! Dump three bootcamp circuits to dumper/out/*.json.
//! Circuits are replicated inline (no dependency on the bootcamp crates).

use dumper::dump;
use ff::PrimeField;
use halo2_proofs::circuit::{AssignedCell, Layouter, SimpleFloorPlanner, Value};
use halo2_proofs::dev::MockProver;
use halo2_proofs::halo2curves::bn256::Fr;
use halo2_proofs::plonk::{
    Advice, Circuit, Column, ConstraintSystem, ErrorFront, Expression, Fixed, Instance, Selector,
};
use halo2_proofs::poly::Rotation;
use std::marker::PhantomData;

// ===================== week3 lib_1: Fibonacci (one advice column) =====================
mod fib {
    use super::*;

    pub struct FibCircuit<F: PrimeField> {
        pub a: [Value<F>; 5],
    }

    #[derive(Clone)]
    pub struct FibConfig {
        a: Column<Advice>,
        b: Column<Fixed>,
        q: Selector,
    }

    impl<F: PrimeField> Circuit<F> for FibCircuit<F> {
        type Config = FibConfig;
        type FloorPlanner = SimpleFloorPlanner;

        fn without_witnesses(&self) -> Self {
            Self { a: [Value::unknown(); 5] }
        }

        fn configure(meta: &mut ConstraintSystem<F>) -> Self::Config {
            let a = meta.advice_column();
            let b = meta.fixed_column();
            let q = meta.selector();

            meta.enable_equality(a);
            meta.enable_constant(b);

            meta.create_gate("add gate", |meta| {
                let a_curr = meta.query_advice(a, Rotation::cur());
                let a_next = meta.query_advice(a, Rotation::next());
                let a_next_next = meta.query_advice(a, Rotation(2));
                let q = meta.query_selector(q);
                vec![q * (a_curr + a_next - a_next_next)]
            });

            FibConfig { a, b, q }
        }

        fn synthesize(
            &self,
            config: Self::Config,
            mut layouter: impl Layouter<F>,
        ) -> Result<(), ErrorFront> {
            layouter.assign_region(
                || "add region",
                |mut region| {
                    for i in 0..3 {
                        config.q.enable(&mut region, i)?;
                    }
                    let a0 = region.assign_advice(|| "assign a[0]", config.a, 0, || self.a[0])?;
                    let a1 = region.assign_advice(|| "assign a[1]", config.a, 1, || self.a[1])?;
                    for i in 0..5 {
                        region.assign_advice(|| "assign a", config.a, i, || self.a[i])?;
                    }
                    region.constrain_constant(a0.cell(), F::ONE)?;
                    region.constrain_constant(a1.cell(), F::ONE)?;
                    Ok(())
                },
            )?;
            Ok(())
        }
    }
}

// ===================== week5 lib_2: IsZero chip =====================
mod iszero {
    use super::*;

    pub struct IsZeroCircuit<F: PrimeField> {
        pub x: Value<F>,
    }

    #[derive(Clone)]
    pub struct IsZeroConfig {
        x: Column<Advice>,
        x_inv: Column<Advice>,
        out: Column<Advice>,
        q: Selector,
    }

    struct IsZeroChip<F> {
        config: IsZeroConfig,
        _ph: PhantomData<F>,
    }

    impl<F: PrimeField> IsZeroChip<F> {
        fn construct(config: IsZeroConfig) -> Self {
            IsZeroChip { config, _ph: PhantomData }
        }

        fn configure(meta: &mut ConstraintSystem<F>) -> IsZeroConfig {
            let x = meta.advice_column();
            let x_inv = meta.advice_column();
            let out = meta.advice_column();
            let q = meta.selector();

            meta.enable_equality(x);
            meta.enable_equality(out);

            meta.create_gate("is zero gate", |meta| {
                let x = meta.query_advice(x, Rotation::cur());
                let x_inv = meta.query_advice(x_inv, Rotation::cur());
                let out = meta.query_advice(out, Rotation::cur());
                let q = meta.query_selector(q);
                let one = Expression::Constant(F::ONE);
                vec![
                    q.clone() * x.clone() * out.clone(),
                    q * (one - out - x * x_inv),
                ]
            });

            IsZeroConfig { x, x_inv, out, q }
        }

        fn unconstrained(
            &self,
            layouter: &mut impl Layouter<F>,
            x: Value<F>,
        ) -> Result<AssignedCell<F, F>, ErrorFront> {
            let config = &self.config;
            layouter.assign_region(
                || "unconstrained",
                |mut region| region.assign_advice(|| "unconstrained", config.x, 0, || x),
            )
        }

        fn is_zero(
            &self,
            layouter: &mut impl Layouter<F>,
            x: AssignedCell<F, F>,
        ) -> Result<AssignedCell<F, F>, ErrorFront> {
            let config = &self.config;
            layouter.assign_region(
                || "is zero region",
                |mut region| {
                    config.q.enable(&mut region, 0)?;
                    let x_val = x.value().copied();
                    let x_inv_val = x_val.map(|x| x.invert().unwrap_or(F::ZERO));
                    let out_val = x_val.map(|x| if x == F::ZERO { F::ONE } else { F::ZERO });

                    let new_x = region.assign_advice(|| "x", config.x, 0, || x_val)?;
                    region.constrain_equal(new_x.cell(), x.cell())?;
                    region.assign_advice(|| "x_inv", config.x_inv, 0, || x_inv_val)?;
                    let out = region.assign_advice(|| "out", config.out, 0, || out_val)?;
                    Ok(out)
                },
            )
        }
    }

    #[derive(Clone)]
    pub struct CircuitConfig {
        is_zero_config: IsZeroConfig,
        instance: Column<Instance>,
    }

    impl<F: PrimeField> Circuit<F> for IsZeroCircuit<F> {
        type Config = CircuitConfig;
        type FloorPlanner = SimpleFloorPlanner;

        fn without_witnesses(&self) -> Self {
            IsZeroCircuit { x: Value::unknown() }
        }

        fn configure(meta: &mut ConstraintSystem<F>) -> Self::Config {
            let instance = meta.instance_column();
            meta.enable_equality(instance);
            let is_zero_config = IsZeroChip::<F>::configure(meta);
            CircuitConfig { is_zero_config, instance }
        }

        fn synthesize(
            &self,
            config: Self::Config,
            mut layouter: impl Layouter<F>,
        ) -> Result<(), ErrorFront> {
            let chip = IsZeroChip::construct(config.is_zero_config);
            let x_cell = chip.unconstrained(&mut layouter, self.x)?;
            let out_cell = chip.is_zero(&mut layouter, x_cell)?;
            layouter.constrain_instance(out_cell.cell(), config.instance, 0)?;
            Ok(())
        }
    }
}

// ===================== week5 lib_3: a^5 + a = b (AddMulChip) =====================
mod addmul {
    use super::*;

    pub struct AddMulCircuit<F: PrimeField> {
        pub a: Value<F>,
    }

    #[derive(Clone)]
    pub struct AddMulConfig {
        a: Column<Advice>,
        b: Column<Advice>,
        c: Column<Advice>,
        q_add: Selector,
        q_mul: Selector,
    }

    struct AddMulChip<F> {
        config: AddMulConfig,
        _ph: PhantomData<F>,
    }

    impl<F: PrimeField> AddMulChip<F> {
        fn construct(config: AddMulConfig) -> Self {
            AddMulChip { config, _ph: PhantomData }
        }

        fn configure(
            meta: &mut ConstraintSystem<F>,
            a: Column<Advice>,
            b: Column<Advice>,
            c: Column<Advice>,
        ) -> AddMulConfig {
            let q_add = meta.selector();
            let q_mul = meta.selector();

            meta.create_gate("add gate", |meta| {
                let a = meta.query_advice(a, Rotation::cur());
                let b = meta.query_advice(b, Rotation::cur());
                let c = meta.query_advice(c, Rotation::cur());
                let q_add = meta.query_selector(q_add);
                vec![q_add * (a + b - c)]
            });

            meta.create_gate("mul gate", |meta| {
                let a = meta.query_advice(a, Rotation::cur());
                let b = meta.query_advice(b, Rotation::cur());
                let c = meta.query_advice(c, Rotation::cur());
                let q_mul = meta.query_selector(q_mul);
                vec![q_mul * (a * b - c)]
            });

            AddMulConfig { a, b, c, q_add, q_mul }
        }

        fn unconstrained(
            &self,
            layouter: &mut impl Layouter<F>,
            a: Value<F>,
        ) -> Result<AssignedCell<F, F>, ErrorFront> {
            let config = &self.config;
            layouter.assign_region(
                || "unconstrained",
                |mut region| region.assign_advice(|| "unconstrained", config.a, 0, || a),
            )
        }

        fn add(
            &self,
            layouter: &mut impl Layouter<F>,
            a: AssignedCell<F, F>,
            b: AssignedCell<F, F>,
        ) -> Result<AssignedCell<F, F>, ErrorFront> {
            let config = &self.config;
            layouter.assign_region(
                || "add region",
                |mut region| {
                    config.q_add.enable(&mut region, 0)?;
                    let a_val = a.value().copied();
                    let b_val = b.value().copied();
                    let new_a = region.assign_advice(|| "a", config.a, 0, || a_val)?;
                    let new_b = region.assign_advice(|| "b", config.b, 0, || b_val)?;
                    region.constrain_equal(new_a.cell(), a.cell())?;
                    region.constrain_equal(new_b.cell(), b.cell())?;
                    let out_val = a_val + b_val;
                    region.assign_advice(|| "c", config.c, 0, || out_val)
                },
            )
        }

        fn mul(
            &self,
            layouter: &mut impl Layouter<F>,
            a: AssignedCell<F, F>,
            b: AssignedCell<F, F>,
        ) -> Result<AssignedCell<F, F>, ErrorFront> {
            let config = &self.config;
            layouter.assign_region(
                || "mul region",
                |mut region| {
                    config.q_mul.enable(&mut region, 0)?;
                    let a_val = a.value().copied();
                    let b_val = b.value().copied();
                    let new_a = region.assign_advice(|| "a", config.a, 0, || a_val)?;
                    let new_b = region.assign_advice(|| "b", config.b, 0, || b_val)?;
                    region.constrain_equal(new_a.cell(), a.cell())?;
                    region.constrain_equal(new_b.cell(), b.cell())?;
                    let out_val = a_val * b_val;
                    region.assign_advice(|| "c", config.c, 0, || out_val)
                },
            )
        }
    }

    #[derive(Clone)]
    pub struct CircuitConfig {
        instance: Column<Instance>,
        config: AddMulConfig,
    }

    impl<F: PrimeField> Circuit<F> for AddMulCircuit<F> {
        type Config = CircuitConfig;
        type FloorPlanner = SimpleFloorPlanner;

        fn without_witnesses(&self) -> Self {
            AddMulCircuit { a: Value::unknown() }
        }

        fn configure(meta: &mut ConstraintSystem<F>) -> Self::Config {
            let a = meta.advice_column();
            let b = meta.advice_column();
            let c = meta.advice_column();
            let instance = meta.instance_column();

            meta.enable_equality(a);
            meta.enable_equality(b);
            meta.enable_equality(c);
            meta.enable_equality(instance);

            let config = AddMulChip::<F>::configure(meta, a, b, c);
            CircuitConfig { instance, config }
        }

        fn synthesize(
            &self,
            config: Self::Config,
            mut layouter: impl Layouter<F>,
        ) -> Result<(), ErrorFront> {
            let chip: AddMulChip<F> = AddMulChip::construct(config.config);
            let a = chip.unconstrained(&mut layouter, self.a)?;
            let a2 = chip.mul(&mut layouter, a.clone(), a.clone())?;
            let a4 = chip.mul(&mut layouter, a2.clone(), a2.clone())?;
            let a5 = chip.mul(&mut layouter, a4.clone(), a.clone())?;
            let out = chip.add(&mut layouter, a5.clone(), a.clone())?;
            layouter.constrain_instance(out.cell(), config.instance, 0)?;
            Ok(())
        }
    }
}

fn write_dump(name: &str, json: String) {
    let json = retitle(name, json);
    let dir = std::path::Path::new("out");
    std::fs::create_dir_all(dir).expect("create out/");
    let path = dir.join(format!("{name}.json"));
    std::fs::write(&path, json).expect("write json");
    println!("wrote {}", path.display());
}

fn retitle(name: &str, json: String) -> String {
    let (title, subtitle) = match name {
        "fibonacci" => ("fibonacci (week3, dumped)", "dumped from the real halo2 circuit via MockProver"),
        "iszero" => ("isZero (week5 lib_2, dumped)", "dumped from the real halo2 circuit via MockProver"),
        "addmul" => ("a^5 + a = b (week5 lib_3, dumped)", "dumped from the real halo2 circuit via MockProver"),
        _ => return json,
    };
    let mut v: serde_json::Value = serde_json::from_str(&json).expect("valid dump json");
    v["title"] = serde_json::Value::String(title.to_string());
    v["subtitle"] = serde_json::Value::String(subtitle.to_string());
    serde_json::to_string_pretty(&v).expect("serialize")
}

fn main() {
    // ---- fibonacci ----
    {
        let a = [1u64, 1, 2, 3, 5].map(|v| Value::known(Fr::from(v)));
        let circuit = fib::FibCircuit { a };
        let instances: Vec<Vec<Fr>> = vec![];
        MockProver::run(4, &circuit, instances.clone())
            .unwrap()
            .assert_satisfied();
        write_dump("fibonacci", dump(4, &circuit, instances));
    }

    // ---- iszero (x = 0 -> out = 1) ----
    {
        let circuit = iszero::IsZeroCircuit { x: Value::known(Fr::from(0)) };
        let instances = vec![vec![Fr::from(1)]];
        MockProver::run(4, &circuit, instances.clone())
            .unwrap()
            .assert_satisfied();
        write_dump("iszero", dump(4, &circuit, instances));
    }

    // ---- a^5 + a = b (a = 2 -> b = 34) ----
    {
        let a = Fr::from(2);
        let a2 = a * a;
        let a4 = a2 * a2;
        let a5 = a4 * a;
        let b = a5 + a;
        let circuit = addmul::AddMulCircuit { a: Value::known(a) };
        let instances = vec![vec![b]];
        MockProver::run(5, &circuit, instances.clone())
            .unwrap()
            .assert_satisfied();
        write_dump("addmul", dump(5, &circuit, instances));
    }

    println!("done");
}
