# GaslessForwarder

A short-lived Permit2 signature must not be reusable by someone else. If the spender is the public Multicall3 contract, the signature does not bind the recipient, because Multicall3 will not check it. UniswapX reactors, 0x Settler, and our own `DiscipleRouter.buyWithPermit2` already solve this the same way: a protocol contract is the Permit2 spender, it pulls the tokens to itself, and the signed witness names every recipient.

`GaslessForwarder` is that contract for two gasless paths:

- Private launch: the witness is the full launch, including who receives leftover cash.
- USDG withdraw: the witness names the destination, the fee, and who receives the fee.

The relayer submits one call (`launchAnon` or `withdraw`). A leaked signature cannot be pointed at a different address. Relays refuse if this contract has not been deployed on the chain; they do not fall back to Multicall3.

Gasless public actions (claims, tramp, wall) still use a separate Multicall3 fee permit on their own branch. This contract does not change that path.

This contract is not deployed yet. Do not invent an address, do not broadcast the deploy script, and do not merge until lee says yes.
