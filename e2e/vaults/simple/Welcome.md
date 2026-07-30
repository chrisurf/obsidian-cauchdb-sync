# Welcome

This is the starting vault used by the CouchDB Sync end-to-end tests.

Specs reset this vault to its committed state before each test via
`obsidianPage.resetVault("e2e/vaults/simple")`, so anything a test creates
here is transient.
