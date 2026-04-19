# X User Post Collector Design

## Goal

Build a first-version data collection script that uses Playwright to capture all content types visible on an X user's timeline page and write normalized raw records to JSONL for later downstream analysis and distillation.

This phase only covers collection. It does not attempt summarization, clustering, or LLM-based extraction.

## Scope

### In scope

- Launch a persistent Playwright browser context so the user can reuse an authenticated X session.
- Open a target user's timeline page.
- Continuously scroll and collect all rendered timeline items that are visible through the authenticated session.
- Capture all visible content types on the profile timeline, including original posts, replies, reposts, and quote posts when present on the page.
- Normalize extracted data into a stable JSONL schema.
- Deduplicate items while the crawl is running.
- Stop automatically when scrolling no longer reveals new content.
- Emit crawl metadata describing the run.

### Out of scope

- Content distillation or knowledge extraction.
- Scraping likes/bookmarks/following tabs.
- Recovering deleted, hidden, or inaccessible posts.
- Reconstructing complete reply trees beyond what is visible on the user's timeline.
- Robust support for every X UI experiment.
- Bypassing anti-bot controls beyond using a real logged-in browser session.

## User Workflow

### First run

1. User runs the script in interactive mode with a persistent profile directory.
2. The browser opens X.
3. If the user is not logged in, they log in manually.
4. The script navigates to the target profile and starts collection.
5. Raw posts are written to a JSONL output file.
6. Crawl metadata is written beside the output.

### Subsequent runs

1. User reruns the command with the same persistent profile.
2. The saved session is reused.
3. The script collects timeline content without requiring another login unless the session expired.

## CLI Shape

The first version should be a single Node CLI script.

Example:

```bash
node scripts/x-scrape-user.js \
  --handle coolish \
  --out data/coolish.posts.jsonl \
  --profile-dir .playwright/x-profile \
  --limit 2000
```

### Required arguments

- `--handle`: target X handle without `@`
- `--out`: destination JSONL file path

### Optional arguments

- `--profile-dir`: persistent Playwright profile directory
- `--limit`: soft cap on collected items
- `--headless`: default false in first version
- `--max-no-new-scrolls`: stop after N scroll rounds with no new items
- `--scroll-delay-ms`: delay between scroll rounds
- `--start-url`: override target profile URL for debugging

## Data Model

Each JSONL line should be a normalized raw item with this shape:

```json
{
  "id": "1900000000000000000",
  "url": "https://x.com/someuser/status/1900000000000000000",
  "authorHandle": "someuser",
  "authorName": "Some User",
  "postedAt": "2026-04-19T10:00:00.000Z",
  "text": "post body",
  "lang": "en",
  "type": "post",
  "replyTo": null,
  "quotedUrl": null,
  "metrics": {
    "reply": 10,
    "repost": 5,
    "like": 42,
    "view": 1000
  },
  "media": [
    {
      "type": "image",
      "url": "https://pbs.twimg.com/..."
    }
  ],
  "rawHtmlSnippet": "<article ...>",
  "scrapedAt": "2026-04-19T12:00:00.000Z"
}
```

### Field notes

- `id` should be parsed from the canonical post URL when possible.
- `type` should be one of `post`, `reply`, `repost`, `quote`, or `unknown`.
- `replyTo` is best-effort and may be null when only partial cues are visible.
- `quotedUrl` is best-effort and should only be filled when a quote target link can be found.
- `metrics` are optional-best-effort values parsed from visible UI labels.
- `rawHtmlSnippet` is included for later parser fixes without requiring immediate recollection.

## Output Files

For an output file `data/coolish.posts.jsonl`, the script should also write:

- `data/coolish.posts.meta.json`

Metadata should include:

- target handle
- effective URL
- started at / finished at
- total unique items written
- number of scroll rounds
- stop reason
- profile dir used
- command arguments

## Architecture

The script should stay in one executable file for v1 but be split into small internal functions with clear responsibilities.

### Suggested internal units

#### `parseArgs()`

Parses and validates CLI input.

#### `launchBrowser()`

Starts Chromium with `launchPersistentContext` using the profile directory.

#### `openTimelinePage()`

Navigates to the target profile and waits for the timeline to render.

#### `extractVisibleArticles()`

Runs in the page context and extracts structured data from visible timeline `article` elements.

#### `normalizeArticleRecord()`

Normalizes page-extracted raw values into the final schema.

#### `appendJsonlRecord()`

Writes one line at a time to the JSONL file.

#### `crawlTimeline()`

Coordinates extract -> dedupe -> append -> scroll -> stop-condition logic.

#### `writeMetadata()`

Writes the crawl summary file at the end of execution.

## Extraction Strategy

The script should use DOM-first extraction from rendered `article` timeline nodes.

### Why DOM-first

- It matches the actual visible user experience.
- It avoids depending on unstable internal X API response shapes.
- It is simpler to debug than network interception.
- It is sufficient for a first-pass archival collector.

### DOM cues to use

- Post anchors containing `/status/`
- `<time>` nodes for timestamps
- Visible display name and handle text
- Article text containers
- Quote block links
- Reply/repost context text
- Media `img` or video poster URLs where visible
- Action bar text for metrics where available

### Extraction robustness rules

- Prefer multiple selectors or heuristics for the same field.
- Never fail the whole run because one field is missing.
- Keep unknown values as `null` rather than guessing.
- Preserve `rawHtmlSnippet` for troubleshooting selector drift.

## Deduplication

Deduplicate in memory during the run.

### Primary dedupe key

- Canonical `url`

### Secondary fallback

- `id` if URL normalization fails

### Rationale

The same post can be rendered multiple times during scrolling, especially with rerendering, sticky content, or quote/reply contexts.

## Scroll Strategy

The crawler should stop based on observed progress, not a fixed runtime.

### Loop

1. Extract currently rendered items.
2. Normalize and write newly discovered items.
3. Scroll downward by roughly one viewport height or to the bottom.
4. Wait for a short delay.
5. Repeat.

### Stop conditions

- `limit` reached
- consecutive scroll rounds with no new items exceed `max-no-new-scrolls`
- page indicates end-of-timeline or no more content
- fatal navigation/login blockage

## Failure Handling

### Expected failure modes

- session expired
- timeline not loading
- temporary UI overlays or login prompts
- article selector drift
- metrics missing from some cards
- rate limiting or anti-automation friction

### Handling rules

- fail fast on missing required arguments
- fail fast if the page cannot reach a usable profile timeline
- continue when individual cards are partially malformed
- always write metadata with the final stop reason when possible
- emit clear stderr logs describing the latest successful stage

## Logging

The script should log concise progress lines such as:

- browser launched
- profile opened
- login likely required
- extracted N visible cards
- wrote M new unique items
- stopping because no new items appeared for K rounds

Verbose trace logging is not required in v1.

## Testing Strategy

This work should follow TDD.

### Unit-style tests

Test pure helpers first.

- argument parsing
- URL normalization
- post ID extraction
- record normalization
- metric text parsing
- dedupe behavior

### Fixture-driven extraction tests

Create saved HTML fixtures representing representative X timeline article variants:

- original post
- reply
- repost context
- quote post
- media post
- partially missing fields

Then test extraction logic against those fixtures without launching a live browser.

### Live smoke test

Add one manually-invoked smoke script or test command that runs against a real logged-in profile and validates:

- the page opens
- at least one item is extracted
- output JSONL is produced

This should not be required for automated test runs.

## Security And Ethics

- The script relies on the user's own authenticated browser session.
- Credentials must not be captured or stored by the script.
- The persistent profile directory should be local-only and gitignored.
- The script should collect only the visible profile timeline content requested by the user.

## Implementation Notes

- Use the existing `playwright` dependency already present in the workspace.
- Use CommonJS to match the current project configuration.
- Keep dependencies minimal for v1.
- Prefer built-in Node modules for file writing and argument parsing logic.

## Success Criteria

The first version is successful if:

- a logged-in user can run one command against an X handle
- the script scrolls and captures visible timeline items across multiple content types
- results are written as stable JSONL records
- duplicates are prevented in a single run
- the crawl ends automatically when content stops expanding
- a metadata file explains what happened during the run

## Future Extensions

- incremental resume using an existing output file
- CSV summary export
- separate collectors for replies tab or media tab
- content distillation pipeline
- richer thread reconstruction
- selector fallback packs for X UI variants

## Live Verification Notes

- A real smoke run succeeded with `--headless`, persistent profile reuse, and `--limit 5`.
- The runtime required a one-time `npx playwright install chromium` before the first live run.
- Normalization now filters false quote targets ending in `/analytics` and filters avatar-style `profile_images` URLs out of `media`.
- Some pinned or variant timeline cards can still leave `authorName` as `null`; downstream consumers should treat that field as optional in v1.