# Usage endpoint fixtures

Recorded / synthesized response shapes from `GET api.anthropic.com/api/oauth/usage`.
Each file is one observed (or historically-broken) shape. The table-driven
test in `test/usage-fixtures.test.ts` runs `normalizeUsage` over every file
in this dir and asserts the expected meter set.

When a new shape lands (a fresh field, a renamed bucket, a different
null pattern), capture it here as `<short-name>.json` and add a row to
the test's expectations table. The next shape shift then becomes a
failing test instead of a silent regression in the dashboard.

Conventions:
- Filenames are kebab-case and describe the *shape* not the *account*
  (`null-sonnet.json`, not `joshuas-max-account.json`).
- Each fixture is a complete response body as-served — do not trim
  unknown fields, since part of the value here is documenting drift.
