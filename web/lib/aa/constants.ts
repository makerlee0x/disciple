/** Shared smart-account addresses (client + server). No SDK imports here so it stays tiny and server-safe. */
import type { Address } from "viem";
import { MAINNET_CHAIN_ID, PUBLIC_NETWORK, nonzeroAddress } from "../networkConfig";
const mainnet = Number(process.env.NEXT_PUBLIC_CHAIN_ID) === MAINNET_CHAIN_ID;
const configured = (v?: string) => (nonzeroAddress(v) ? v : "0x0000000000000000000000000000000000000000") as Address;

export const ENTRYPOINT_V07 = mainnet ? configured(PUBLIC_NETWORK.entryPoint) : "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
/** Alchemy MAv2 factory: Privy-owned SemiModularAccountBytecode accounts (getAddressSemiModular(owner, salt)). */
export const MAV2_FACTORY = mainnet ? configured(PUBLIC_NETWORK.factory) : "0x00000000000017c61b5bEe81050EC8eFc9c6fecd" as Address;
/** Legacy LightAccount v2 factory (pre-Privy testnet accounts). */
export const LIGHT_ACCOUNT_V2_FACTORY = "0x0000000000400CdFef5E2714E63d8040b700BC24" as Address;
