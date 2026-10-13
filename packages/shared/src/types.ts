export type Ruleset = {
  account: `0x${string}`;
  chainId: 11155111;
  window: {
    /** Unix seconds, UTC. End is exclusive in the HTTP service. */
    start: number;
    end: number;
  };
  trigger: {
    healthFactorBelow: number;
  };
  allow: {
    protocol: "aave-v3";
    action: "repay";
    asset: "USDC";
  }[];
  /** Human-readable USDC, e.g. "1.25"; at most six decimals. */
  maxPerAction: string;
  /** On-chain UserOperation count; the API submits one repayment per operation. */
  maxActions: number;
};

export type Intent = {
  action: "repay";
  asset: "USDC";
  amount: string;
  reason: string;
};

/** POST /intent requires an Idempotency-Key header, reused for retries. */
export type IntentResult =
  | {
      status: "executed";
      requestId: string;
      txHash: `0x${string}`;
    }
  | {
      status: "rejected";
      requestId?: string;
      failed: string[];
    }
  | {
      status: "pending";
      requestId: string;
      userOpHash: `0x${string}`;
    };

export type RulesetResult = {
  id: string;
  status: "awaiting_owner" | "active" | "expired";
  rules: Ruleset;
  permissionId?: `0x${string}`;
  policyPreview?: { type: string; address: `0x${string}` }[];
};

export type ActivityEntry = {
  id: string;
  intent: unknown;
  status: "checking" | "pending" | "executed" | "rejected";
  createdAt: string;
  updatedAt?: string;
  failed: string[];
  userOpHash?: `0x${string}`;
  txHash?: `0x${string}`;
};
