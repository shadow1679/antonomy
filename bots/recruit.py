"""Recruit the swarm: the agent tool. Request a swarm forecast on any
Polymarket market, post your own odds as a forecaster agent, crank the
colonies for the bounty, and verify any result from its seed.

Usage:
  python3 -I bots/recruit.py ask --contract C --account A --market SLUG [--wait] [--crank] [--send]
  python3 -I bots/recruit.py register --contract C --account A [--send]
  python3 -I bots/recruit.py post --contract C --account A --request ID --odds 6000,3000,1000 [--send]
  python3 -I bots/recruit.py crank --contract C --account A --request ID [--send]
  python3 -I bots/recruit.py verify --contract C --request ID
  python3 -I bots/recruit.py mcp --contract C --account A [--send]

ask       pays the request fee for a forecast on the Polymarket event with slug
          SLUG. If a request for that slug exists already, it reads that one
          instead of paying again. --wait polls until the swarm belief is in
          (printing each phase); --crank also calls the permissionless steps
          (finalize the odds, crank the colonies) when they are due, which
          earns the crank bounty.
register  becomes a forecaster agent: moves the refundable deposit.
post      posts your odds for request ID (or --colony N for a trending market
          of the round), in basis points, one per outcome, summing to 10000.
          Your odds count once per request; a repost replaces them.
crank     finalizes the odds or runs the next colony of request ID, whichever
          is due. Three cranks run the three colonies, one each.
verify    re-runs request ID with the Python reference sim (sim/python) from
          the seed, odds and agent median the contract stored, and compares
          every colony hash and the market hash. Read-only.
mcp       serves ask_swarm, post_forecast and verify as an MCP server on
          stdio (JSON-RPC 2.0, one message per line), for any MCP client.

Pay is for work, never for being right: keepers, forecaster agents with
on-time posts and crankers share the fee, and the rest goes to the treasury. Every swarm belief is a forecast, not advice, and not
yet calibrated as a probability. Testnet play token only.

Without --send nothing is signed: the NEAR CLI command goes to stderr and the
JSON plan to stdout. Reads go to a public RPC (read-only, no keys); writes go
through the NEAR CLI and the local keychain. Give the agent a key that can
only call these methods:
  near account add-key <agent> grant-function-call-access --allowance '0.5 NEAR' \\
    --contract-account-id <contract> --function-names 'request_forecast, register_agent, \\
    unregister_agent, post_forecast, finalize_request_odds, crank_request' \\
    autogenerate-new-keypair save-to-keychain network-config testnet sign-with-keychain send
Python standard library only, no paid LLM calls. Your own model decides the
odds you post; this tool only carries them.
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "sim", "python"))
from swarm import RPC, Chain, fetch_beacon, near_call  # noqa: E402

BPS = 10_000
ONE = 10**24
REQUEST_COLONY_BASE = 0x8000     # token/src/request.rs: request id -> colony
KIND_NAMES = ("Momentum", "Community", "Agents")
LABEL = "Forecast, not advice. Swarm belief is not yet calibrated as a probability."
POLL_S = 15


def tokens(yocto):
    return "%g" % (int(yocto) / ONE)


def parse_odds(text):
    try:
        return [int(x) for x in str(text).replace(" ", "").split(",") if x != ""]
    except ValueError:
        raise ValueError("odds must be whole basis points, like 6000,3000,1000")


def resolve_odds(spec, outcomes):
    """Odds for a market's outcomes from "6000,3000,1000" (in the market's
    order) or "Cut=6000,Hold=3000,Hike=1000" (by label, any order). Agents
    asking before the keepers post don't know the order yet, so labels help."""
    text = str(spec).strip()
    if "=" not in text:
        return parse_odds(text)
    given = {}
    for part in text.split(","):
        label, _, value = part.rpartition("=")
        label = label.strip()
        if label not in outcomes:
            raise ValueError("no outcome %r; the outcomes are %s" % (label, ", ".join(outcomes)))
        try:
            given[label] = int(value.strip())
        except ValueError:
            raise ValueError("odds must be whole basis points, like Cut=6000")
    missing = [o for o in outcomes if o not in given]
    if missing:
        raise ValueError("no odds for %s" % ", ".join(missing))
    return [given[o] for o in outcomes]


def check_odds(odds, n):
    """Reason the contract would refuse these odds for an n-outcome market, or None."""
    if len(odds) != n:
        return "the market has %d outcomes, got %d odds" % (n, len(odds))
    if any(o < 0 or o > BPS for o in odds):
        return "each value must be 0 to 10000 basis points"
    if sum(odds) != BPS:
        return "odds must sum to exactly 10000, got %d" % sum(odds)
    return None


def find_request(chain, slug):
    """The newest request for this slug that wasn't skipped, or None."""
    count = chain.view("forecast_request_count")
    best = None
    for start in range(0, count, 50):
        for r in chain.view("forecast_requests", {"from_id": start, "limit": 50}):
            if r["market_id"] == slug and r["phase"] != "skipped":
                best = r
    return best


def describe(r):
    """A request as a JSON summary an agent can act on."""
    out = {"request_id": r["id"], "colony": r["colony"], "market": r["market_id"], "phase": r["phase"]}
    m = r.get("market")
    if m:
        out["outcomes"] = m["outcomes"]
        out["market_odds"] = m["odds"]
    if r["phase"] == "odds":
        out["keepers_post_until_ms"] = r["odds_by_ms"]
    if r["phase"] == "forecasting":
        out["agents_post_until_ms"] = r["forecast_by_ms"]
        out["holders_stake_until_ms"] = r["forecast_by_ms"]
    if r.get("stakes"):
        out["community_stake_weights"] = r["stakes"]["weights"]
    if r["phase"] in ("running", "done"):
        out["colonies_cranked"] = len(r["colony_hashes"])
    if r["phase"] == "done":
        out["swarm_belief"] = r["swarm"]
        out["market_hash"] = r["market_hash"]
        out["label"] = LABEL
    if r["phase"] == "skipped":
        out["note"] = "no keeper quorum: the request was skipped and the fee refunded"
    return out


def due(r, now_ms):
    """The permissionless call request r is waiting for now, or None."""
    if r["phase"] == "odds" and now_ms >= r["odds_by_ms"]:
        return "finalize_request_odds"
    if r["phase"] == "forecasting" and now_ms >= r["forecast_by_ms"]:
        return "crank_request"
    if r["phase"] == "running":
        return "crank_request"
    return None


def verify(chain, request_id):
    """Re-run a finished request from the contract's stored inputs."""
    import antosim
    r = chain.view("forecast_request", {"request_id": int(request_id)})
    if r is None:
        return {"request_id": request_id, "ok": False, "reason": "no such request"}
    if r["phase"] != "done":
        return {"request_id": request_id, "ok": False, "reason": "not finished (phase %s)" % r["phase"]}
    m, ag, st = r["market"], r["agents"], r["stakes"]
    res = antosim.forecast_market(
        bytes.fromhex(r["seed"]), r["colony"], m["odds"], m["odds_6h"], st["weights"],
        bytes.fromhex(st["hash"]), ag["odds"], bytes.fromhex(ag["hash"]))
    mine = [c["hash"] for c in res["colonies"]]
    colonies = [{"kind": k, "chain": a, "replay": b, "match": a == b}
                for k, a, b in zip(KIND_NAMES, r["colony_hashes"], mine)]
    ok = all(c["match"] for c in colonies) and res["hash"] == r["market_hash"] and res["swarm"] == r["swarm"]
    return {"request_id": r["id"], "ok": ok, "colonies": colonies, "market_hash": r["market_hash"],
            "replay_hash": res["hash"], "swarm_belief": res["swarm"], "label": LABEL}


class Tool:
    """The agent actions, shared by the command line and the MCP server.
    `run(cmd)` signs a NEAR CLI command, or in a dry run only prints it, and
    returns whether it was sent."""

    def __init__(self, chain, contract, account, network, run, now_ms=None, beacon=None):
        self.chain, self.contract, self.account, self.network = chain, contract, account, network
        self.run = run
        self.now_ms = now_ms or (lambda: int(time.time() * 1000))
        self.beacon = beacon or fetch_beacon

    def call(self, method, args):
        return self.run(near_call(self.contract, method, args, self.account, self.network))

    def ask_swarm(self, market):
        """The existing request for `market`, or a new one (paying the fee)."""
        r = find_request(self.chain, market)
        if r is not None:
            return describe(r)
        fee = tokens(self.chain.view("request_config")["fee"])
        count = self.chain.view("forecast_request_count")
        if not self.call("request_forecast", {"market_id": market}):
            return {"market": market, "fee": fee, "sent": False, "note": "dry run: nothing signed (add --send)"}
        for r in self.chain.view("forecast_requests", {"from_id": count, "limit": 50}):
            if r["market_id"] == market and r["requester"] == self.account:
                return dict(describe(r), fee=fee, sent=True)
        return {"market": market, "fee": fee, "sent": True, "note": "sent; the request isn't visible yet"}

    def post_forecast(self, odds, request_id=None, colony=None):
        if (request_id is None) == (colony is None):
            raise ValueError("give a request id or a colony")
        if request_id is not None:
            r = self.chain.view("forecast_request", {"request_id": int(request_id)})
            if r is None:
                raise ValueError("no request %s" % request_id)
            if r["phase"] != "forecasting":
                raise ValueError("request %s is not taking agent posts (phase %s)" % (request_id, r["phase"]))
            outcomes, colony = r["market"]["outcomes"], r["colony"]
        else:
            ms = self.chain.view("forecast_markets") or []
            m = next((m for m in ms if m["colony"] == int(colony)), None)
            if m is None:
                raise ValueError("colony %s is not a trending market of this round" % colony)
            outcomes = m["outcomes"]
        why = check_odds(odds, len(outcomes))
        if why:
            raise ValueError(why)
        if not self.chain.view("is_agent", {"account_id": self.account}):
            raise ValueError("%s is not a registered forecaster agent: run `register` first" % self.account)
        sent = self.call("post_forecast", {"colony": int(colony), "odds": odds})
        return {"colony": int(colony), "outcomes": outcomes, "odds": odds, "sent": sent}

    def register(self):
        if self.chain.view("is_agent", {"account_id": self.account}):
            return {"account": self.account, "registered": True, "note": "already registered"}
        deposit = tokens(self.chain.view("request_config")["agent_deposit"])
        return {"account": self.account, "deposit": deposit, "sent": self.call("register_agent", {})}

    def crank(self, request_id):
        r = self.chain.view("forecast_request", {"request_id": int(request_id)})
        if r is None:
            raise ValueError("no request %s" % request_id)
        step = due(r, self.now_ms())
        if step is None:
            return dict(describe(r), note="nothing due yet")
        args = {"request_id": int(request_id)}
        if r["phase"] == "forecasting" and r.get("drand_round") is not None:
            # The first crank draws the seed: it carries the committed drand
            # round's signature, which the contract checks.
            sig = self.beacon(r["drand_round"])
            if sig is None:
                return dict(describe(r), note="waiting for drand round %d" % r["drand_round"])
            args["drand_signature"] = sig
        return dict(describe(r), called=step, sent=self.call(step, args))

    def verify(self, request_id):
        return verify(self.chain, request_id)


# ---- MCP over stdio -------------------------------------------------------

TOOLS = [
    {
        "name": "ask_swarm",
        "description": "Ask the Antonomy ant swarm for a forecast on a Polymarket event, by slug. "
                       "Returns the existing request for that slug, or pays the $ANTO fee for a new one. "
                       "Once its three colonies are cranked the result has the swarm belief per outcome "
                       "(basis points) and a market hash. A forecast, not advice.",
        "inputSchema": {"type": "object", "properties": {
            "market": {"type": "string", "description": "Polymarket event slug, e.g. fed-decision-in-december"}},
            "required": ["market"]},
    },
    {
        "name": "post_forecast",
        "description": "Post this forecaster agent's own odds for a requested market (request_id) or a "
                       "trending market colony (colony): basis points, one per outcome in the market's "
                       "order, summing to 10000. The agents' median feeds the Agents colony. Paid for "
                       "posting on time, never for being right.",
        "inputSchema": {"type": "object", "properties": {
            "request_id": {"type": "integer"},
            "colony": {"type": "integer"},
            "odds": {"type": "array", "items": {"type": "integer", "minimum": 0, "maximum": 10000}}},
            "required": ["odds"]},
    },
    {
        "name": "verify",
        "description": "Re-run a finished request from its seed with the reference sim and compare "
                       "every colony hash and the market hash with the contract's. Read-only.",
        "inputSchema": {"type": "object", "properties": {"request_id": {"type": "integer"}},
                        "required": ["request_id"]},
    },
]


def mcp_handle(tool, msg):
    """One JSON-RPC message in, one reply out (None for notifications)."""
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if mid is None:
        return None

    def ok(result):
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    if method == "initialize":
        return ok({
            "protocolVersion": params.get("protocolVersion") or "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "antonomy-recruit", "version": "0.1.0"},
            "instructions": "Antonomy swarm forecasts on NEAR testnet. " + LABEL,
        })
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": TOOLS})
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        try:
            if name == "ask_swarm":
                out = tool.ask_swarm(str(args["market"]))
            elif name == "post_forecast":
                out = tool.post_forecast([int(x) for x in args["odds"]],
                                         request_id=args.get("request_id"), colony=args.get("colony"))
            elif name == "verify":
                out = tool.verify(int(args["request_id"]))
            else:
                return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": "unknown tool %r" % name}}
        except (KeyError, ValueError, TypeError, RuntimeError, OSError, subprocess.CalledProcessError) as e:
            return ok({"content": [{"type": "text", "text": "error: %s" % e}], "isError": True})
        return ok({"content": [{"type": "text", "text": json.dumps(out)}], "structuredContent": out})
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found: %s" % method}}


def serve_mcp(tool, inp=sys.stdin, out=sys.stdout):
    for line in inp:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            reply = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}}
        else:
            reply = mcp_handle(tool, msg)
        if reply is not None:
            out.write(json.dumps(reply) + "\n")
            out.flush()


# ---- command line ---------------------------------------------------------

def wait(tool, request_id, crank, sleep=time.sleep, odds=None):
    """Poll a request until it is done or skipped, cranking when asked. With
    `odds` (see `resolve_odds`), post them as this agent's forecast once the
    agents' window opens, so the Agents colony has your view in it."""
    last, posted = None, odds is None
    while True:
        r = tool.chain.view("forecast_request", {"request_id": int(request_id)})
        if r["phase"] != last:
            print("request %s: %s" % (r["id"], r["phase"]), file=sys.stderr)
            last = r["phase"]
        if r["phase"] in ("done", "skipped"):
            return describe(r)
        if not posted and r["phase"] == "forecasting":
            out = tool.post_forecast(resolve_odds(odds, r["market"]["outcomes"]), request_id=r["id"])
            print("posted your forecast: %s" % json.dumps(dict(zip(out["outcomes"], out["odds"]))), file=sys.stderr)
            posted = True
            continue
        if crank and due(r, tool.now_ms()):
            tool.crank(request_id)
            continue
        sleep(POLL_S)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("command", choices=["ask", "register", "post", "crank", "verify", "mcp"])
    p.add_argument("--contract", required=True)
    p.add_argument("--account", help="your testnet account (signs with --send)")
    p.add_argument("--market", help="ask: Polymarket event slug")
    p.add_argument("--request", type=int, help="post, crank, verify: request id")
    p.add_argument("--colony", type=int, help="post: a trending market's colony instead of a request")
    p.add_argument("--odds", help="post: basis points per outcome, like 6000,3000,1000; "
                   "ask --wait: also post them as your forecast when agents may post "
                   "(in the market's order, or by label: Cut=6000,Hold=3000,Hike=1000)")
    p.add_argument("--wait", action="store_true", help="ask: poll until the swarm belief is in")
    p.add_argument("--crank", action="store_true", help="ask --wait: call finalize and crank when due")
    p.add_argument("--rpc", default=RPC)
    p.add_argument("--network", default="testnet")
    p.add_argument("--send", action="store_true", help="sign and send with the NEAR CLI")
    a = p.parse_args(argv)
    if a.command != "verify" and not a.account:
        p.error("%s needs --account" % a.command)
    if a.command == "ask" and not a.market:
        p.error("ask needs --market")
    if a.command == "ask" and a.odds is not None and not a.wait:
        p.error("ask --odds needs --wait (the agents' window opens after the keepers post)")
    if a.command == "post" and (a.odds is None or (a.request is None) == (a.colony is None)):
        p.error("post needs --odds and one of --request or --colony")
    if a.command in ("crank", "verify") and a.request is None:
        p.error("%s needs --request" % a.command)
    chain = Chain(a.rpc, a.contract)

    def run(cmd):
        print(shlex.join(cmd), file=sys.stderr)
        if a.send:
            # The CLI's own output goes to stderr so stdout stays JSON (and MCP).
            subprocess.run(cmd, check=True, stdout=sys.stderr)
        return a.send

    tool = Tool(chain, a.contract, a.account, a.network, run)
    if a.command == "mcp":
        serve_mcp(tool)
        return 0
    try:
        if a.command == "ask":
            if a.odds is not None and not chain.view("is_agent", {"account_id": a.account}):
                raise ValueError("%s is not a registered forecaster agent: run `register` first" % a.account)
            out = tool.ask_swarm(a.market)
            if a.wait and out.get("sent", True) and "request_id" in out:
                out = wait(tool, out["request_id"], a.crank, odds=a.odds)
        elif a.command == "register":
            out = tool.register()
        elif a.command == "post":
            out = tool.post_forecast(parse_odds(a.odds), request_id=a.request, colony=a.colony)
        elif a.command == "crank":
            out = tool.crank(a.request)
        else:
            out = tool.verify(a.request)
    except ValueError as e:
        print("error: %s" % e, file=sys.stderr)
        return 1
    print(json.dumps(out))
    return 0 if out.get("ok", True) else 1


if __name__ == "__main__":
    sys.exit(main())
