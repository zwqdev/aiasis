# X Scraper System Chrome Profile Design

## Goal

Make the existing X post collector use the user's already logged-in macOS Google Chrome profile by default, so the scraper can run against an authenticated X session without requiring a separate Playwright login bootstrap.

This change is only about session source selection and validation. It does not change the extraction schema, crawl loop, or output format.

## Scope

### In scope

- Change the default session source from the existing Playwright-managed profile directory to the local macOS Google Chrome user data directory on macOS.
- Default to the `Default` Chrome profile when this mode is enabled.
- Allow an optional Chrome profile name override for future use.
- Allow an explicit fallback flag that keeps using the dedicated `.playwright/x-profile` session.
- Validate that the target Chrome user data directory and selected profile directory exist before launch.
- Validate that the selected Chrome-backed browser context contains a usable X authenticated session.
- Fail with explicit errors when system Chrome profile reuse is unavailable, locked, or unauthenticated.
- Preserve all existing output behavior for JSONL and metadata.

### Out of scope

- Copying or importing cookies from Chrome into `.playwright/x-profile`.
- Supporting Safari, Arc, Edge, or non-Chrome browsers.
- Handling every possible Chrome multi-profile installation layout.
- Automatic recovery when Chrome is actively locking the selected profile.
- Any changes to post extraction or scroll completeness beyond authentication source selection.

## User Workflow

### New default behavior

1. User runs the scraper without any session-source flags.
2. The scraper resolves the macOS Chrome user data root at `~/Library/Application Support/Google/Chrome`.
3. The scraper selects the `Default` profile unless the user overrides it.
4. The scraper launches Chromium against that user data directory.
5. The scraper verifies that X authentication cookies are present.
6. If authentication is valid, collection proceeds normally.
7. If authentication is missing or the profile cannot be opened, the scraper exits with a clear, actionable error.

### Explicit fallback behavior

1. User runs the scraper with an explicit fallback flag.
2. The scraper uses `.playwright/x-profile` as before.
3. The user can still keep a separate login/bootstrap flow when they want isolation from system Chrome.

## CLI Shape

The existing command should remain valid and should now default to system Chrome on macOS.

### Default behavior

- System Chrome is the default session source on macOS.

### New fallback flag

- `--use-playwright-profile`: use `.playwright/x-profile` instead of the system Chrome user data directory

### New optional flag

- `--chrome-profile`: Chrome profile directory name under the user data root, default `Default`

### Example

```bash
npm run download:posts -- --handle lanaaielsa
```

Optional override:

```bash
npm run download:posts -- --handle lanaaielsa --chrome-profile Default
```

Explicit fallback to the dedicated Playwright profile:

```bash
npm run download:posts -- --handle lanaaielsa --use-playwright-profile
```

## Architecture

The current single-file CLI structure can remain intact. The session-source decision should be isolated behind small helpers.

### Suggested internal units

#### `parseArgs()`

Extend argument parsing with:

- `usePlaywrightProfile: boolean`
- `chromeProfile: string`

#### `resolveBrowserContextOptions()`

Return the correct `launchPersistentContext` inputs based on CLI options.

Behavior:

- default mode uses `.playwright/x-profile`
- default mode uses the macOS Chrome user data root
- fallback mode uses `.playwright/x-profile`
- system Chrome mode records the selected Chrome profile name

#### `validateSystemChromePaths()`

Checks when system Chrome mode is active:

- Chrome user data root exists
- requested profile directory exists

#### `launchBrowserContext()`

Starts Chromium with the resolved user data directory and launch args.

In system Chrome mode it should ensure the selected profile is used via Chromium launch arguments rather than assuming `Default` implicitly.

#### `ensureAuthenticatedSession()`

Retain the current cookie-based validation, but adapt messaging to distinguish:

- Playwright profile mode
- system Chrome mode

## Browser Launch Strategy

The scraper currently uses `chromium.launchPersistentContext(profileDir, ...)`. That remains the correct base primitive.

### Default mode

- user data dir: `~/Library/Application Support/Google/Chrome`
- launch arg: `--profile-directory=<chromeProfile>`

### Explicit fallback mode

- user data dir: `.playwright/x-profile`
- no Chrome profile-directory override needed

### Rationale

- The Chrome user data root contains multiple profile folders.
- Passing only the `Default` folder as the user data dir is structurally wrong for Chromium profile selection.
- The correct separation is: user data root plus profile-directory argument.

## Validation Rules

### Pre-launch validation

- If default system Chrome mode is active on a machine where the expected macOS path layout is not found, fail with a clear message that system Chrome could not be located.
- If the selected Chrome profile directory does not exist, fail with a clear message naming the expected path.

### Post-launch validation

- Require both `auth_token` and `ct0` cookies for X.
- If cookies are missing in headless mode, fail immediately.
- If cookies are missing in interactive mode under system Chrome mode, fail with a message stating that the selected Chrome profile is not logged into X.
- If cookies are missing in Playwright-profile fallback mode, retain the current login/bootstrap guidance.

### Lock conflict handling

- If Chromium cannot open the system Chrome user data directory because Chrome is running or the profile is locked, surface the launch error clearly.
- The error guidance should recommend either closing Chrome fully or using the explicit `--use-playwright-profile` fallback mode.

## Metadata Changes

The `.meta.json` output should include enough information to explain which session source was used.

Add:

- `sessionSource`: `playwright-profile` or `system-chrome`
- `chromeProfile`: selected Chrome profile name when system Chrome mode is active

Retain existing metadata fields.

## Failure Handling

### Expected failure modes

- system Chrome user data root not found
- requested Chrome profile not found
- Chrome profile locked by a running Chrome process
- selected Chrome profile is not logged into X
- X session expired despite Chrome login being present previously

### Handling rules

- fail before crawl if path resolution fails
- fail before crawl if launch fails
- fail before crawl if X authentication cookies are missing
- always write metadata with the final stop reason when possible
- preserve existing extraction and writing behavior once authenticated session checks pass

## Testing Strategy

This work should follow TDD.

### Unit tests

- argument parsing for default system Chrome mode
- argument parsing for `--use-playwright-profile`
- argument parsing for `--chrome-profile`
- path resolution for system Chrome mode
- metadata enrichment for session source selection

### Integration-level tests without live X

- resolve Chrome user data root and profile path deterministically from helper inputs
- verify system Chrome mode chooses Chromium args correctly
- verify missing-path conditions produce explicit errors

### Manual verification

Run on a macOS machine with Chrome already logged into X:

```bash
npm run download:posts -- --handle lanaaielsa --use-system-chrome

```

Run again in explicit fallback mode:

```bash
npm run download:posts -- --handle lanaaielsa --use-playwright-profile
```

Expected outcomes:

- browser launches against the Chrome-backed profile by default
- X timeline opens without separate login prompt
- JSONL output is produced
- metadata records `sessionSource: system-chrome`

## Security And Safety

- The scraper must not copy, export, or print cookies.
- The scraper must only reuse the local browser session already present on the machine.
- The scraper must not mutate unrelated Chrome profile contents intentionally.
- Error messages should avoid printing sensitive cookie values or filesystem secrets.

## Success Criteria

This change is successful if:

- the user can run one command without extra session flags and get system Chrome reuse by default
- the scraper detects and uses the macOS Chrome default profile correctly
- X authentication is recognized without separate Playwright login bootstrap
- path and lock failures are reported clearly
- existing scraper outputs remain compatible

## Tradeoffs

### Benefits

- fastest path for users who already browse X in Chrome
- avoids duplicate manual login for the scraper
- preserves the existing collector logic

### Costs

- tighter coupling to macOS Chrome filesystem layout
- possible launch conflicts when Chrome is already running
- less isolation than the dedicated Playwright profile mode

## Compatibility Notes

- On macOS, the default session source should be system Chrome.
- Users who want the old isolated behavior should pass `--use-playwright-profile`.
- Help text and error messages should make this default explicit so the CLI remains understandable.

## Spec Self-Review

- No placeholders remain.
- The scope is limited to session-source selection and validation.
- The browser-launch section explicitly separates user data root from Chrome profile-directory selection to avoid a common implementation mistake.
- Failure and metadata behavior are consistent with the existing collector design.
- The default and fallback modes are now explicit and non-overlapping.