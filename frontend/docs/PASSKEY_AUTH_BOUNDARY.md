# Passkey Authentication Boundary

## Purpose

Passkeys are an additional authenticator for an already verified Stellar account. A WebAuthn credential is not a Stellar secret key, wallet address, or transaction signer.

## Client behavior

The client may request a WebAuthn credential after a wallet-authenticated session exists. It must never derive a production wallet identity from a credential ID or present a passkey assertion as a Stellar transaction signature. The legacy preview-only address helper remains unavailable in production builds.

`usePasskeyWallet.sign` deliberately rejects transaction-signing requests. Transaction authorization continues to require the connected Stellar wallet and its explicit signing flow.

## Required server binding flow

1. Require an active wallet-authenticated session and a fresh wallet signature over the enrollment challenge.
2. Verify the WebAuthn origin, RP ID, challenge, user verification, credential ID, public key, sign counter, and challenge expiry on the server.
3. Persist the credential against the verified account only after the wallet and WebAuthn checks both succeed.
4. Resolve passkey login to that stored account; never treat a credential as an independently derived wallet.
5. Quarantine counter rollback or cloned-credential signals until the account holder completes wallet re-verification.

## Recovery and device management

Credential listings should expose only minimal device metadata such as creation and last-used time. Users need a wallet-authenticated route to revoke lost or untrusted devices. Losing a passkey must not prevent recovery with the verified Stellar wallet.

## Security boundary

Do not store raw WebAuthn public-key material in browser storage, log credential IDs, or attach passkey data to transaction payloads. Browser storage may only hold non-authoritative UI state; account ownership and credential validity are always determined by the server.