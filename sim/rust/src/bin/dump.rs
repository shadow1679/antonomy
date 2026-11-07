// Usage: dump <first_seed> <count> [day]
// With "day", prints only hd: the Burn colony's daily run (150 ants, BURN_TICKS).
// Prints one JSON line per seed, in the same format as sim/tests/dump.mjs:
// the result hashes for n=5, n=2, a run with fixed richness, a Burn colony with
// stakes and the five forecasters on one market (60 ants, 300 ticks), plus two
// whole forecast markets (hs with agent posts, hy without).
// crosscheck.py compares these with the Python reference.
use antosim::{
    burn_run, forecast_market, forecast_run, market_colony, run, seed_from_int, sha256, Kind,
    BURN_TICKS, FORECAST_ANTS, FORECAST_TICKS, N_ANTS, TICKS,
};

// Fixtures shared with crosscheck.py and sim/tests/dump.mjs.
const BURN_WEIGHTS: [u32; 5] = [0, 40000, 9000, 0, 2500];
const ODDS: [u16; 3] = [6200, 2800, 1000];
const ODDS_6H: [u16; 3] = [5500, 3300, 1200];
const MARKET_WEIGHTS: [u32; 3] = [3000, 0, 12000];
const BINARY_ODDS: [u16; 2] = [9000, 1000];
const AGENT_ODDS: [u16; 3] = [4500, 4000, 1500];

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let first: u64 = args
        .get(1)
        .and_then(|s| s.parse().ok())
        .expect("first_seed");
    let count: u64 = args.get(2).and_then(|s| s.parse().ok()).expect("count");
    let day = args.get(3).is_some_and(|a| a == "day");
    let stake_hash = sha256(b"stakes");
    let agent_hash = sha256(b"agents");
    for i in first..first + count {
        let seed = seed_from_int(i);
        if day {
            let d = burn_run(&seed, &BURN_WEIGHTS, stake_hash, N_ANTS, BURN_TICKS).unwrap();
            println!("{{\"i\":{},\"hd\":\"{}\"}}", i, d.hash_hex());
            continue;
        }
        let a = run(&seed, 5, None, N_ANTS, TICKS).unwrap();
        let b = run(&seed, 2, None, N_ANTS, TICKS).unwrap();
        let c = run(&seed, 3, Some(&[300, 250, 200]), N_ANTS, TICKS).unwrap();
        let burn = burn_run(&seed, &BURN_WEIGHTS, stake_hash, 60, 300).unwrap();
        let small = |kind| {
            forecast_run(
                &seed,
                kind,
                &ODDS,
                &ODDS_6H,
                &MARKET_WEIGHTS,
                stake_hash,
                &AGENT_ODDS,
                agent_hash,
                60,
                300,
            )
            .unwrap()
            .hash_hex()
        };
        let market = |m, odds: &[u16], odds_6h: &[u16], w: &[u32], h, a: &[u16], ah| {
            forecast_market(
                &seed,
                market_colony(m),
                odds,
                odds_6h,
                w,
                h,
                a,
                ah,
                FORECAST_ANTS,
                FORECAST_TICKS,
            )
            .unwrap()
            .hash_hex()
        };
        println!(
            "{{\"i\":{},\"h5\":\"{}\",\"h2\":\"{}\",\"h3\":\"{}\",\"w5\":{},\"hb\":\"{}\",\"hm\":\"{}\",\"hk\":\"{}\",\"ha\":\"{}\",\"hs\":\"{}\",\"hy\":\"{}\"}}",
            i,
            a.hash_hex(),
            b.hash_hex(),
            c.hash_hex(),
            a.winner_option,
            burn.hash_hex(),
            small(Kind::Momentum),
            small(Kind::Community),
            small(Kind::Agents),
            market(0, &ODDS, &ODDS_6H, &MARKET_WEIGHTS, stake_hash, &AGENT_ODDS, agent_hash),
            market(1, &BINARY_ODDS, &BINARY_ODDS, &[0, 0], [0; 32], &[0, 0], [0; 32])
        );
    }
}
