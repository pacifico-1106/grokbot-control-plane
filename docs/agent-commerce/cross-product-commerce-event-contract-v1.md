# Cross-product commerce event contract v1

- Status: Accepted schema / reference-only runtime implemented, disabled by default
- Version: `sealith.cross-product-commerce-events.v1`
- ADR: [`ADR 0008`](../agent-payments/0008-optional-external-authority-and-commerce-ledger-boundary.md)
- JSON Schema: [`cross-product-commerce-events.v1.schema.json`](./contracts/cross-product-commerce-events.v1.schema.json)
- Initial producers: StaffPass as optional authority provider; Sealith as commerce ledger

## Purpose

This contract joins an AI employee authority trail to a Sealith commerce trail without making StaffPass mandatory and without creating two owners for the same fact.

Normative terms `MUST`, `MUST NOT`, `SHOULD` and `MAY` are used as requirements.

## Integration modes

### Sealith native

`authorityMode = sealith_native`

- No external-authority event is required.
- Existing Agent Token, Action Manifest and Sealith Human Approval behavior is unchanged.
- `approvalRef` MAY identify a Sealith approval when one is required.

### External reference

`authorityMode = external_reference`

- An external decision MAY be correlated for audit and UI.
- The decision MUST NOT bypass Sealith policy, Action Manifest or Human Approval.
- This is the first StaffPass staging mode.

### External trusted

`authorityMode = external_trusted`

- Disabled by default and not implemented by this document.
- It requires an explicit organization/provider trust binding and the ADR 0008 Phase 2 gates.
- Even when trusted, the decision cannot enable a disabled commerce rail or override Sealith transaction validation.

## Common envelope

```json
{
  "specVersion": "sealith.cross-product-commerce-events.v1",
  "eventId": "evt_01J6K9V6ZH9Z7Q2Y6WS5E8J6H4",
  "eventType": "authority.decision.recorded.v1",
  "occurredAt": "2026-08-27T05:10:00.000Z",
  "expiresAt": "2026-08-27T05:15:00.000Z",
  "producer": {
    "system": "staffpass",
    "kind": "authorization_authority",
    "environment": "staging",
    "tenantId": "org_staffpass_307"
  },
  "correlation": {
    "jobId": "job_esim_20260827_001",
    "approvalRef": {
      "system": "staffpass",
      "id": "apr_01J6K9RZV26AF",
      "version": 1
    }
  },
  "aggregate": {
    "type": "authority_decision",
    "id": "apr_01J6K9RZV26AF",
    "version": 1
  },
  "data": {}
}
```

### Required correlation rules

- `jobId` MUST be stable across the originating AI work item and the Sealith order.
- An approval MUST use `approvalRef.system` and `approvalRef.id`; raw `approvalId` alone is not globally unique.
- `orderId` MUST be the Sealith order ID and is absent until Sealith creates an order.
- A producer MUST NOT reuse an `eventId` for different bytes or a different event.
- IDs MUST be opaque identifiers. Consumers MUST NOT infer ownership or permissions from an ID prefix.

## Event types

### `authority.decision.recorded.v1`

Canonical producer: an allowlisted `authorization_authority`, initially StaffPass.

The event records an authority decision. It does not claim that an order, payment or fulfillment occurred.

Required data:

- `authorityMode`: `external_reference` or `external_trusted`;
- `decision`: `approved | denied | expired | revoked`;
- `actor`: authority organization, employee, credential and credential generation;
- `authorization`: purpose, currency, maximum amount, merchant policy, approval requirement and expiry;
- `decisionId` and `decisionVersion`.

For an approved purchase, `authorization` SHOULD bind `skuPolicy` or `quoteHash`. `external_trusted` MUST bind one of them before it can satisfy a Sealith approval gate.

Example:

```json
{
  "authorityMode": "external_reference",
  "decisionId": "apr_01J6K9RZV26AF",
  "decisionVersion": 1,
  "decision": "approved",
  "actor": {
    "organizationId": "org_307",
    "employeeId": "emp_procurement",
    "credentialId": "cred_9f2",
    "credentialGeneration": 3
  },
  "authorization": {
    "purpose": "business_trip_esim",
    "currency": "JPYC",
    "maxAmount": "3000",
    "merchantPolicy": {
      "allowedMerchantIds": ["merchant_tokyo307"],
      "requiredSellerOfRecord": "tokyo307"
    },
    "skuPolicy": {
      "allowedSkuIds": ["esim_jp_10gb_30d"]
    },
    "approvalRequired": true,
    "approvedByReference": "member_7c1",
    "validUntil": "2026-08-27T05:15:00.000Z"
  }
}
```

### `commerce.order.linked.v1`

Canonical producer: Sealith with `producer.kind = commerce_ledger`.

The event links `jobId` and an optional external approval to the Sealith order. It is not payment evidence.

Required data:

- `orderId`, `orderStatus`, `authorityMode`;
- `merchantId`, `sellerOfRecord`, `skuId`;
- `currency`, `amount`;
- optional `approvalValidation`: `not_present | reference_only | accepted | rejected` and reason code.

### `commerce.payment.status_changed.v1`

Canonical producer: Sealith.

The event is a projection of Sealith's canonical payment state. For `confirmed`, it MUST include `paymentEventId` and the complete transfer-event identity: `chainId`, `tokenContract`, `transactionHash`, and `logIndex`.

Allowed status:

- `pending`
- `observed`
- `confirmed`
- `failed`
- `expired`
- `refunded`

A consumer MUST NOT promote a payment to `confirmed` from a browser return, user report, transaction hash alone, or an event produced by a non-Sealith system.

### `commerce.fulfillment.status_changed.v1`

Canonical producer: Sealith.

Allowed status:

- `pending`
- `holding`
- `fulfilling`
- `completed`
- `failed`
- `released`

The event MAY contain a non-secret `providerReference`. It MUST NOT contain fulfillment ciphertext, access secrets, eSIM activation material or Provider credentials.

### `commerce.reversal.status_changed.v1`

Canonical producer: Sealith.

Allowed status:

- `not_requested`
- `pending_manual_review`
- `requested`
- `processing`
- `completed`
- `failed`

Reversal and refund are not inferred from a failed fulfillment. They require the Sealith canonical reversal/refund record.

## Consumer projection rule

When StaffPass displays Sealith commerce state, it SHOULD store only:

```json
{
  "reportedStatus": "confirmed",
  "sourceSystem": "sealith",
  "sourceEventId": "evt_01J6...",
  "sourceAggregateVersion": 4,
  "observedAt": "2026-08-27T05:13:09.000Z",
  "orderId": "ord_01J6...",
  "paymentEventId": "pay_01J6..."
}
```

This is a read projection, not permission for StaffPass to mutate Sealith commerce state. If delivery becomes stale, the UI reports stale or unknown and reads the Sealith status endpoint; it does not infer a newer state.

Sealith stores only the minimum authority snapshot needed to prove its decision:

- authority provider and tenant mapping;
- employee/credential references and credential generation;
- decision and approval reference;
- bound purpose, job, merchant, seller-of-record, SKU/quote, currency, amount and expiry;
- source event ID, aggregate version and validation result;
- canonicalized payload hash.

Sealith does not copy the employee's full StaffPass profile, unrelated scopes or complete StaffPass audit history.

## Delivery and authentication

Runtime delivery is not enabled by accepting this contract. When implemented:

1. Use HTTPS `POST` with the raw JSON body.
2. Send:
   - `X-Sealith-Event-Id: <eventId>`
   - `X-Sealith-Event-Timestamp: <unix-seconds>`
   - `X-Sealith-Event-Signature: v1=<lowercase-hex-hmac-sha256>`
3. Calculate the signature over `<timestamp>.<raw-body>`.
4. Verify the signature before JSON parsing and before any database write.
5. Use separate staging and production secrets, support an explicit rotation overlap, and never place a secret in the event.
6. Reject timestamps outside a five-minute replay window, expired events, unknown tenant mappings and reused event IDs with different body hashes.

Delivery is at least once. A `2xx` response means the receiver durably recorded the delivery attempt. It does not mean an authority decision was accepted or that a commercial state transition occurred.

Suggested response:

```json
{
  "received": true,
  "eventId": "evt_01J6K9V6ZH9Z7Q2Y6WS5E8J6H4",
  "duplicate": false,
  "businessDisposition": "reference_recorded"
}
```

## Ordering and corrections

- `aggregate.version` MUST increase by one for each producer-side aggregate change.
- Lower versions are stale and MUST NOT roll state backward.
- Equal version and equal body hash is an idempotent replay.
- Equal version and different body hash is a security conflict.
- Decisions are corrected with a newer `decisionVersion` and event, not destructive update of received evidence.
- A revoked external approval prevents unused future execution. It does not undo a payment or fulfillment that already occurred.

## Failure behavior

- Native Sealith flows do not call StaffPass and are unaffected by StaffPass downtime.
- `external_reference` may continue under existing Sealith gates if the reference delivery is delayed, but UI must show its synchronization state honestly.
- `external_trusted` fails closed when signature, expiry, tenant mapping, version, exact binding or authority availability cannot be confirmed.
- The system MUST NOT silently switch an `external_trusted` action to `sealith_native` or auto-approval.
- A user may explicitly start a new native request with a new approval and evidence chain.

## Forbidden data

Events MUST NOT include:

- raw StaffPass or Sealith credential secrets;
- wallet private keys, seed phrases, Safe signer material or Ledger PINs;
- JPYC EX cookies, credentials, bank details or KYC data;
- card PAN/CVC;
- encrypted fulfillment payloads, activation codes or access credentials;
- unrelated customer records or full audit-history dumps.

## Acceptance tests before runtime enablement

- Schema validation for every event type and unknown-field rejection.
- StaffPass-absent native order regression.
- Valid signed external reference and invalid signature.
- Wrong organization, environment, employee credential generation and tenant mapping.
- Duplicate delivery, same-ID/different-body conflict and out-of-order aggregate versions.
- Expired decision, revoked decision and credential rotation.
- Merchant, seller-of-record, SKU, quote, currency and amount drift.
- StaffPass outage in all three authority modes.
- Payment events from a non-Sealith producer rejected.
- No secret-bearing fields in persistence, logs or error responses.
- No production commerce or fulfillment flag changes during no-money staging.
