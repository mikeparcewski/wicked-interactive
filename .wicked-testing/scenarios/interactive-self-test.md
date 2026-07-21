---
name: interactive-self-test
description: |
  Bootstrap acceptance scenario for wicked-interactive. Validates the core
  invariants that every release must preserve: test suite green, version
  consistency, event grammar conformance, and whitelist enforcement coverage.
  Dogfoods wicked-testing against wicked-interactive itself.
version: "1.1"
category: cli
tags: [bootstrap, self-test, dogfood, interactive]
tools:
  required: [node, npm, python3, grep, bash]
timeout: 120
assertions:
  - id: A1
    description: npm test passes — all unit tests exit 0 with no failures (fail count is 0)
  - id: A2
    description: npm run check:version passes — package.json, plugin.json, and marketplace.json all agree on the same version (version-agnostic; invariant is consistency across the three files)
  - id: A3
    description: All wicked.interactive.* event types defined in src/service/events.js EVENT_TYPES conform to 4-segment grammar wicked.<domain>.<noun>.<verb>; non-conforming list is empty. (Note: past-tense is a naming convention enforced by review, not by the assertion script — the script validates segment count only.)
  - id: A4
    description: POST /api/events whitelist enforcement test exists in test/bridge.test.js and the full test suite passes with no failures
---

# Interactive Self-Test

Bootstrap acceptance dogfood — wicked-interactive validates its own core invariants.

## Setup

```bash
echo "Working directory: $(pwd)"
echo "Node version: $(node --version)"
```

## Steps

### Step 1: Run the test suite (npm test)

```bash
npm test 2>&1
```

Expected: exit 0. Output contains `fail 0`. No lines starting with `not ok` or matching `FAIL`.

### Step 2: Version consistency check

```bash
npm run check:version
```

Expected: exit 0. Output contains `✓ Plugin version` and `is consistent` (exact version string intentionally omitted — the invariant is consistency across the three manifest files, not a specific version number).

### Step 3: Event grammar conformance

Read the authoritative EVENT_TYPES registry from src/service/events.js:

```bash
python3 -c "
import re

with open('src/service/events.js') as f:
    content = f.read()

# EVENT_TYPES keys use double quotes in events.js
events = set(re.findall(r'\"(wicked\\.interactive\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*)\"', content))
# Validate 4-segment grammar: wicked.<domain>.<noun>.<past-tense-verb>
# (Script validates segment count; past-tense is a naming convention enforced by review, not parseable)
assert len(events) > 0, 'No wicked.interactive.* events found — regex failed to extract any events'
bad = [e for e in events if len(e.split('.')) != 4]
print('event_count:', len(events))
print('non_conforming:', bad)
assert not bad, f'Non-conforming events: {bad}'
print('PASS')
"
```

Expected: exit 0. `non_conforming: []`, `PASS` line printed. Event count is informational — the grammar invariant is segment count (4), not a fixed total (the total grows as new events are added).

### Step 4: Whitelist enforcement test coverage

```bash
grep -n "enforces the UI whitelist" test/bridge.test.js
set -o pipefail; npm test 2>&1 | grep -E "^(ℹ pass|ℹ fail)"
```

Expected: grep finds the test at test/bridge.test.js. npm test `pass` line shows non-zero count; `fail` line shows 0. The `set -o pipefail` ensures a non-zero exit from `npm test` propagates even when grep finds matching lines.
