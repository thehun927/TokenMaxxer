#!/usr/bin/env node

import { readFileSync } from "node:fs";

const tuiJs = readFileSync("dist/tui.js", "utf8");

// Check 1: File exists
if (!tuiJs) {
  console.error("ERROR: dist/tui.js is empty or missing");
  process.exit(1);
}

// Check 2: Reject server createSignal pattern (the broken implementation)
// Server createSignal returns [getter, setter] where setter mutates directly
const serverCreateSignalPattern = /^\s*function createSignal\s*\([^)]*\)\s*\{\s*return\s*\[\s*\(\)\s*=>\s*value\s*,\s*\(v\)\s*=>\s*\{/m;

if (serverCreateSignalPattern.test(tuiJs)) {
  console.error("ERROR: TMTUI bundled Solid server runtime (server createSignal pattern detected)");
  process.exit(1);
}

// Check 3: Require reactive-only markers (writeSignal, observerSlots, etc.)
// Reject Owner and other non-reactive markers
const reactiveMarkers = [
  /\bwriteSignal\b/,
  /\bobserverSlots\b/,
];

const hasReactiveMarkers = reactiveMarkers.some(marker => marker.test(tuiJs));

if (!hasReactiveMarkers) {
  console.error("ERROR: TMTUI build missing reactive Solid runtime markers (writeSignal or observerSlots required)");
  process.exit(1);
}

// Check 4: Verify expected imports
const expectedImports = [
  "@opentui/solid",
];

const hasExpectedImports = expectedImports.some(imp => tuiJs.includes(imp));

if (!hasExpectedImports) {
  console.error("ERROR: TMTUI build missing expected @opentui/solid imports");
  process.exit(1);
}

console.log("check:tui-bundle: OK");
