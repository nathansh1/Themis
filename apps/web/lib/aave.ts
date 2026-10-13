import "server-only";
import { createPublicClient, formatUnits, http, isAddress, maxUint256, parseAbi } from "viem";
import { sepolia } from "viem/chains";

const AAVE_POOL = "0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951";

const poolAbi = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase,uint256 totalDebtBase,uint256 availableBorrowsBase,uint256 currentLiquidationThreshold,uint256 ltv,uint256 healthFactor)",
]);

export type HealthSnapshot = {
  account: `0x${string}`;
  healthFactor: number | null;
  collateralUsd: string;
  debtUsd: string;
  updatedAt: number;
};

export async function readHealth(): Promise<HealthSnapshot> {
  const account = process.env.KERNEL_ACCOUNT_ADDRESS || process.env.KERNEL_ADDRESS;
  const rpc = process.env.SEPOLIA_RPC_URL;
  if (!account || !isAddress(account)) throw new Error("KERNEL_ACCOUNT_ADDRESS (or KERNEL_ADDRESS) is missing or invalid in .env");
  if (!rpc) throw new Error("SEPOLIA_RPC_URL is missing in .env");

  const client = createPublicClient({ chain: sepolia, transport: http(rpc, { retryCount: 1, timeout: 10_000 }) });
  const [collateral, debt, , , , healthFactor] = await client.readContract({
    address: AAVE_POOL,
    abi: poolAbi,
    functionName: "getUserAccountData",
    args: [account],
  });

  return {
    account,
    // Aave reports max uint256 when there is no debt; null means "no debt".
    healthFactor: healthFactor === maxUint256 ? null : Number(formatUnits(healthFactor, 18)),
    collateralUsd: formatUnits(collateral, 8),
    debtUsd: formatUnits(debt, 8),
    updatedAt: Date.now(),
  };
}
