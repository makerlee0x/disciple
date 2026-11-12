const { constants, utils } = require("ethers");
const AddressZero = constants.AddressZero;
class RpcError extends Error {
  constructor(msg, code, data) { super(msg); this.code = code; this.data = data; }
}
const ValidationErrors = {
  SimulateValidation: -32500, OpcodeValidation: -32502, InsufficientStake: -32505, InvalidFields: -32602, InvalidSignature: -32507
};
function requireCond(cond, msg, code, data) { if (!cond) throw new RpcError(msg, code, data); }
function mapOf(keys, mapper, filter) {
  const ret = {};
  for (const key of keys) if (filter == null || filter(key)) ret[key] = mapper(key);
  return ret;
}
function toBytes32(b) { return utils.hexZeroPad(utils.hexlify(b).toLowerCase(), 32); }
module.exports = { AddressZero, RpcError, ValidationErrors, requireCond, mapOf, toBytes32 };