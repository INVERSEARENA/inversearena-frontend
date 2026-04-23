//! ABI / event surface guard tests (issue #284). Fails CI when `abi_snapshot.json` drifts from the Rust API.

extern crate std;

use serde_json::Value;

use crate::ArenaError;

#[test]
fn arena_error_codes_match_abi_snapshot() {
    let snapshot: Value = serde_json::from_str(include_str!("../abi_snapshot.json")).unwrap();
    let arena = snapshot["arena_error"]
        .as_object()
        .expect("arena_error must be an object");

    let pairs: &[(&str, ArenaError)] = &[
        ("AlreadyInitialized", ArenaError::AlreadyInitialized),
        ("InvalidRoundSpeed", ArenaError::InvalidRoundSpeed),
        ("RoundAlreadyActive", ArenaError::RoundAlreadyActive),
        ("NoActiveRound", ArenaError::NoActiveRound),
        ("SubmissionWindowClosed", ArenaError::SubmissionWindowClosed),
        (
            "SubmissionAlreadyExists",
            ArenaError::SubmissionAlreadyExists,
        ),
        ("RoundStillOpen", ArenaError::RoundStillOpen),
        ("RoundDeadlineOverflow", ArenaError::RoundDeadlineOverflow),
        ("NotInitialized", ArenaError::NotInitialized),
        ("Paused", ArenaError::Paused),
        ("ArenaFull", ArenaError::ArenaFull),
        ("AlreadyJoined", ArenaError::AlreadyJoined),
        ("InvalidAmount", ArenaError::InvalidAmount),
        ("NoPrizeToClaim", ArenaError::NoPrizeToClaim),
        ("AlreadyClaimed", ArenaError::AlreadyClaimed),
        ("ReentrancyGuard", ArenaError::ReentrancyGuard),
        ("NotASurvivor", ArenaError::NotASurvivor),
        ("GameAlreadyFinished", ArenaError::GameAlreadyFinished),
        ("TokenNotSet", ArenaError::TokenNotSet),
        ("MaxSubmissionsPerRound", ArenaError::MaxSubmissionsPerRound),
        ("PlayerEliminated", ArenaError::PlayerEliminated),
        ("WrongRoundNumber", ArenaError::WrongRoundNumber),
        ("NotEnoughPlayers", ArenaError::NotEnoughPlayers),
        ("InvalidCapacity", ArenaError::InvalidCapacity),
        ("NoPendingUpgrade", ArenaError::NoPendingUpgrade),
        ("TimelockNotExpired", ArenaError::TimelockNotExpired),
        ("GameNotFinished", ArenaError::GameNotFinished),
        ("TokenConfigurationLocked", ArenaError::TokenConfigurationLocked),
        ("UpgradeAlreadyPending", ArenaError::UpgradeAlreadyPending),
        ("WinnerAlreadySet", ArenaError::WinnerAlreadySet),
        ("WinnerNotSet", ArenaError::WinnerNotSet),
        ("AlreadyCancelled", ArenaError::AlreadyCancelled),
        ("InvalidMaxRounds", ArenaError::InvalidMaxRounds),
        ("NameTooLong", ArenaError::NameTooLong),
        ("NameEmpty", ArenaError::NameEmpty),
        ("DescriptionTooLong", ArenaError::DescriptionTooLong),
        ("NoCommitment", ArenaError::NoCommitment),
        ("CommitmentMismatch", ArenaError::CommitmentMismatch),
        ("RevealDeadlinePassed", ArenaError::RevealDeadlinePassed),
        ("CommitDeadlinePassed", ArenaError::CommitDeadlinePassed),
        ("AlreadyCommitted", ArenaError::AlreadyCommitted),
        ("DeadlineTooSoon", ArenaError::DeadlineTooSoon),
        ("DeadlineTooFar", ArenaError::DeadlineTooFar),
        ("DeadlineNotReached", ArenaError::DeadlineNotReached),
        ("HashMismatch", ArenaError::HashMismatch),
        ("InvalidGracePeriod", ArenaError::InvalidGracePeriod),
    ];

    assert_eq!(
        arena.len(),
        pairs.len(),
        "arena_error snapshot must list every ArenaError variant exactly once"
    );

    for (name, expected) in pairs {
        let code = arena
            .get(*name)
            .unwrap_or_else(|| panic!("missing arena_error key {name}"))
            .as_u64()
            .unwrap_or_else(|| panic!("arena_error[{name}] must be a u64"))
            as u32;
        assert_eq!(code, *expected as u32, "mismatch for {name}");
    }
}

#[test]
fn exported_functions_match_abi_snapshot() {
    let snapshot: Value = serde_json::from_str(include_str!("../abi_snapshot.json")).unwrap();
    let funcs = snapshot["exported_functions"]
        .as_array()
        .expect("exported_functions must be an array");
    let names: std::vec::Vec<&str> = funcs
        .iter()
        .map(|v| v.as_str().expect("function name string"))
        .collect();

    let expected: &[&str] = &[
        "init",
        "set_token",
        "set_winner",
        "claim",
        "initialize",
        "admin",
        "set_admin",
        "pause",
        "unpause",
        "is_paused",
        "set_capacity",
        "get_arena_state",
        "join",
        "start_round",
        "commit_choice",
        "reveal_choice",
        "timeout_round",
        "resolve_round",
        "get_config",
        "get_round",
        "get_choice",
        "propose_upgrade",
        "execute_upgrade",
        "cancel_upgrade",
        "pending_upgrade",
        "set_max_rounds",
        "set_grace_period_seconds",
        "is_cancelled",
        "leave",
        "get_user_state",
        "get_full_state",
        "set_metadata",
        "get_metadata",
        "state",
        "get_arena_state_view",
        "init_factory",
    ];

    assert_eq!(
        names, expected,
        "exported_functions snapshot drift — bump schema_version if intentional"
    );
}

#[test]
fn event_topics_match_abi_snapshot() {
    let snapshot: Value = serde_json::from_str(include_str!("../abi_snapshot.json")).unwrap();
    let topics = snapshot["event_topics"]
        .as_array()
        .expect("event_topics must be an array");
    let names: std::vec::Vec<&str> = topics
        .iter()
        .map(|v| v.as_str().expect("topic string"))
        .collect();

    let expected: &[&str] = &[
        "UP_PROP", "UP_EXEC", "UP_CANC", "PAUSED", "UNPAUSED", "R_START", "R_TOUT", "RSLVD",
        "WIN_SET", "CLAIM",
    ];

    assert_eq!(
        names, expected,
        "event_topics snapshot drift — bump schema_version if intentional"
    );
}
