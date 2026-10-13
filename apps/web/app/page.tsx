import Image from "next/image";
import ActivityLog from "./activity-log";
import Chat from "./chat";
import HealthFactor from "./health-factor";
import LedgerConnect from "./ledger-connect";
import Plate from "./plate";
import RulesetReview from "./ruleset-review";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-6 py-12 sm:px-10 sm:py-16">
      <header className="flex flex-col gap-4">
        <h1>
          <Image
            src="/themis-logo.webp"
            alt="Themis"
            width={2000}
            height={667}
            priority
            className="logo -ml-3 h-auto w-full max-w-md"
          />
        </h1>
        <p className="font-display max-w-xl text-sm uppercase leading-relaxed tracking-[0.2em] text-foreground/70">
          Hard limits for the agent that guards your position
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-5">
        <Plate numeral="I" title="Position" className="lg:col-span-3">
          <HealthFactor />
        </Plate>
        <Plate numeral="II" title="Custody" className="lg:col-span-2">
          <LedgerConnect />
        </Plate>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Plate numeral="III" title="Counsel">
          <Chat />
        </Plate>
        <Plate numeral="IV" title="Ruleset">
          <RulesetReview />
        </Plate>
      </div>

      <Plate numeral="V" title="Docket">
        <ActivityLog />
      </Plate>
    </main>
  );
}
