# Dcalls Secure Device Linking

## Protocol and dependency

Dcalls pins `@matrix-org/matrix-sdk-crypto-wasm@19.0.1`. Version 19.0.0 introduced the SDK's HPKE bindings for Matrix QR login (MSC4388); 18.9.2 does not expose those HPKE channel classes. Keep this dependency pinned and review Matrix SDK changelogs before upgrades.

Use the SDK primitives only:

- `HpkeRecipientChannel` on the existing device displaying the QR code.
- `HpkeSenderChannel` on the new device scanning it.
- `UnidirectionalRecipientChannel` and `UnidirectionalSenderChannel` to complete the initial exchange.
- `EstablishedHpkeChannel.checkCode` to compare the channel check code out-of-band.
- `seal` and `open` for authenticated encrypted rendezvous messages.
- `QrCodeData.newMsc4388` for the QR data envelope where its required homeserver/rendezvous semantics are supported. Dcalls' Firebase transport is custom; do not claim full Matrix MSC4388 interoperability unless its rendezvous protocol is implemented.

The SDK release source exposes these methods. Do not replace them with homemade key agreement, encryption, or verification code calculations.

## Cross-signing prerequisite

Before account secrets or history keys can be transferred, bootstrap the Matrix SDK cross-signing identity. Dcalls now has a transport adapter that:

1. Calls `OlmMachine.bootstrapCrossSigning(false)` (never resets an existing identity).
2. Publishes the master, self-signing and user-signing public keys and the SDK-produced signatures to Firestore.
3. Returns the three public key sets through the Matrix `/keys/query`-shaped response.
4. Refuses to overwrite a different already-registered cross-signing identity.

The SDK's `exportSecretsBundle()` only succeeds when all three private cross-signing keys are available. The bundle must be transferred only to a trusted recipient over the established HPKE channel.

## Firestore rendezvous design

Dcalls has no Matrix homeserver. Pairing therefore uses a Dcalls-specific Firestore rendezvous transport:

- Session ID: at least 128 bits of cryptographic randomness; short expiry; single-use.
- Session record: owner UID, source device ID, ephemeral HPKE public key, expiry and state only.
- Message records: sender device ID, sequence, creation time and HPKE ciphertext only.
- Both devices must be signed into the same Firebase account. Firestore rules must prevent other accounts from reading or writing the session.
- Do not store HPKE private channel state, Olm private keys, cross-signing seeds, secret bundles, or plaintext chat history in Firestore.
- The QR contains only a versioned Dcalls pairing envelope, session ID and HPKE public key. It contains no Firebase credential or account recovery secret.
- Explicit approval on the existing device is required before sending a secrets bundle.

A successful HPKE channel proves that both endpoints share a secret; the users must still compare the SDK-generated check code to defend against a man-in-the-middle attack.

## Transfer and completion

- The new installation creates its own independent Matrix device identity and prekeys.
- The existing device exports the SDK secret bundle only after user approval and successful check-code comparison.
- The receiving device imports the bundle with `importSecretsBundle`.
- This QR release transfers account cross-signing secrets only. It does not copy older chat history or room keys.
- Never copy the old device's private Olm identity or IndexedDB crypto store wholesale.
- After import, register the new device and verify that its public device keys are signed by the account's self-signing key.
- Device listing and revocation are implemented in Settings; revoked devices are excluded from key queries, prekey claims and inbox delivery.
- Cancellation, expiry and replay rejection are implemented for pairing sessions.
- Room-history key transfer is still a separate follow-up; the current QR flow transfers cross-signing secrets only.

## Security acceptance criteria

1. Expired and replayed pairing sessions are rejected.
2. A different Firebase account cannot read, join or write to a session.
3. Firestore contains only public ephemeral data and HPKE ciphertext.
4. Neither device transfers secrets until the check codes match and the user approves.
5. The receiving SDK accepts the imported cross-signing bundle and reports the account identity verified.
6. Only authorized room keys are transferred.
7. Revoking a device prevents future key sharing to it; old messages and backups are not silently deleted.
8. Firestore rules are emulator-tested before deployment.
9. CI passes type-check and production build; real two-device tests are still required.
10. Revoked devices are not returned by active-device key queries and cannot claim prekeys or receive new device-inbox events.
