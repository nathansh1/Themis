# Themis

<p align="center">
  <img src="assets/themis-banner.png" alt="Themis banner" width="100%" />
</p>

# Themis

Themis is a hardware-authorized autonomy layer for AI agents. It allows a user to use their Ledger only once to define boundaries and parameter mandates for an agent, such as what protocols it can use, how much capital it can control, how long the authority lasts, after which the agent can operate autonomously within those limits.

## How It Works

Themis is an AI agent execution framework that enables autonomous onchain actions while keeping ultimate authority secured by a Ledger hardware wallet.

Rather than requiring human approval for every transaction or granting an AI agent unrestricted access to private keys, Themis introduces time-bound, permissioned autonomy.

Execution Workflow

Human Authorization: A user connects their Ledger hardware wallet and signs an initial authorization defining the agent's permissions, spending limits, and session duration.

Temporary Session Creation: Using ZeroDev's session-key infrastructure, Themis establishes a delegated signing session with predefined restrictions. The agent never receives the user's Ledger private key.

Autonomous Agent Execution: A Hermes AI agent interprets user objectives, evaluates onchain opportunities, and initiates transactions independently within the authorized limits.

Permission Enforcement: Every transaction must satisfy the session's defined constraints. Unauthorized actions cannot be executed through the delegated signer.

Automatic Expiration: When the authorized session expires, the agent loses its delegated transaction-signing capability. Further execution requires a new authorization from the user.

Core Architecture

Ledger Hardware Wallet → User Authorization → ZeroDev Session Key → Hermes AI Agent → Onchain Execution → Session Expiration

Why Themis?

Traditional AI agents either require repeated human approval or operate with excessive wallet permissions. Themis bridges this gap by combining the security of hardware-backed authorization with the flexibility of autonomous AI execution.

The human defines the boundaries. The agent operates within them. Themis enforces the limits.

Implementation note: This describes the intended architecture. Ledger-backed session authorization, ZeroDev permission enforcement, and expiration behavior must be verified against the actual integration before being presented as fully implemented.

<p align="center">
  <img src="assets/themis-goddess.png" alt="Themis goddess" width="500" />
</p>

## Branding

<p align="center">
  <img src="assets/themis-logo.png" alt="Themis logo" width="350" />
</p>

<p align="center">
  <img src="assets/themis-wordmark.png" alt="Themis wordmark" width="650" />
</p>
