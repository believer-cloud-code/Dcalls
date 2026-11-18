# Trusted device authorization architecture

## Status

Implementation branch: `feature/trusted-device-authorization`

This is a staged implementation. Nothing in this branch is deployed, and no production credentials or Cloudflare resources have been created. The branch now contains the D1 schema, Worker verification and device data-plane routes, client integration behind `VITE_TRUSTED_DEVICE_AUTH_ENABLED`, and D1-backed QR rendezvous. Nothing is deployed. Firestore legacy compatibility writes remain, rules lockdown is pending, and real two-device runtime verification has not yet been performed.

## Objective

Keep Firebase Authentication and Firestore as Dcalls' account and application-data platform while moving the device-security control plane behind a trusted Cloudflare Worker.

A Firebase ID token establishes the account UID. It does **not** establish which installation made a request. For device-sensitive operations, the Worker must additionally verify a signature made by the Matrix `OlmMachine` device key registered to that exact UID/device ID.

## Trust model

1. **Account authentication:** validate the Firebase ID token and derive the UID server-side. Never accept a caller-supplied UID as authority.
2. **Device proof:** the client signs a canonical, domain-separated request containing the action, device ID, request ID, timestamp and payload digest with `OlmMachine.sign()`. The Worker verifies the Ed25519 signature against the public key registered for that device.
3. **Device enrollment:** the first device establishes the account's Matrix cross-signing public identity (trust on first use, bound to the authenticated Firebase UID). Later devices must present a device-key signature verifiable against the self-signing key certified by the unchanged master key. A Firebase login alone cannot replace an existing device credential. The first-device bootstrap remains vulnerable if an attacker controls the account before the owner establishes the first identity; protect the Firebase account and verify the initial device.
4. **Replay protection:** each signed request has a unique request ID and a monotonically increasing device counter. The Worker consumes the request atomically with the protected operation.
5. **Revocation:** revocation is authoritative in the trusted service. Every protected operation checks the credential's active state. A revoked device cannot re-enrol under the same device ID.
6. **Data minimization:** D1 stores public keys, public prekeys, encrypted device-control payloads, request metadata and revocation state only. It must never store Matrix private keys, cross-signing seeds, HPKE private state, plaintext messages or decrypted attachments.

## Why Cloudflare D1

D1 can hold the device registry, replay records, prekeys and encrypted device inbox without granting a Worker a project-wide Firebase Admin credential. The Worker can continue to use the caller's Firebase ID token for authorized reads of ordinary Firestore chat membership. This avoids introducing a Firebase service-account private key into Cloudflare.

The Free tier currently includes 5 GB total storage, 5 million rows read per day and 100,000 rows written per day. Cloudflare enforces the daily limits; reaching them can make D1 queries fail until the limit resets. The design must handle temporary unavailability safely and must never fall back to insecure direct Firestore writes.

## Migration boundary

The device control plane must move together:

- device credential enrollment and revocation;
- public device keys, one-time keys and fallback keys;
- cross-signing public identity and signatures;
- encrypted device inbox send, list and acknowledgement;
- QR device-link sessions, handshake messages and encrypted secret-transfer messages.

The existing Firestore device collections become legacy/read-only only after all supported clients use the Worker-backed path and the remaining compatibility reads/writes have been removed. Firestore rules must then deny direct client writes to legacy device and QR rendezvous paths. Do not lock those paths while the app still dual-writes public keys/cross-signing records or while older clients need the Firestore fallback.

Ordinary chat messages and WebRTC signalling are not silently migrated by this project. They remain Firebase-account-authorized until a separately designed per-device message gateway is implemented. This is an explicit limitation, not device attestation.

## Current implementation

- `POST /device/enroll` authenticates a Firebase ID token, derives the stable Matrix user ID from the Firebase UID, verifies the master-key self-signature, verifies the self-signing and user-signing keys against the master key, and verifies the device key against the self-signing key. It rejects a changed master key and refuses to reactivate a revoked device ID.
- `POST /device/keys/publish` requires a signed `device.keys.publish` request and validates each one-time/fallback key signature against the enrolled device key before storing the public key material in D1.
- `POST /device/keys/query` returns active public device and cross-signing keys only for accounts that share the requested chat with the caller.
- `POST /device/keys/counts` reports unclaimed one-time keys and unused fallback-key algorithms from D1, so the Matrix crypto machine does not rely on stale Firestore claim counts.
- `POST /device/keys/claim` atomically claims a one-time key, or a still-unused fallback key, after verifying the signed caller device and both chat participants.
- `POST /device/inbox/send`, `/device/inbox/list` and `/device/inbox/ack` route encrypted to-device events through D1. Send retries are accepted only when the event ID and all immutable fields match exactly; inbox reads and acknowledgements are bound to the signed recipient device.
- `POST /device/list` lists the caller's own D1 device credentials.
- `POST /device/revoke` requires a signed `device.revoke` request from an active registered device, checks timestamp and monotonic counter, consumes the request ID, and marks the target credential revoked in D1.
- The device-management UI can use the Worker device-list and revocation routes when `VITE_TRUSTED_DEVICE_AUTH_ENABLED=true`; revocation also updates the legacy Firestore record during migration.
- Matrix key publication, device key queries, prekey claims, encrypted inbox sends/reads/acknowledgements use D1 when the feature flag is enabled. Device and cross-signing public records are still dual-written to Firestore for the legacy QR/device-link flow.
- QR device-link session creation, joining, approval, final handshake, cancellation, encrypted secret transfer and receipt acknowledgement now have D1-backed Worker routes when trusted mode is enabled. Source-device state changes require a signed request; the not-yet-enrolled joining device is bound to the same Firebase account and the session's joined device ID, then must complete the HPKE handshake and source-device approval. The new device cannot sign with a registered Matrix key until it has received and imported the account secrets.
- Fresh devices may publish their initial Matrix device keys before they have the account cross-signing secrets. D1 enrollment is intentionally deferred until the QR transfer is imported and the self-signing key has certified the new device. At that point the client migrates its still-unclaimed Firestore prekeys and unused fallback keys into D1.
- Cross-signing and public device records remain dual-written to Firestore for legacy compatibility and bootstrap. The old Firestore QR routes remain as the feature-flag-off path.
- The feature flag defaults to `false` and must remain off until D1 is provisioned, the Worker is deployed, every participating account/device is enrolled, and the test rollout confirms that all active clients support D1-only key lookup/inbox operations. Old clients are not compatible with D1-only key lookup/inbox operations.
- Firestore rules must not be locked down for the old device collections until QR pairing and any remaining legacy reads/writes have migrated. Do not describe the whole device system as Worker-enforced before that final rules change.

## Local setup (not deployment)

1. From the `cloudflare/` directory, create a D1 database in your Cloudflare account: `npx wrangler d1 create dcalls-device-auth`.
2. Copy the returned database ID into the commented `[[d1_databases]]` binding in `wrangler.toml`, using binding name `DEVICE_DB`.
3. Apply the migration locally: `npx wrangler d1 migrations apply dcalls-device-auth --local`. Use `--remote` only after reviewing the target account/database.
4. Configure `FIREBASE_WEB_API_KEY` as a Worker secret; do not put it in source control. Set `VITE_TRUSTED_DEVICE_AUTH_ENABLED=true` only in a test app build after the Worker is running.
5. Run `npx wrangler dev` and test enrollment, key publication/query/claim, encrypted inbox delivery, QR join/approval/final verification, secret transfer, device listing and revocation with two dedicated test devices before enabling the Vite feature flag.
6. Only after deployment and a successful test should the flag be enabled in the app build environment.

These steps are documentation only; no D1 database has been created and no deployment has been run.

## Rollout phases

1. **Schema and protocol:** implemented; D1 migration and canonical signed-request format are in the branch.
2. **Worker verification:** implemented; Firebase account tokens, Matrix Ed25519 signatures, cross-signing enrollment, expiry and replay checks are in place.
3. **Worker data plane:** implemented in code for keys, prekeys, inbox, QR rendezvous, device listing and revocation.
4. **Client migration:** integrated behind the default-off feature flag. Legacy Firestore compatibility writes remain during rollout.
5. **Rules lockdown:** pending. Remove compatibility writes/reads first, then deny direct client writes and add emulator tests proving bypass attempts fail.
6. **Verification:** CI has passed on intermediate implementation commits; the latest commit still needs its full CI run. Real two-device tests remain outstanding.
7. **Deployment gate:** the user creates the D1 database and binding, configures the Worker, and explicitly approves deployment. Do not deploy automatically.

## Security limits

- This proves possession of a registered software-held Matrix device key, not hardware-backed attestation. Malware or same-origin script execution on an unlocked device may still invoke the signing API.
- Firebase account compromise can still authorize account-level operations not migrated to the trusted service.
- A device that already received plaintext or room keys cannot be remotely made to forget them.
- D1 Free limits are operational limits, not a security guarantee. If exhausted, protected operations must fail closed.
- The Worker is a security boundary. Its signature verification, canonicalization, replay handling and D1 transaction semantics require tests before any production rollout.
