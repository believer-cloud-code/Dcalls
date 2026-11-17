# Dcalls Secure Device Linking

## Goal

Allow a user who is already signed in on a new Dcalls installation to pair it with an existing trusted installation by scanning a short-lived QR code. The new installation must generate its own device identity and prekeys; private Olm device keys must never be copied between installations.

## Protocol building blocks

Use the pinned `@matrix-org/matrix-sdk-crypto-wasm` package's HPKE implementation:

- `HpkeRecipientChannel` on the device displaying the QR code.
- `HpkeSenderChannel` on the scanning device.
- `UnidirectionalRecipientChannel` and `UnidirectionalSenderChannel` to establish the bidirectional channel.
- `EstablishedHpkeChannel.checkCode` to display a matching verification code on both devices before any secrets are transferred.
- `seal` and `open` for encrypted rendezvous messages.

The SDK documentation explicitly describes these classes as the HPKE channel used by Matrix QR login (MSC4388). Dcalls should reuse the audited HPKE implementation, not implement its own key agreement or encryption.

## Dcalls transport

Dcalls has no Matrix homeserver or Matrix rendezvous service. The pairing flow therefore needs a Dcalls-owned Firestore rendezvous adapter, using the existing authenticated Firebase account:

- Store a random, high-entropy, short-lived session ID under the account's device-link session collection.
- Bind the session to the authenticated owner UID and the source device ID.
- Store only the ephemeral HPKE public key and encrypted rendezvous messages.
- Require the scanning installation to be authenticated as the same Firebase UID.
- Enforce an expiry, one-time state transitions, and owner-only cancellation.
- Never store the HPKE private channel, private device keys, cross-signing seeds, or plaintext history in Firestore.
- Do not put Firebase credentials or account recovery secrets in the QR payload.

The QR payload is a Dcalls-specific pairing envelope. Do not label it MSC4388-compatible login unless it follows the complete MSC4388 format and rendezvous semantics.

## Trust and history transfer prerequisites

A successful HPKE channel proves that both devices share the same ephemeral secret; it does not, by itself, establish account-level cryptographic trust.

Before transferring account secrets, Dcalls must implement the Matrix SDK cross-signing bootstrap transport. The SDK's `OlmMachine.bootstrapCrossSigning(false)` returns ordered upload requests for device keys (when needed), cross-signing keys, and signatures. Dcalls must persist and query the public cross-signing material through Firestore and feed successful responses back through `markRequestAsSent`.

The SDK's `exportSecretsBundle()` only succeeds when all three private cross-signing keys are available. The bundle is intended to be shared only with a trusted recipient. Do not add a QR screen that claims to complete trusted device linking until this prerequisite exists.

After trust is established, encrypted room-history transfer can use the SDK's room-key export/import APIs over the HPKE channel. Do not transfer the source device's private Olm identity or IndexedDB crypto store wholesale. Do not use experimental room-key-bundle APIs as the only recovery path without a separate compatibility and failure plan.

## UI and platform requirements

- Add a QR generator and camera/image scanner with maintained libraries compatible with Vite, Electron, and Capacitor.
- Show a clear device name, expiry countdown, and matching short verification code.
- Require explicit confirmation on the existing trusted device before releasing secrets.
- Provide cancel, expiry, replay rejection, and retry states.
- On completion, register the new device's independently generated public identity and prekeys.
- Add device listing and revocation so a lost device can be removed.

## Security acceptance criteria

1. QR sessions expire and cannot be replayed.
2. A different Firebase account cannot read, write, or join a session.
3. Firestore contains only public ephemeral data and HPKE ciphertext.
4. Neither device transfers secrets until the displayed verification codes match and the user approves.
5. The receiving device validates the transferred cross-signing material using the Matrix SDK.
6. The new device receives only the history keys it is authorized to receive.
7. Revoking a device prevents future key sharing to it; old messages and backups are not silently deleted.
8. Firestore rules are emulator-tested before deployment.
