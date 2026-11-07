// Usage: fairness [--seeds N] [--days N] [--first N] [--threads N] [--quick] [--no-day]
//                 [--only TEXT] [--check]
//
// The fairness harness: runs many seeds of each colony type and reports how
// often each option wins and its mean trail share. Seeds are derived the way
// the contract derives them (`colony_seed` from a round or day seed made by
// `seed_from_int`), so the numbers describe the maps the chain will run.
//
// Three kinds of scenario:
// - fair: every option should win its fair share. Gated by a chi-square test
//   on the win counts (p > 0.001), a z-test on each option's mean trail share
//   (|z| < 4) and, for five options, no option above 30% of wins.
// - uneven: uneven by design (the Burn colony's handicap); reported, not gated.
// - steer: one option gets stakes or richer odds. Gated by a one-sided
//   two-proportion z-test (z > 4) against the same seeds in a baseline scenario.
//
// --seeds sets the count for the 800- and 300-tick colonies (default 1,000),
// --days for the Burn colony's 43,200-tick daily run (default 1,000; about
// 0.1 s per day per thread). --quick is --seeds 200 --days 100 (a smoke test,
// below the 1,000 seeds the fairness rule asks for). --only runs the scenarios
// whose name contains TEXT (a steer scenario needs its baseline in the same run).
// --check exits 1 if a gate fails.
use antosim::{
    burn_richness, colony_seed, forecast_run, market_colony, run, seed_from_int, stake_richness,
    trail_shares, Colony, Commit, Kind, SimResult, BURN_COLONY, BURN_TICKS, FORECAST_ANTS,
    FORECAST_TICKS, KINDS, N_ANTS, TICKS,
};
use std::time::Instant;

/// One $ANTO staked by one wallet is sqrt(1) = 1,000 milli sqrt-tokens; 100 is 10,000.
const STAKE_100: u32 = 10_000;
/// Chi-square critical values at p = 0.001 for 1 to 4 degrees of freedom.
const CHI2_CRIT: [f64; 4] = [10.828, 13.816, 16.266, 18.467];
const SHARE_Z_MAX: f64 = 4.0;
const STEER_Z_MIN: f64 = 4.0;
const FIVE_OPTION_CAP: f64 = 0.30;

#[derive(Clone, Copy, PartialEq)]
enum Gate {
    Fair,
    Uneven,
    /// Option `.0` should win more often than in the scenario named `.1`.
    Steer(usize, &'static str),
}

type Sim = Box<dyn Fn(u64) -> SimResult + Sync>;

struct Scenario {
    name: String,
    n: usize,
    gate: Gate,
    day: bool,
    sim: Sim,
}

struct Stats {
    seeds: usize,
    wins: Vec<usize>,
    source_wins: Vec<usize>,
    /// Runs where the winner tied with another source (lowest index wins).
    ties: usize,
    /// Per option: mean and variance of the trail share, in basis points.
    share_mean: Vec<f64>,
    share_var: Vec<f64>,
}

fn even_odds(n: usize) -> Vec<u16> {
    let mut o = vec![(10_000 / n) as u16; n];
    o[0] += (10_000 - o.iter().map(|&x| x as u32).sum::<u32>()) as u16;
    o
}

/// One forecaster of market 0 in round `i`, as `forecast_market` runs it.
fn forecaster(i: u64, kind: Kind, odds: &[u16], weights: &[u32], agent_odds: &[u16]) -> SimResult {
    let seed = colony_seed(&seed_from_int(i), market_colony(0), kind as u8);
    let z = [0u8; 32];
    forecast_run(
        &seed, kind, odds, odds, weights, z, agent_odds, z, FORECAST_ANTS, FORECAST_TICKS,
    )
    .unwrap()
}

/// The Burn colony's daily run for day `i`, with `rich` as its food.
fn burn_day(i: u64, rich: &[u16]) -> SimResult {
    let seed = colony_seed(&seed_from_int(i), BURN_COLONY, 0);
    let mut c = Colony::with_commit(&seed, 5, Some(rich), Commit::default(), N_ANTS, BURN_TICKS)
        .unwrap();
    while c.step() {}
    c.result().unwrap()
}

fn scenarios() -> Vec<Scenario> {
    let mut v = Vec::new();
    let mut add = |name: String, n, gate, day, sim: Sim| {
        v.push(Scenario {
            name,
            n,
            gate,
            day,
            sim,
        })
    };

    // The base colony (150 ants, 800 ticks) with seed-drawn richness.
    for n in 2..=5 {
        add(
            format!("base seed-richness n={n}"),
            n,
            Gate::Fair,
            false,
            Box::new(move |i| run(&seed_from_int(i), n, None, N_ANTS, TICKS).unwrap()),
        );
    }

    // Forecast colonies with no information: even odds, no stakes, no agent
    // posts. Each kind runs on its own map, so each is its own fairness test.
    for kind in KINDS {
        for n in 2..=5 {
            add(
                format!("forecast {kind:?} even n={n}"),
                n,
                Gate::Fair,
                false,
                Box::new(move |i| forecaster(i, kind, &even_odds(n), &vec![0; n], &vec![0; n])),
            );
        }
    }

    // Forecasts steered: Momentum on a 70/30 market, Community with 100 $ANTO
    // on option 1 of three, Agents posting 20/50/30 on three. Baselines are the
    // even scenarios above, on the same seeds.
    add(
        "forecast Momentum odds 70/30".into(),
        2,
        Gate::Steer(0, "forecast Momentum even n=2"),
        false,
        Box::new(|i| forecaster(i, Kind::Momentum, &[7000, 3000], &[0, 0], &[0, 0])),
    );
    add(
        "forecast Community 100 on opt 1 of 3".into(),
        3,
        Gate::Steer(1, "forecast Community even n=3"),
        false,
        Box::new(|i| forecaster(i, Kind::Community, &even_odds(3), &[0, STAKE_100, 0], &[0; 3])),
    );
    add(
        "forecast Agents 20/50/30".into(),
        3,
        Gate::Steer(1, "forecast Agents even n=3"),
        false,
        Box::new(|i| forecaster(i, Kind::Agents, &even_odds(3), &[0; 3], &[2000, 5000, 3000])),
    );

    // The Burn colony's daily run (150 ants, 43,200 ticks).
    let flat = stake_richness(&[0; 5]).unwrap();
    add(
        "burn day no stakes, no handicap".into(),
        5,
        Gate::Fair,
        true,
        Box::new(move |i| burn_day(i, &flat)),
    );
    let handicap = burn_richness(&[0; 5]).unwrap();
    add(
        "burn day no stakes (handicap)".into(),
        5,
        Gate::Uneven,
        true,
        Box::new(move |i| burn_day(i, &handicap)),
    );
    // A lone staker's 100 $ANTO on each size, so win chance times that size's
    // reward part can be compared across the menu.
    for (opt, label) in ["0.10%", "0.25%", "0.50%", "1.00%", "2.00%"].into_iter().enumerate() {
        let mut w = [0u32; 5];
        w[opt] = STAKE_100;
        let rich = burn_richness(&w).unwrap();
        add(
            format!("burn day 100 on {label} (handicap)"),
            5,
            Gate::Steer(opt, "burn day no stakes (handicap)"),
            true,
            Box::new(move |i| burn_day(i, &rich)),
        );
    }
    let mut w = [0u32; 5];
    w[4] = STAKE_100;
    let rich = stake_richness(&w).unwrap();
    add(
        "burn day 100 on 2.00% (no handicap)".into(),
        5,
        Gate::Steer(4, "burn day no stakes, no handicap"),
        true,
        Box::new(move |i| burn_day(i, &rich)),
    );
    v
}

/// Run `sim` on seeds `first..first + count` across `threads` threads.
fn measure(sim: &(dyn Fn(u64) -> SimResult + Sync), n: usize, first: u64, count: usize, threads: usize) -> Stats {
    let chunk = count.div_ceil(threads.max(1)).max(1);
    let results: Vec<SimResult> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..count)
            .step_by(chunk)
            .map(|start| {
                let end = (start + chunk).min(count);
                s.spawn(move || (start..end).map(|k| sim(first + k as u64)).collect::<Vec<_>>())
            })
            .collect();
        handles.into_iter().flat_map(|h| h.join().unwrap()).collect()
    });

    let mut st = Stats {
        seeds: results.len(),
        wins: vec![0; n],
        source_wins: vec![0; n],
        ties: 0,
        share_mean: vec![0.0; n],
        share_var: vec![0.0; n],
    };
    let mut sums = vec![0f64; n];
    let mut sq = vec![0f64; n];
    for r in &results {
        st.wins[r.winner_option] += 1;
        st.source_wins[r.winner_source] += 1;
        let top = r.scores[r.winner_source];
        if r.scores.iter().filter(|&&x| x == top).count() > 1 {
            st.ties += 1;
        }
        for (o, &x) in trail_shares(r).iter().enumerate() {
            sums[o] += x as f64;
            sq[o] += (x as f64) * (x as f64);
        }
    }
    let m = st.seeds as f64;
    for o in 0..n {
        st.share_mean[o] = sums[o] / m;
        st.share_var[o] = if m > 1.0 {
            (sq[o] - sums[o] * sums[o] / m) / (m - 1.0)
        } else {
            0.0
        };
    }
    st
}

fn chi2(wins: &[usize]) -> f64 {
    let total: usize = wins.iter().sum();
    let e = total as f64 / wins.len() as f64;
    wins.iter().map(|&w| (w as f64 - e).powi(2) / e).sum()
}

/// Worst |z| of an option's mean trail share against the fair share.
fn share_z(st: &Stats) -> f64 {
    let fair = 10_000.0 / st.wins.len() as f64;
    (0..st.wins.len())
        .map(|o| {
            let se = (st.share_var[o] / st.seeds as f64).sqrt();
            if se == 0.0 {
                0.0
            } else {
                ((st.share_mean[o] - fair) / se).abs()
            }
        })
        .fold(0.0, f64::max)
}

/// One-sided z of option `o` winning more often in `a` than in `b`.
fn steer_z(a: &Stats, b: &Stats, o: usize) -> f64 {
    let (na, nb) = (a.seeds as f64, b.seeds as f64);
    let (pa, pb) = (a.wins[o] as f64 / na, b.wins[o] as f64 / nb);
    let p = (a.wins[o] + b.wins[o]) as f64 / (na + nb);
    let se = (p * (1.0 - p) * (1.0 / na + 1.0 / nb)).sqrt();
    if se == 0.0 {
        0.0
    } else {
        (pa - pb) / se
    }
}

fn pct(x: usize, of: usize) -> String {
    format!("{:5.1}", 100.0 * x as f64 / of as f64)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().any(|a| a == name);
    let value = |name: &str| -> Option<usize> {
        let at = args.iter().position(|a| a == name)?;
        Some(args.get(at + 1)?.parse().expect(name))
    };
    let quick = flag("--quick");
    let seeds = value("--seeds").unwrap_or(if quick { 200 } else { 1000 });
    let days = value("--days").unwrap_or(if quick { 100 } else { 1000 });
    let first = value("--first").unwrap_or(0) as u64;
    let threads = value("--threads")
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(4, |n| n.get()));
    let check = flag("--check");
    let no_day = flag("--no-day");
    let only = args
        .iter()
        .position(|a| a == "--only")
        .map(|at| args.get(at + 1).expect("--only").clone());

    println!(
        "ANTO-SIM-v1 fairness: {seeds} seeds per colony, {} Burn days, first seed {first}, {threads} threads",
        if no_day { 0 } else { days }
    );
    println!("per option, in %: wins and mean trail share; src = wins per food source (before the shuffle)\n");

    let mut done: Vec<(String, Stats)> = Vec::new();
    let mut failures = Vec::new();
    for sc in scenarios() {
        if (sc.day && no_day) || only.as_ref().is_some_and(|o| !sc.name.contains(o.as_str())) {
            continue;
        }
        let count = if sc.day { days } else { seeds };
        let t0 = Instant::now();
        let st = measure(&*sc.sim, sc.n, first, count, threads);
        let secs = t0.elapsed().as_secs_f64();

        let row = |v: Vec<String>| v.join(" ");
        let (verdict, ok) = match sc.gate {
            Gate::Fair => {
                let c = chi2(&st.wins);
                let z = share_z(&st);
                let crit = CHI2_CRIT[sc.n - 2];
                let top = *st.wins.iter().max().unwrap() as f64 / st.seeds as f64;
                let mut why = Vec::new();
                if c > crit {
                    why.push(format!("chi2 {c:.1} > {crit}"));
                }
                if z > SHARE_Z_MAX {
                    why.push(format!("share |z| {z:.1} > {SHARE_Z_MAX}"));
                }
                if sc.n == 5 && top > FIVE_OPTION_CAP {
                    why.push(format!("an option won {:.1}% > 30%", 100.0 * top));
                }
                let line = format!("fair: chi2 {c:.1} (crit {crit}), worst share |z| {z:.1}");
                if why.is_empty() {
                    (format!("ok    {line}"), true)
                } else {
                    (format!("FAIL  {line}: {}", why.join(", ")), false)
                }
            }
            Gate::Uneven => ("--    uneven by design, not gated".to_string(), true),
            Gate::Steer(o, base) => match done.iter().find(|(n, _)| n == base) {
                Some((_, b)) => {
                    let z = steer_z(&st, b, o);
                    let line = format!(
                        "steer: option {o} wins {}% vs {}% unsteered, z {z:.1}",
                        pct(st.wins[o], st.seeds).trim(),
                        pct(b.wins[o], b.seeds).trim()
                    );
                    if z > STEER_Z_MIN {
                        (format!("ok    {line}"), true)
                    } else {
                        (format!("FAIL  {line} (need z > {STEER_Z_MIN})"), false)
                    }
                }
                None => (format!("--    baseline '{base}' not run"), true),
            },
        };
        println!("{} ({} seeds, {secs:.1} s)", sc.name, st.seeds);
        println!("  wins  {}", row(st.wins.iter().map(|&w| pct(w, st.seeds)).collect()));
        println!(
            "  share {}",
            row(st.share_mean.iter().map(|&s| format!("{:5.1}", s / 100.0)).collect())
        );
        println!(
            "  src   {}   ties {}",
            row(st.source_wins.iter().map(|&w| pct(w, st.seeds)).collect()),
            st.ties
        );
        println!("  {verdict}");
        if !ok {
            failures.push(sc.name.clone());
        }
        done.push((sc.name, st));
    }

    println!();
    if failures.is_empty() {
        println!("all gates pass");
    } else {
        println!("{} gate(s) failed: {}", failures.len(), failures.join("; "));
        if check {
            std::process::exit(1);
        }
    }
}
