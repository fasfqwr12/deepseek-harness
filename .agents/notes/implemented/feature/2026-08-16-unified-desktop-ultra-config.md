# Agent Note: Unified desktop configuration and Ultra reasoning

Status: implemented

## Problem

The desktop profile had duplicate settings mirrors and the pi-ai adapter could not describe a gateway-specific Ultra reasoning level.

## Decision

The desktop web profile reads one UTF-8 YAML settings document and one credentials document while session history remains in the existing DSH home. The Harness pi-ai adapter accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `ultra`; Ultra is stored in the adapter-owned thinking map and sent using its declared wire spelling without changing the third-party pi-ai package. The VS Code-style layout consumes the existing session, notification, memory, model, and retry services.

## Alternatives considered

**Keep JSON and YAML mirrors:** rejected because two writable settings documents drift and the protected legacy copies can be unreadable to the runtime.

**Patch the pi-ai dependency:** rejected because the adapter can preserve the upstream runtime contract and keep the local extension isolated.

## Consequences

Capability metadata is used only for the Automatic default hint. Manual Off/Minimal/Low/Medium/High/XHigh/Max/Ultra choices remain enabled and are sent to the upstream; the upstream response or error is authoritative. Retry is configured through the shared model-menu override (`off` or 0–20 retries, 100–60000 ms initial delay) and reflected in the status chip. Local Node 24 Mock/CDP acceptance covered 127 focused tests, the nine visible menu choices, preserved sessions/settings/credentials, and the runtime bundle.

The desktop launcher can run the TypeScript web entry directly, so routine development does not require a production bundle. Retired settings and credential copies remain in a timestamped backup directory for rollback, while the active runtime has one source of truth.
