import { toAccount } from 'viem/accounts';
import { hashMessage, hashTypedData, isHex } from 'viem';

// The owner's key lives on a Ledger in the user's browser; this server never sees it. A "remote owner"
// is a viem account that either COLLECTS what it is asked to sign (prepare) or REPLAYS signatures the
// Ledger produced for exactly those digests (finalize).
const PLACEHOLDER = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
export const isDigest = value => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
export const isSignature = value => typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value);

export class MissingSignature extends Error {}

export const jsonSafe = value => JSON.parse(JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item));
// bigint-preserving encoding for storing a prepared UserOperation.
export const encodeOperation = operation => JSON.stringify(operation, (_, item) => typeof item === 'bigint' ? { $bigint: item.toString() } : item);
export const decodeOperation = text => JSON.parse(text, (_, item) => item && typeof item === 'object' && '$bigint' in item ? BigInt(item.$bigint) : item);

export function remoteOwner(address, signatures) {
  const requests = new Map();
  const answer = request => {
    requests.set(request.id, request);
    if (!signatures) return PLACEHOLDER;
    const signature = signatures[request.id];
    if (!isSignature(signature)) throw new MissingSignature(request.id);
    return signature;
  };
  const account = toAccount({
    address,
    async signMessage({ message }) {
      const raw = typeof message === 'object' && message.raw !== undefined ? (isHex(message.raw) ? message.raw : null) : null;
      if (!raw) throw new Error('Only raw operation hashes are signed through this owner.');
      return answer({ id: hashMessage(message), kind: 'message', raw });
    },
    async signTypedData(typedData) {
      return answer({ id: hashTypedData(typedData), kind: 'typedData', typedData: jsonSafe(typedData) });
    },
    async signTransaction() { throw new Error('Owner transactions are never signed through this owner.'); },
  });
  return { account, requests: () => [...requests.values()] };
}
