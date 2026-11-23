# Frontend browser storage

Browser persistence is owned by `frontend/src/shared/lib/localStorage.ts`. Register each stable key with a version, runtime schema, and `user` or `device` scope in `StorageKey`; register per-arena and per-round keys with `registerStorageKey`. Use `localStorageManager` or `sessionStorageManager` for reads and writes. Both managers guard SSR, storage access exceptions, and quota failures, and persist versioned envelopes while accepting legacy unwrapped values during migration.

`logoutSession()` clears all registered user-scoped persistent keys. Device preferences and the explicit wallet-disconnect flag remain on the device. Commit/reveal salts are user-scoped and survive reloads until the reveal flow removes them. ESLint forbids direct access to browser storage outside the manager.
