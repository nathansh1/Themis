export type Ruleset = {
  account: `0x${string}`;
  chainId: 11155111;
  window: {
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
  maxPerAction: string;
  maxActions: number;
};

export type Intent = {
  action: "repay";
  asset: "USDC";
  amount: string;
  reason: string;
};

export type IntentResult =
  | {
      status: "executed";
      txHash: `0x${string}`;
    }
  | {
      status: "rejected";
      failed: string[];
    };