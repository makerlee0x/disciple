/** Shared smart-account addresses (client + server). No SDK imports here so it stays tiny and server-safe. */
import type { Address } from "viem";

export const ENTRYPOINT_V07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
/** Alchemy MAv2 factory: Privy-owned SemiModularAccountBytecode accounts (getAddressSemiModular(owner, salt)). */
export const MAV2_FACTORY = "0x00000000000017c61b5bEe81050EC8eFc9c6fecd" as Address;
/** Legacy LightAccount v2 factory (pre-Privy testnet accounts). */
export const LIGHT_ACCOUNT_V2_FACTORY = "0x0000000000400CdFef5E2714E63d8040b700BC24" as Address;
