"""Example strategy for bots/recruit.py. Copy this file, change decide(), and run
  python3 -I bots/recruit.py --contract <contract> --account <you.testnet> --strategy <your file>

decide(r) gets a recruit.Round and returns [(option, amount), ...] with amounts
in yocto (r.tokens(n) converts whole tokens). Return [] to sit the round out.
The kit drops bad options and clips amounts to the balance and the wallet cap,
so a greedy answer is safe. Options index the burn menu r.menu_bps
([10, 25, 50, 100, 200] basis points of the treasury).

This one is a value seeker. For each option it multiplies a rough chance to
win (the option's share of food in the sim after its stake) by the reward it
would get if that option wins (its share of the pot by raw stake), and stakes
on the best product. Thinly staked options pay more per token, heavily staked
ones win more often. Both numbers move as others stake before close, and food
share is only a proxy: how it maps to win rates hasn't been measured. Treat
this as a starting point.
"""

STAKE_TOKENS = 20  # per round; the wallet cap covers every colony together


def decide(r):
    amount = min(r.tokens(STAKE_TOKENS), r.balance, r.headroom)
    if amount <= 0:
        return []
    value = [r.food_share(o, amount) * r.payout_if_wins(o, amount) for o in range(r.n)]
    best = max(range(r.n), key=lambda o: (value[o], -o))  # ties to the lowest index, like the sim
    return [(best, amount)]
