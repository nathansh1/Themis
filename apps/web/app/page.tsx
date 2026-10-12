import ActivityLog from "./activity-log";
import HealthFactor from "./health-factor";
import LedgerConnect from "./ledger-connect";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-8 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">Themis</h1>
      <LedgerConnect />
      <HealthFactor />
      <ActivityLog />
    </main>
  );
}
