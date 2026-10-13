import type {
  DeviceActionState,
  DeviceManagementKit,
  DeviceSessionId,
} from "@ledgerhq/device-management-kit";
import type { SignerEth } from "@ledgerhq/device-signer-kit-ethereum";
import type { Observable } from "rxjs";
import { hashTypedData } from "viem";

export const LEDGER_DERIVATION_PATH = "44'/60'/0'/0/0";

export type LedgerSession = {
  dmk: DeviceManagementKit;
  sessionId: DeviceSessionId;
  signer: SignerEth;
};

export type LedgerSignature = { r: `0x${string}`; s: `0x${string}`; v: number };

// Ethereum signatures as the chain's validators expect them: r || s || v, with v of 27 or 28.
export function toHexSignature({ r, s, v }: LedgerSignature): `0x${string}` {
  const recovery = v < 27 ? v + 27 : v;
  return `0x${r.slice(2)}${s.slice(2)}${recovery.toString(16).padStart(2, "0")}`;
}

/** Typed data as Themis sends it (JSON): the Ledger kit wants a numeric chainId and an explicit EIP712Domain. */
export type WireTypedData = {
  domain: { name?: string; version?: string; chainId?: number | string; verifyingContract?: string; salt?: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
};

const DOMAIN_FIELDS: Record<string, string> = { name: "string", version: "string", chainId: "uint256", verifyingContract: "address", salt: "bytes32" };

let kitsPromise: ReturnType<typeof importKits> | null = null;
let session: LedgerSession | null = null;

function importKits() {
  return Promise.all([
    import("@ledgerhq/device-management-kit"),
    import("@ledgerhq/device-transport-kit-web-hid"),
    import("@ledgerhq/device-signer-kit-ethereum"),
    import("rxjs"),
  ]);
}

// Call on mount: WebHID's device picker needs a fresh click, so the chunks must already be loaded.
export function preloadLedger() {
  kitsPromise ??= importKits();
  return kitsPromise;
}

export async function connectLedger(): Promise<LedgerSession> {
  if (session) return session;
  const [dmkKit, webHid, signerKit, { firstValueFrom }] = await preloadLedger();

  const dmk = new dmkKit.DeviceManagementKitBuilder()
    .addTransport(webHid.webHidTransportFactory)
    .build();
  const device = await firstValueFrom(
    dmk.startDiscovering({ transport: webHid.webHidIdentifier }),
  );
  await dmk.stopDiscovering();
  // The refresher polls the device in the background; during a long blind-signing prompt (the Kernel
  // permission is sent as many APDU chunks) that poll collides with the signing command and the
  // transport fails with AlreadySendingApduError. Every action here is explicit, so turn it off.
  const sessionId = await dmk.connect({ device, sessionRefresherOptions: { isRefresherDisabled: true } });
  const signer = new signerKit.SignerEthBuilder({ dmk, sessionId }).build();

  session = { dmk, sessionId, signer };
  return session;
}

export async function disconnectLedger() {
  if (!session) return;
  const { dmk, sessionId } = session;
  session = null;
  await dmk.disconnect({ sessionId });
}

type LedgerAction<Output, Err, Intermediate> = {
  observable: Observable<DeviceActionState<Output, Err, Intermediate>>;
  cancel(): void;
};

// One device action at a time: the transport can carry only one APDU exchange.
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

const BUSY = "AlreadySendingApduError";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Start a device action (from a factory, so it can be retried) and wait for its final state. */
function run<Output, Err, Intermediate extends { requiredUserInteraction: string }>(
  start: () => LedgerAction<Output, Err, Intermediate>,
  onInteraction?: (interaction: string) => void,
): Promise<Output> {
  return exclusive(async () => {
    const [{ DeviceActionStatus }, , , { firstValueFrom, filter, tap }] = await preloadLedger();
    for (let attempt = 1; ; attempt++) {
      const action = start();
      const final = await firstValueFrom(
        action.observable.pipe(
          tap((state) => {
            if (state.status === DeviceActionStatus.Pending) {
              onInteraction?.(state.intermediateValue.requiredUserInteraction);
            }
          }),
          filter(
            (state) =>
              state.status === DeviceActionStatus.Completed ||
              state.status === DeviceActionStatus.Error ||
              state.status === DeviceActionStatus.Stopped,
          ),
        ),
      );
      if (final.status === DeviceActionStatus.Completed) return final.output;
      action.cancel(); // never leave a half-finished exchange holding the transport
      if (final.status === DeviceActionStatus.Error) {
        const tag = (final.error as { _tag?: string } | undefined)?._tag;
        // A stray exchange from before (e.g. a prompt the user dismissed) can still be draining; it clears quickly.
        if (tag === BUSY && attempt < 3) { await sleep(750 * attempt); continue; }
        if (tag === BUSY) throw new Error("The Ledger is still busy with an earlier request. Unplug it, plug it back in, reload the page and try again.");
        throw new Error(`Ledger error: ${JSON.stringify(final.error)}`);
      }
      throw new Error("Ledger action was stopped");
    }
  });
}

export async function getLedgerAddress(
  onInteraction?: (interaction: string) => void,
): Promise<`0x${string}`> {
  const { signer } = await connectLedger();
  const out = await run(() => signer.getAddress(LEDGER_DERIVATION_PATH), onInteraction);
  return out.address as `0x${string}`;
}

export async function signLedgerMessage(
  message: string,
  onInteraction?: (interaction: string) => void,
): Promise<LedgerSignature> {
  const { signer } = await connectLedger();
  return run(() => signer.signMessage(LEDGER_DERIVATION_PATH, message), onInteraction);
}

/** Personal-sign over raw bytes (e.g. a 32-byte UserOperation hash): the device signs the EIP-191 digest of those bytes. */
export async function signLedgerRaw(
  hex: `0x${string}`,
  onInteraction?: (interaction: string) => void,
): Promise<LedgerSignature> {
  const { signer } = await connectLedger();
  const bytes = Uint8Array.from(hex.slice(2).match(/../g) ?? [], (byte) => parseInt(byte, 16));
  return run(() => signer.signMessage(LEDGER_DERIVATION_PATH, bytes), onInteraction);
}

/** The typed data exactly as the device receives it: numeric chainId and an explicit, canonically ordered EIP712Domain. */
function toLedgerTypedData(wire: WireTypedData) {
  const { chainId, ...rest } = wire.domain;
  const domain = { ...rest, ...(chainId === undefined ? {} : { chainId: Number(chainId) }) };
  const types = {
    // Canonical EIP-712 field order; any other order hashes to a different domain separator.
    EIP712Domain: Object.keys(DOMAIN_FIELDS)
      .filter((name) => (domain as Record<string, unknown>)[name] !== undefined)
      .map((name) => ({ name, type: DOMAIN_FIELDS[name] })),
    ...wire.types,
  };
  return { domain, types, primaryType: wire.primaryType, message: wire.message };
}

/**
 * The EIP-712 digest of the typed data, recomputed here from its contents. The Ledger signs this digest as a
 * personal message: the Ethereum app's typed-data parser rejects the Kernel permission (status 0x6980; one
 * field is ~1.3 KB), and the Kernel's ECDSA validator accepts a personal signature over the digest.
 */
export function typedDataDigest(wire: WireTypedData): `0x${string}` {
  // Runtime typed data: viem's compile-time schema inference cannot follow it, hence the cast.
  return hashTypedData(toLedgerTypedData(wire) as unknown as Parameters<typeof hashTypedData>[0]);
}
