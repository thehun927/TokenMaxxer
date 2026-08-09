import { Plugin } from '@opencode-ai/plugin';

/**
 * tokenmaxxer — opencode plugin for session longevity & cross-session memory.
 *
 * Two layers, zero per-project config required:
 * 1. Compaction-quality hook — injects durable state + schema-constrained prompt.
 * 2. Per-project durable memory — written on session.idle and available via
 *    the registered memory tools.
 *
 * See docs/PLAN.md and docs/IMPLEMENTATION.md for full design.
 */

declare const TokenmaxxerPlugin: Plugin;

export { TokenmaxxerPlugin, TokenmaxxerPlugin as default };
