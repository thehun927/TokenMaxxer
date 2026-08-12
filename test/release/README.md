# PR-10 Release Tests

This directory contains behavioral tests for PR-10 release contracts. These tests validate the release hygiene requirements without modifying production code.

## Test Files

- `dist-contract.test.ts` - Validates generated-only dist authority and git tracking
- `dist-inventory.test.ts` - Validates exact six-file dist inventory and self-containment
- `package-contract.test.ts` - Validates package.json structure and allow-list
- `reproducibility-contract.test.ts` - Validates same-commit reproducibility proof
- `release-manifest.test.ts` - Validates release manifest/version/commit shape

## Expected Behavior

These tests document the expected behavior of PR-10 contracts. Since production does not yet implement PR-10, many tests will fail intentionally until implementation is complete.

## Running Tests

```bash
npm test test/release/
```

## Notes

- Tests use behavioral assertions where possible
- Tests are compatible with Vitest/TypeScript conventions
- Intentional failures are marked with comments
