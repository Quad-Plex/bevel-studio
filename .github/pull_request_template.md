## Summary

<!-- What changes, and why. Link the issue if there is one. -->

## Verification

<!-- Commands you ran and their result. Geometry changes: did `npm run acceptance` pass? -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run acceptance` (geometry changes only)

## Checklist

- [ ] Engine code stays free of DOM, React and three.js imports.
- [ ] Contracts (`src/engine/types.ts`, `src/engine/protocol.ts`) unchanged, or the change was discussed first.
- [ ] Documentation updated where behaviour changed.
- [ ] `CHANGELOG.md` updated for user-visible changes.
