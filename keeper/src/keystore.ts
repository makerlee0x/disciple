// Decrypts a Foundry (`cast wallet import`) keystore: Web3 Secret Storage v3, scrypt or pbkdf2 + aes-128-ctr.
// The private key never leaves memory and is never logged.
import { createDecipheriv, pbkdf2Sync, scryptSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { bytesToHex, concat, keccak256, type Hex } from "viem";

export function keystorePath(nameOrPath: string): string {
  if (nameOrPath.includes("/")) return nameOrPath;
  return join(homedir(), ".foundry", "keystores", nameOrPath);
}

export function decryptKeystore(json: string, password: string): Hex {
  const ks = JSON.parse(json);
  const c = ks.crypto ?? ks.Crypto;
  if (!c) throw new Error("not a v3 keystore");
  const kp = c.kdfparams;
  const salt = Buffer.from(kp.salt, "hex");
  let dk: Buffer;
  if (c.kdf === "scrypt") {
    dk = scryptSync(password, salt, kp.dklen, { N: kp.n, r: kp.r, p: kp.p, maxmem: 256 * kp.n * kp.r + 1024 * 1024 });
  } else if (c.kdf === "pbkdf2") {
    dk = pbkdf2Sync(password, salt, kp.c, kp.dklen, (kp.prf ?? "hmac-sha256").replace("hmac-", ""));
  } else {
    throw new Error(`unsupported kdf ${c.kdf}`);
  }
  const ct = Buffer.from(c.ciphertext, "hex");
  const mac = keccak256(concat([new Uint8Array(dk.subarray(16, 32)), new Uint8Array(ct)]));
  if (mac.slice(2).toLowerCase() !== String(c.mac).toLowerCase()) throw new Error("wrong keystore password");
  if (c.cipher !== "aes-128-ctr") throw new Error(`unsupported cipher ${c.cipher}`);
  const d = createDecipheriv("aes-128-ctr", dk.subarray(0, 16), Buffer.from(c.cipherparams.iv, "hex"));
  const pk = Buffer.concat([d.update(ct), d.final()]);
  return bytesToHex(new Uint8Array(pk));
}

/** Asks for the password on the terminal without echoing it. */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) return reject(new Error("no terminal for the password: set KEEPER_PASSWORD_FILE"));
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let asked = false;
    out._writeToOutput = (s: string) => {
      if (!asked) {
        out.output.write(s);
        asked = true;
      }
    };
    rl.question(question, (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a);
    });
  });
}

/** Password from KEEPER_PASSWORD_FILE, else KEEPER_PASSWORD, else the terminal. */
export async function loadKey(account: string): Promise<Hex> {
  const json = readFileSync(keystorePath(account), "utf8");
  let pw: string;
  if (process.env.KEEPER_PASSWORD_FILE) pw = readFileSync(process.env.KEEPER_PASSWORD_FILE, "utf8").replace(/\r?\n$/, "");
  else if (process.env.KEEPER_PASSWORD !== undefined) pw = process.env.KEEPER_PASSWORD;
  else pw = await promptHidden(`Keystore password for "${account}": `);
  return decryptKeystore(json, pw);
}

