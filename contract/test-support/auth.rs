//! Exact-authorization assertions shared by every contract's auth tests (#1636).
//!
//! `env.mock_all_auths()` approves every `require_auth`, so a test written
//! with it passes whether the contract asks the right address, the wrong
//! address, or nobody at all. The helpers here instead hand the host exactly
//! one signed authorization tree, so:
//!
//! - a missing `require_auth` shows up as an `env.auths()` mismatch,
//! - auth on the wrong address fails the call (the signer's entry is unused
//!   and the address actually asked has none),
//! - an unexpected sub-invocation authorization fails the call (it is not in
//!   the signed tree) and shows up in `env.auths()`.
//!
//! Each crate includes this file from its auth test module with
//! `#[path = "../../test-support/auth.rs"] mod auth;` — it is test-only code
//! shared without a separate crate, so the wasm workspace build never sees it.
//!
//! Note: `Env::mock_auths` installs a mock account contract at every signer
//! address, so a signer must be a plain generated address, never a deployed
//! contract. Contract-to-contract auth (an arena authorising a factory
//! callback) is exercised through real cross-contract calls instead.

#![allow(dead_code)]

extern crate std;

use soroban_sdk::{
    Address, Env, IntoVal, Symbol, Val, Vec,
    testutils::{AuthorizedFunction, AuthorizedInvocation, MockAuth, MockAuthInvoke},
};
use std::boxed::Box;

/// One node of an authorization tree: `contract.fn_name(args)` and the
/// authorizations it requires from the same signer further down the stack.
#[derive(Clone)]
pub struct Call {
    pub contract: Address,
    pub fn_name: &'static str,
    pub args: Vec<Val>,
    pub subs: std::vec::Vec<Call>,
}

/// Build a tree node for `contract.fn_name(args)`.
pub fn call(
    env: &Env,
    contract: &Address,
    fn_name: &'static str,
    args: impl IntoVal<Env, Vec<Val>>,
) -> Call {
    Call {
        contract: contract.clone(),
        fn_name,
        args: args.into_val(env),
        subs: std::vec::Vec::new(),
    }
}

impl Call {
    /// Add a sub-invocation the same signer must also authorise.
    pub fn with(mut self, sub: Call) -> Self {
        self.subs.push(sub);
        self
    }

    /// `MockAuthInvoke` borrows its children; tests are short-lived, so the
    /// tree is leaked rather than threading lifetimes through every helper.
    fn to_mock(&self) -> &'static MockAuthInvoke<'static> {
        let contract: &'static Address = Box::leak(Box::new(self.contract.clone()));
        let subs: std::vec::Vec<MockAuthInvoke<'static>> =
            self.subs.iter().map(|sub| sub.to_mock().clone()).collect();
        Box::leak(Box::new(MockAuthInvoke {
            contract,
            fn_name: self.fn_name,
            args: self.args.clone(),
            sub_invokes: Box::leak(subs.into_boxed_slice()),
        }))
    }

    fn to_authorized(&self, env: &Env) -> AuthorizedInvocation {
        AuthorizedInvocation {
            function: AuthorizedFunction::Contract((
                self.contract.clone(),
                Symbol::new(env, self.fn_name),
                self.args.clone(),
            )),
            sub_invocations: self.subs.iter().map(|sub| sub.to_authorized(env)).collect(),
        }
    }
}

/// Install `signer`'s signature over `tree` as the only authorization.
pub fn sign(env: &Env, signer: &Address, tree: &Call) {
    let signer: &'static Address = Box::leak(Box::new(signer.clone()));
    env.mock_auths(&[MockAuth {
        address: signer,
        invoke: tree.to_mock(),
    }]);
}

/// Assert that `invoke` succeeds when — and only because — `signer` signed
/// exactly `tree`, and that the host recorded exactly that one authorization.
///
/// `invoke` performs the call with a `try_` client method and returns whether
/// it succeeded.
pub fn assert_exact_auth(env: &Env, signer: &Address, tree: &Call, invoke: impl FnOnce() -> bool) {
    sign(env, signer, tree);
    assert!(
        invoke(),
        "{} must succeed when authorised by exactly this signer and tree",
        tree.fn_name
    );
    assert_eq!(
        env.auths(),
        std::vec![(signer.clone(), tree.to_authorized(env))],
        "{} must require exactly this signer and authorization tree",
        tree.fn_name
    );
}

/// Assert that `invoke` fails when `intruder` — anyone other than the
/// address the entry point must check — signs the very same tree.
pub fn assert_rejects_signer(
    env: &Env,
    intruder: &Address,
    tree: &Call,
    invoke: impl FnOnce() -> bool,
) {
    sign(env, intruder, tree);
    assert!(
        !invoke(),
        "{} must reject a call authorised by the wrong address",
        tree.fn_name
    );
}

/// Assert that `invoke` fails with no authorization at all.
pub fn assert_rejects_unsigned(env: &Env, invoke: impl FnOnce() -> bool) {
    env.set_auths(&[]);
    assert!(!invoke(), "the call must be rejected without authorization");
}

/// Mint `amount` of the Stellar asset `token` to `to`, signed by its admin —
/// test setup that does not need `mock_all_auths`.
pub fn mint(env: &Env, token: &Address, token_admin: &Address, to: &Address, amount: i128) {
    sign(env, token_admin, &call(env, token, "mint", (to.clone(), amount)));
    soroban_sdk::token::StellarAssetClient::new(env, token).mint(to, &amount);
}

/// A fresh Stellar asset contract and its admin.
pub fn new_token(env: &Env) -> (Address, Address) {
    use soroban_sdk::testutils::Address as _;
    let admin = Address::generate(env);
    let token = env.register_stellar_asset_contract_v2(admin.clone()).address();
    (token, admin)
}

/// Install several signatures at once, one tree per signer.
pub fn sign_all(env: &Env, signed: &[(&Address, &Call)]) {
    let auths: std::vec::Vec<MockAuth<'static>> = signed
        .iter()
        .map(|(signer, tree)| MockAuth {
            address: Box::leak(Box::new((*signer).clone())),
            invoke: tree.to_mock(),
        })
        .collect();
    env.mock_auths(&auths);
}

/// Like [`assert_exact_auth`] for an entry point that needs several
/// signatures: each signer signs its own tree, the call succeeds, and the
/// host recorded exactly those authorizations, in order.
pub fn assert_exact_auths(env: &Env, signed: &[(&Address, &Call)], invoke: impl FnOnce() -> bool) {
    sign_all(env, signed);
    assert!(invoke(), "the call must succeed with exactly these signatures");
    let expected: std::vec::Vec<(Address, AuthorizedInvocation)> = signed
        .iter()
        .map(|(signer, tree)| ((*signer).clone(), tree.to_authorized(env)))
        .collect();
    assert_eq!(env.auths(), expected, "the call must require exactly these signatures");
}
