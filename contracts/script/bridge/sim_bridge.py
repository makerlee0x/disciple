#!/usr/bin/env python3
"""Run the Disciple launch sim and print the MILESTONE lines.

The math lives in BridgeCurve / BridgeFee. This wrapper does not reimplement it.
test_simActive and test_simDead are the full moving-anchor campaign.
"""

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACTS = os.path.abspath(os.path.join(HERE, "..", ".."))


def main() -> int:
    env = os.environ.copy()
    env["PATH"] = os.path.expanduser("~/.foundry/bin") + os.pathsep + env.get("PATH", "")
    cmd = [
        "forge",
        "test",
        "--match-contract",
        "DiscipleSimTest",
        "--match-test",
        "test_simActive|test_simDead",
        "-vv",
        "--offline",
    ]
    proc = subprocess.run(cmd, cwd=CONTRACTS, env=env, text=True, capture_output=True)
    sys.stderr.write(proc.stderr)
    lines = [ln for ln in proc.stdout.splitlines() if "MILESTONE " in ln]
    if not lines:
        sys.stdout.write(proc.stdout)
        return proc.returncode or 1
    for ln in lines:
        idx = ln.find("MILESTONE ")
        print(ln[idx:])
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
