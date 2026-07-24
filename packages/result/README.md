# Result

This package provides the shared `Result<T, E>`, `ok`, `err`, `tryCatch`, and `tryCatchSync`
primitives used across workspace boundaries. Expected operational failures should be returned as
typed error values instead of thrown.
