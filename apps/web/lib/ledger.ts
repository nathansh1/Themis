import type {
  DeviceActionState,
  DeviceManagementKit,
  DeviceSessionId,
} from "@ledgerhq/device-management-kit";
import type { SignerEth } from "@ledgerhq/device-signer-kit-ethereum";
import type { Observable } from "rxjs";

export const LEDGER_DERIVATION_PATH = "44'/60'/0'/0/0";

export type LedgerSession = {
  dmk: DeviceManagementKit;
  sessionId: DeviceSessionId;
  signer: SignerEth;
};

export type LedgerSignature = { r: `0x${string}`; s: `0x${string}`; v: number };

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
  const sessionId = await dmk.connect({ device });
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

async function run<Output, Err, Intermediate extends { requiredUserInteraction: string }>(
  action: {
    observable: Observable<DeviceActionState<Output, Err, Intermediate>>;
    cancel(): void;
  },
  onInteraction?: (interaction: string) => void,
): Promise<Output> {
  const [{ DeviceActionStatus }, , , { firstValueFrom, filter, tap }] = await preloadLedger();
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
  if (final.status === DeviceActionStatus.Error) {
    throw new Error(`Ledger error: ${JSON.stringify(final.error)}`);
  }
  throw new Error("Ledger action was stopped");
}

export async function getLedgerAddress(
  onInteraction?: (interaction: string) => void,
): Promise<`0x${string}`> {
  const { signer } = await connectLedger();
  const out = await run(signer.getAddress(LEDGER_DERIVATION_PATH), onInteraction);
  return out.address as `0x${string}`;
}

export async function signLedgerMessage(
  message: string,
  onInteraction?: (interaction: string) => void,
): Promise<LedgerSignature> {
  const { signer } = await connectLedger();
  return run(signer.signMessage(LEDGER_DERIVATION_PATH, message), onInteraction);
}
