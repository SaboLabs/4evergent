# Agent Capabilities

A capability is a named, policy-governed action an agent may perform on Stellar.

## Built-in capabilities (Phase 1)

| Capability | Intent type | Status |
|------------|-------------|--------|
| `payment` | `PaymentIntent` | ✅ MVP — validation + policy |
| `trustline` | `TrustlineIntent` | ✅ MVP — validation + policy |
| `contract_call` | `ContractCallIntent` | ✅ validation; policy denies by default |
| `account_settings` | `AccountSettingsIntent` | ✅ validation; policy denies by default |

## Adding a new capability

See the "Adding a new agent capability" section of [README.md](../README.md).
