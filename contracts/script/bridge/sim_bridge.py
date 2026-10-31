#!/usr/bin/env python3
"""Run the Disciple V2 launch sim and print MILESTONE and PICK lines.

The math lives in BridgeCurve / BridgeFee and DiscipleSim.t.sol. This wrapper does not
reimplement it. `test_simV2` is the campaign: COMBO first, then the comparison books.
SIM_DAYS, when set, shortens every profile including the knob search.
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACTS = os.path.abspath(os.path.join(HERE, "..", ".."))


def main() -> int:
    env = os.environ.copy()
    env["PATH"] = os.path.expanduser("~/.foundry/bin") + os.pathsep + env.get("PATH", "")
    env["SIM_V2"] = env.get("SIM_V2", "1")
    cmd = [
        "forge",
        "test",
        "--match-contract",
        "DiscipleSimTest",
        "--match-test",
        "test_simV2",
        "-vv",
        "--offline",
        "-j",
        "1",
    ]
    proc = subprocess.run(cmd, cwd=CONTRACTS, env=env, text=True, capture_output=True)
    sys.stderr.write(proc.stderr)
    lines = [ln for ln in proc.stdout.splitlines() if "MILESTONE " in ln or "PICKCFG " in ln or "PICK winner " in ln]
    if not lines:
        sys.stdout.write(proc.stdout)
        return proc.returncode or 1
    for ln in lines:
        for key in ("MILESTONE ", "PICKCFG ", "PICK winner "):
            idx = ln.find(key)
            if idx >= 0:
                print(ln[idx:])
                break
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
