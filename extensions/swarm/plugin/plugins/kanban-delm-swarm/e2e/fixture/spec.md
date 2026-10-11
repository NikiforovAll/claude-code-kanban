# String helpers

**Goal**: implement the two stub functions of this small Node module, `slugify` in `src/slugify.js` and `titleCase` in `src/title-case.js`, so the tests in `test/strings.test.js` pass. A developer imports them as ES modules.

**Constraints**:
- Change only `src/slugify.js` and `src/title-case.js`. Do not change the tests or `package.json`.
- No dependencies: plain JavaScript on the Node runtime.
- Keep each function in its own file with its current export name.

**Decisions**:
- `slugify` lowercases, strips accents (Unicode NFD, then removes combining marks), turns every run of other characters into one `-`, and trims `-` at both ends.
- `titleCase` splits on whitespace, drops empty words, capitalizes the first letter of each word, lowercases the rest and joins with one space.

**Acceptance checks**:
- `npm test` passes in the project root.
