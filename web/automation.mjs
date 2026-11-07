// "Who keeps it moving": the keeper, agent and cranker roles summarised from
// what the chain says they did. Pure, so Node can test it; live.html reads the
// chain and draws the rows.

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// keepers: [{ id, posted }], quorum
// agents: [{ id, posts }] (posts: markets of this round it posted on, or null if unknown)
// marketCount: markets in the round (0 before the keepers' post is final)
// cranks: the account of each colony cranked so far, one entry per colony
// total: colonies the round has in all
export function automationRows({ keepers, quorum, agents, marketCount, cranks, total }) {
  const posted = keepers.filter((k) => k.posted).length;
  const byCranker = new Map();
  for (const c of cranks) if (c) byCranker.set(c, (byCranker.get(c) ?? 0) + 1);
  return [
    {
      key: "keepers", title: "Keepers post the markets",
      status: keepers.length ? `${posted} of ${keepers.length} posted · quorum ${quorum}` : "none allow-listed",
      accounts: keepers.map((k) => ({ id: k.id, note: k.posted ? "posted" : "waiting" })),
    },
    {
      key: "agents", title: "Agents post forecasts",
      status: !agents.length ? "no forecaster agents registered"
        : marketCount ? `${plural(agents.length, "agent")} registered · ${marketCount} markets open to post on`
        : `${plural(agents.length, "agent")} registered`,
      accounts: agents.map((a) => ({
        id: a.id, note: a.posts == null || !marketCount ? "registered" : `posted on ${a.posts} of ${marketCount}`,
      })),
    },
    {
      key: "crankers", title: "Crankers run the colonies",
      status: total ? `${cranks.length} of ${total} colonies cranked` : "no colonies to run yet",
      accounts: [...byCranker].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .map(([id, n]) => ({ id, note: plural(n, "colony", "colonies") })),
    },
  ];
}
