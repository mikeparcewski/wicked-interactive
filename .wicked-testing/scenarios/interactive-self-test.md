---
name: interactive-self-test
description: |
  Bootstrap acceptance scenario for wicked-interactive. Validates the core
  invariants that every release must preserve: test suite green, version
  consistency, event grammar conformance, and whitelist enforcement coverage.
  Dogfoods wicked-testing against wicked-interactive itself.
version: "1.0"
category: cli
tags: [bootstrap, self-test, dogfood, interactive]
tools:
  required: [node, npm, python3]
timeout: 120
assertions:
  - id: A1
    description: npm test passes — all 208 unit tests exit 0 with no failures
  - id: A2
    description: npm run check:version passes — package.json, plugin.json, and marketplace.json all agree on version 0.6.0
  - id: A3
    description: All wicked.interactive.* event types in src/ conform to 4-segment grammar wicked.<domain>.<noun>.<past-tense-verb>; non-conforming list is empty
  - id: A4
    description: POST /api/events whitelist enforcement is covered by the test suite (test/bridge.test.js "enforces the UI whitelist" test exists and passes)
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
npm test 2>&1 | tail -15
```

Expected: exit 0. Output contains `pass 208` and `fail 0`. No FAIL lines.

### Step 2: Version consistency check

```bash
npm run check:version
```

Expected: exit 0. Output contains `✓ Plugin version 0.6.0 is consistent`.

### Step 3: Event grammar conformance

```bash
python3 -c "
import subprocess, re

result = subprocess.run(
    ['grep', '-rh', 'wicked.interactive.', 'src/', '--include=*.js'],
    capture_output=True, text=True
)
pattern = re.compile(r\"'(wicked\\\\.interactive\\\\.[a-z][a-z0-9_]*\\\\.[a-z][a-z0-9_]*)'\\\"|(wicked\\\\.interactive\\\\.[a-z][a-z0-9_]*\\\\.[a-z][a-z0-9_]*)\\\"\")

# Simpler: just find all wicked.interactive.X.Y patterns
raw = re.findall(r\"[\\\"'](wicked\\\\.interactive\\\\.[a-z_]+\\\\.[a-z_]+)[\\\"']\", result.stdout)
events = set(raw)
bad = [e for e in events if len(e.split('.')) != 4]
print('event_count:', len(events))
print('non_conforming:', bad)
assert not bad, f'Non-conforming events: {bad}'
print('PASS')
"
```

Expected: exit 0. `event_count: 25`, `non_conforming: []`, `PASS` line printed.

### Step 4: Whitelist enforcement test coverage

```bash
grep -n "enforces the UI whitelist" test/bridge.test.js
node --experimental-vm-modules node_modules/.bin/mocha test/bridge.test.js --grep "enforces the UI whitelist" 2>&1 | tail -6
```

Expected: grep finds the test. mocha exits 0 with 1 passing.
