# F-01 / #251 verification result

Started: 2026-11-06 09:34 CST (America/Chicago). Completed: 2026-11-06 09:43 CST.

**Intended on-chain batches: all six ADMITTED by both reference parsers; all six execute successfully and postOp emits a charge with reservedAfter=0.**

**Do not call the actual site flow ready:** the pure client preflight reproduces a separate funding-approval stripping defect in `withPaymasterApprove`. See README and site-preflight.json. No source change made.

Fork block: 149593542. Initial base fee: 10000000 wei. Rate: 2,300,000,000 USDG base units per ETH ($2300/ETH).

| Op | Admission | Account / factory validation | PM validation | Execution | PostOp | EP actual gas | USDG charged | Effective wei/gas |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| a setup $2 + session install | ADMITTED | 17407 / 76875 | 135615 | 624870 | 56575 | 1107411 | 0.014657 | 5026961 |
| b session boost buy | ADMITTED | 54758 / 0 | 132863 | 641492 | 49976 | 1107819 | 0.012871 | 4536091 |
| c buy + hidden top-up batch | ADMITTED | 58433 / 0 | 174038 | 769258 | 40376 | 1259313 | 0.013122 | 4106580 |
| d session sell | ADMITTED | 54786 / 0 | 115421 | 567190 | 49976 | 1023533 | 0.009878 | 3730758 |
| e owner launch | ADMITTED | 17861 / 0 | 113445 | 6403882 | 52476 | 7480069 | 0.059656 | 3401914 |
| f withdraw/send release | ADMITTED | 17968 / 0 | 115317 | 56988 | 35534 | 514376 | 0.004561 | 3114175 |

All unstaked paymaster counterfactuals are REJECTED: canonical parser EREP-050 + generic STO-010 (own-storage stake exception STO-031), legacy parser -32502. Actual stake 2173913043478261 wei, unstake delay 86400 sec.

Tools: Anvil/Forge 1.8.5 (51a52c59cffd940f76eddd0b4bb1791aa4b5ac7f); solc 0.8.26 normal compiler; Node v24.22.1; ethers 5.7.2; bundler aae77140e5c2b1386d04eaeba2d23fc17a62bd87. Reference JS tracer, legacy parser and canonical parser through documented aggregate trace adapter; not native erc7562Tracer or actual Alchemy API admission.

Gas columns are measured call frames and are not additive to the billable EntryPoint event gas (overhead/penalties apply). USDG amounts are actual paymaster charge events.

Proposed fix only: preserve exact approve+deposit funding pairs in paymasterClient.ts; remove only obsolete standalone approvals; add regression coverage for setup/auto-top-up through payGasInUsdg. Owner: SITE. Done: both retain the exact funding leg end-to-end, without gas UI or extra wallet prompts. No contract redesign, merge or deploy.

Tracked checkout is clean. No full suite/fuzz, no secrets, no live-network write, no PR edit/comment/push.
