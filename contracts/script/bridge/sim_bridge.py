#!/usr/bin/env python3
"""Run the 7-day launch sim against the Solidity curve and print the SIM_ lines.

The math lives in BridgeCurve / BridgeFee. This wrapper does not reimplement it.
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
        "BridgeLaunchSimTest",
        "--match-test",
        "test_sim7Days",
        "-vv",
    ]
    proc = subprocess.run(cmd, cwd=CONTRACTS, env=env, text=True, capture_output=True)
    sys.stderr.write(proc.stderr)
    lines = [ln for ln in proc.stdout.splitlines() if "SIM_" in ln]
    if not lines:
        sys.stdout.write(proc.stdout)
        return proc.returncode or 1
    for ln in lines:
        # forge prefixes logs with spaces; keep the message body.
        idx = ln.find("SIM_")
        print(ln[idx:])
    return proc.returncode


if __name__ == "__main__":
    sys.exit(main())
