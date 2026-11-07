// Usage: dump <first_seed> <count>
// Prints one JSON line per seed, in the same format as sim/tests/dump.mjs:
// the result hashes for n=5, n=2 and a forecast-style run with fixed richness.
// crosscheck.py compares these with the Python reference.
use antosim::{run, seed_from_int, N_ANTS, TICKS};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let first: u64 = args
        .get(1)
        .and_then(|s| s.parse().ok())
        .expect("first_seed");
    let count: u64 = args.get(2).and_then(|s| s.parse().ok()).expect("count");
    for i in first..first + count {
        let seed = seed_from_int(i);
        let a = run(&seed, 5, None, N_ANTS, TICKS).unwrap();
        let b = run(&seed, 2, None, N_ANTS, TICKS).unwrap();
        let c = run(&seed, 3, Some(&[3000, 1200, 500]), N_ANTS, TICKS).unwrap();
        println!(
            "{{\"i\":{},\"h5\":\"{}\",\"h2\":\"{}\",\"h3\":\"{}\",\"w5\":{}}}",
            i,
            a.hash_hex(),
            b.hash_hex(),
            c.hash_hex(),
            a.winner_option
        );
    }
}
