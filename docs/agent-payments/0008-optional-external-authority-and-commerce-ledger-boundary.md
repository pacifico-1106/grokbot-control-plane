# ADR 0008: External authority is optional and commerce facts remain Sealith-canonical

- Status: Accepted / reference-only runtime implemented but disabled by configuration
- Decision date: 2026-08-27 JST
- Owners: Sealith / StaffPass product owners
- Scope: AI employee authority, Human Approval, Agent Commerce, JPYC, fulfillment and audit correlation
- Event contract: [`cross-product-commerce-event-contract-v1.md`](../agent-commerce/cross-product-commerce-event-contract-v1.md)
- Machine-readable schema: [`cross-product-commerce-events.v1.schema.json`](../agent-commerce/contracts/cross-product-commerce-events.v1.schema.json)

## Context

StaffPass and Sealith both record activity around an AI-initiated purchase, but they answer different audit questions.

- StaffPass answers: who the AI employee is, which organization issued its credential, what purpose and authority it had, which budget and merchant constraints applied, and who approved or denied the action.
- Sealith answers: which commercial order was created, who the seller of record was, which quote and payment challenge applied, whether JPYC payment was confirmed, and how fulfillment, cancellation, reversal and refund progressed.

Some Sealith users will not use StaffPass. Other customers may later use another employee identity or policy authority. Requiring StaffPass would break the existing Agent Token and human-operated Sealith flows, while copying every authority and commerce fact into both products would create competing sources of truth.

## Decision

### 1. StaffPass is an optional authority provider

Sealith continues to work without StaffPass. The existing organization account, Agent Token, Action Manifest and Sealith Human Approval remain the default `sealith_native` authority path.

An external authority is represented by a provider-neutral reference. `staffpass` is the first intended provider value, not a required dependency or a special database assumption. A future approved authority can use a different stable `system` identifier through the same contract.

### 2. Each fact has exactly one canonical owner

| Fact | Canonical owner | Other product may retain |
| --- | --- | --- |
| AI employee identity and credential generation | StaffPass or the selected authority provider | immutable reference and display snapshot |
| allowed purpose, scope, employee budget and merchant policy | selected authority provider | validated decision snapshot/hash |
| authority approval or denial | selected authority provider | namespaced approval reference and validation result |
| Sealith Agent Token policy and Action Manifest | Sealith | no external override |
| order, quote and seller-of-record classification | Sealith | order reference and reported summary |
| JPYC payment status and payment-event identity | Sealith | source-labelled reported status |
| fulfillment, cancellation, reversal and refund | Sealith | source-labelled reported status |
| blockchain transaction receipt | public chain evidence; Sealith owns the application acceptance decision | transaction reference, never an independent paid decision |

If products disagree, authority facts are resolved from the selected authority provider and commerce facts are resolved from Sealith. An external product must not mark an order paid by independently interpreting a transaction hash. Sealith must not rewrite an external authority's approval decision.

### 3. Correlation is shared; records are not merged

The products correlate audit trails with:

- `jobId`: caller-stable work correlation ID, required before the order exists;
- `approvalRef.system` + `approvalRef.id`: namespaced approval reference when approval exists;
- `orderId`: Sealith-canonical order ID after order creation.

Raw `approvalId` is not assumed globally unique. It is always paired with its issuing `system`. Consumers may show a compact joined timeline, but each event retains `producer`, `eventId`, `occurredAt`, and its canonical source.

### 4. External authority has three explicit modes

| Mode | Meaning | Runtime effect |
| --- | --- | --- |
| `sealith_native` | No external authority is used | Existing Sealith policy and approval behavior remains unchanged |
| `external_reference` | External identity or approval is attached for correlation | Evidence only; it cannot bypass Sealith policy or Human Approval |
| `external_trusted` | A reviewed authority decision may satisfy a specifically configured approval requirement | Disabled until signing, tenant mapping, binding and replay gates pass |

Absence, timeout or failure of an optional external authority never silently changes an `external_trusted` request into native approval or auto-approval. The affected action fails closed or requires a new explicit native request. Ordinary `sealith_native` customers remain unaffected by external-authority availability.

### 5. One human decision may eventually satisfy both systems only by exact binding

The initial integration is `external_reference`. StaffPass approval is recorded and correlated, but Sealith continues to apply its own current gates.

Promotion to `external_trusted` requires a signed, unexpired decision that binds at least:

- authority organization and AI employee;
- credential ID and generation;
- `purpose` and `jobId`;
- merchant policy and seller-of-record constraint;
- SKU or immutable quote hash;
- currency and maximum amount;
- decision, decision version, approval reference and expiry;
- environment and one-time event identity.

Sealith still validates its Agent Token, Action Manifest, merchant classification, quote, chain, token, recipient, amount, payer policy and commerce feature flags. An authority approval cannot enable a disabled payment or fulfillment rail. Any material difference in merchant, seller of record, SKU, quote hash, currency, amount or expiry requires a new approval.

### 6. Cross-product state is a source-labelled projection

StaffPass may display `confirmed`, `fulfilled` or `refunded`, but only as a projection with:

- `sourceSystem = "sealith"`;
- `sourceEventId`;
- `sourceAggregateVersion`;
- `observedAt`;
- Sealith `orderId` and relevant event reference.

The projection is not a second commerce ledger. Missing or delayed delivery is shown as stale/unknown, not inferred from browser return, user report or an unverified transaction hash.

## Event ownership

The v1 contract defines these events:

- authority provider → Sealith:
  - `authority.decision.recorded.v1`
- Sealith → authority/audit consumer:
  - `commerce.order.linked.v1`
  - `commerce.payment.status_changed.v1`
  - `commerce.fulfillment.status_changed.v1`
  - `commerce.reversal.status_changed.v1`

Only an allowlisted producer with `kind = authorization_authority` may produce authority decisions. Only Sealith with `kind = commerce_ledger` may produce the defined commerce-state events.

## Security and delivery invariants

- HTTPS only; staging and production endpoints, tenant mappings and signing secrets are isolated.
- Raw request bodies are authenticated before JSON parsing using the contract signature profile.
- `(producer.system, producer.environment, eventId)` is the idempotency identity.
- `aggregateVersion` is monotonically increasing per aggregate. Older or equal versions are ignored as stale unless they are an exact idempotent replay.
- Timestamp replay window, event expiry and organization mapping fail closed.
- Cross-organization IDs, unknown producers, unknown event types and schema versions fail closed.
- Secrets, raw credentials, wallet keys, Ledger data, JPYC EX credentials, bank details, KYC data and fulfillment ciphertext are forbidden in events.
- Event delivery is at least once. A successful `2xx` acknowledges durable receipt, not business acceptance.
- Business rejection is stored as evidence and returned through a status/read model; the sender does not mutate the receiver's canonical fact.

## Non-goals

- Making StaffPass mandatory for Sealith commerce.
- Replacing Sealith Agent Tokens or Action Manifests with StaffPass credentials.
- Allowing StaffPass to determine JPYC payment finality or fulfillment completion.
- Allowing Sealith to issue or mutate StaffPass employee credentials.
- Implementing wallet custody, JPYC EX automation, Safe signing or Ledger operations.
- Enabling any production commerce, relay or fulfillment flag.

## Rollout

### Phase 0 — Contract only

- [x] Accept this ADR and v1 schema.
- [x] Implement signed reference-only ingress and source-labelled projection outbox.
- [x] Keep runtime integration disabled unless explicitly configured.
- [x] Mirror this ADR and the v1 contract into the StaffPass repository.

### Phase 1 — Reference-only staging

- StaffPass emits signed synthetic `authority.decision.recorded.v1` events.
- Sealith stores the external reference and validation evidence but does not bypass native approval.
- Sealith emits no-money order/status events back to StaffPass.
- Verify idempotency, replay, reordering, tenant isolation, corrections and unavailable endpoint behavior.

The implementation is guarded by `EXTERNAL_AUTHORITY_EVENTS_ENABLED=false` and
`CROSS_PRODUCT_COMMERCE_PROJECTIONS_ENABLED=false` by default. Enabling either
flag is a separate staging/production operation and does not enable a payment or
fulfillment rail.

### Phase 2 — Trusted authority candidate

- Add an explicit per-organization trust binding and allowlist.
- Bind the decision to the exact quote/action and validate signature rotation.
- Conduct threat-model, Legal/Ops and security review.
- Test quote drift, amount increase, merchant change, credential rotation, revoked approval and expired decision.

### Phase 3 — Limited pilot

- One organization, one StaffPass employee, one Agent Token, one SKU and Human Approval always.
- Low limit and working-hours monitoring.
- Any mismatch falls back to a new explicit approval; no automatic widening.

## Consequences

- Audit views can show a continuous employee-to-transaction timeline without creating a dual source of truth.
- Existing customers and integrations continue without StaffPass.
- StaffPass can be replaced or supplemented by another reviewed authority provider without changing commerce ownership.
- Correlation and projection add some duplicated display data, but canonical mutation remains single-owner and conflicts have a deterministic resolution rule.
