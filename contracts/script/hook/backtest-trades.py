#!/usr/bin/env python3
"""Backtest past trades on the live v0.2 pool against the real Uniswap route. Read-only, sends nothing.

For each tx hash: read our HookSwap event (amounts, LP fee), fork Robinhood at the block BEFORE the trade, push the
same input through the Uniswap route (STRATEGY/MSTR x MSTR/USDG) and compare what the trader got.

    cd contracts
    FORK_RPC_RH=https://... python3 script/hook/backtest-trades.py              # the 7 trades so far
    FORK_RPC_RH=https://... python3 script/hook/backtest-trades.py 0xabc 0xdef  # any other hashes

Needs an archive RPC (forks old blocks). Each trade = one forge fork run (~20-60 s).
"""
import json, os, subprocess, sys

HOOK = "0xc0e513735f35df6a82523744e2ae8a601c772a88"
POOL = "0x8a1d5f363db9d4a7b874abc858a8fdc86786a9208835aa8360b953cad223b8cd"
DEFAULT = [
    "0xab6c2be1854968d07fc9e1e6f0a479d044217e08932d0e057a0da064acbdc51b",  # maker's $1 test buy
    "0xc3f4ea09b9281e64eb6a1f5d7ca7b5325adf81b4b2364a2127b31b93beddd5e1",
    "0xe62939a5b292626bb78e612d3b7243309777c4fdcbb685bdc3710e3820e5a3e3",
    "0x3ddc40d8ec7412bbd8599f03a220e30feb0417673d6bf1c8161b5af5e2ad5f20",
    "0xef1358c0c84048e3a810fe832c50ef80a3e2e513464337bc6a59d14a55804d22",
    "0xf48e1123c8ea839f68bb85f30ccb3ecd2a889dc141cae7be7bda5eb2d6f9d760",
    "0x9b409b6124a469cc782c4222b40d83fcadcfe4ded34b3efe62c7eec838346cc1",
]
rpc = os.environ.get("FORK_RPC_RH") or sys.exit("set FORK_RPC_RH")
hashes = sys.argv[1:] or DEFAULT


def run(cmd, env=None):
    return subprocess.run(cmd, capture_output=True, text=True, env=env).stdout


topic0 = run(["cast", "sig-event", "HookSwap(bytes32,address,int128,int128,uint128,uint128)"]).strip().lower()


def s128(word):
    v = int(word, 16)
    return v - (1 << 256) if v >= 1 << 255 else v


rows = []
for h in hashes:
    rc = json.loads(run(["cast", "receipt", h, "--json", "--rpc-url", rpc]) or "{}")
    log = next((l for l in rc.get("logs", []) if l["address"].lower() == HOOK and l["topics"][0].lower() == topic0
                and l["topics"][1].lower() == POOL), None)
    if not log:
        print(f"{h[:12]} no HookSwap for our pool, skipped")
        continue
    block = int(rc["blockNumber"], 16)
    d = log["data"][2:]
    a0, a1, f0, f1 = (s128(d[i * 64:(i + 1) * 64]) for i in range(4))  # pool view: + into the pool
    buy = a1 > 0  # USDG (currency1) in = buy STRATEGY
    amt_in, our_out = (a1, -a0) if buy else (a0, -a1)
    env = dict(os.environ, BT_BLOCK=str(block - 1), BT_BUY="true" if buy else "false", BT_IN=str(amt_in))
    out = run(["forge", "test", "--match-path", "test/hook/TradeBacktest.t.sol", "--match-test",
               "test_fork_backtestTrade", "-vv"], env=dict(env, FOUNDRY_PROFILE="solar"))
    line = next((l for l in out.splitlines() if "BTROW," in l), None)
    if not line:
        print(f"{h[:12]} forge run failed:\n{out[-1500:]}")
        continue
    _, mid, route_out = line.split("BTROW,")[1].split(",")[:3]
    mid, route_out = int(mid), int(route_out)  # mid = USDG raw per 1e18 STRATEGY raw
    usd_in = amt_in / 1e6 if buy else amt_in * mid / 1e18 / 1e6
    fee_usd = f1 / 1e6 + f0 * mid / 1e18 / 1e6
    edge = (our_out - route_out) / route_out * 1e4 if route_out else float("nan")
    gain_usd = ((our_out - route_out) * mid / 1e18 / 1e6) if buy else (our_out - route_out) / 1e6
    rows.append((h, block, buy, usd_in, edge, gain_usd, fee_usd))
    print(f"{h[:12]} block {block} {'BUY ' if buy else 'SELL'} ${usd_in:8.2f}  vs Uniswap route {edge:+7.0f}bp "
          f"(trader {'+' if gain_usd >= 0 else '-'}${abs(gain_usd):.3f})  our LP fee ${fee_usd:.4f}", flush=True)

if rows:
    vol = sum(r[3] for r in rows)
    print(f"\n{len(rows)} trades, volume ${vol:.2f}, LP fees ${sum(r[6] for r in rows):.4f} "
          f"(12% of fees go to the tip jar until it is full), traders vs Uniswap route ${sum(r[5] for r in rows):+.3f}")
    print(f"buys {sum(r[2] for r in rows)}, sells {sum(not r[2] for r in rows)}; "
          f"volume-weighted edge {sum(r[4] * r[3] for r in rows) / vol:+.0f}bp (+ = we gave more than Uniswap)")
