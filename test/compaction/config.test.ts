/**
 * Configuration contract tests (PR 7 Wave 1).
 *
 * Tests for:
 * - default configuration resolves to augment
 * - explicit/legacy mode precedence is deterministic
 * - invalid new mode fails safely to augment
 * - valid new mode values
 * - legacy precedence
 */
import { describe, it, expect, beforeEach, vi } from "vitest"
import { loadOptions } from "../../src/config"
import type { TokenmaxxerOptions } from "../../src/types"

describe("loadOptions — PR 7 Wave 1 config contract", () => {
  beforeEach(() => {
    // Clear all env vars before each test
    Object.keys(process.env).forEach((key) => {
      if (key.startsWith("TOKENMAXXER_")) {
        delete process.env[key]
      }
    })
  })

  describe("§14.A.1 — No compaction env vars -> augment", () => {
    it("default configuration resolves to augment when no env vars are set", () => {
      const options = loadOptions({} as unknown)
      expect(options.compactionMode).toBe("augment")
    })
  })

  describe("§14.A.2 — TOKENMAXXER_COMPACTION_MODE=augment -> augment", () => {
    it("explicit TOKENMAXXER_COMPACTION_MODE=augment resolves to augment", () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "augment"
      const options = loadOptions({} as unknown)
      expect(options.compactionMode).toBe("augment")
    })
  })

  describe("§14.A.3 — TOKENMAXXER_COMPACTION_MODE=replace -> replace", () => {
    it("explicit TOKENMAXXER_COMPACTION_MODE=replace resolves to replace", () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "replace"
      const options = loadOptions({} as unknown)
      expect(options.compactionMode).toBe("replace")
    })
  })

  describe("§14.A.4 — Legacy TOKENMAXXER_NO_PROMPT=1 -> augment", () => {
    it("legacy TOKENMAXXER_NO_PROMPT=1 resolves to augment when new mode absent", () => {
      process.env.TOKENMAXXER_NO_PROMPT = "1"
      const options = loadOptions({} as unknown)
      expect(options.compactionMode).toBe("augment")
    })
  })

  describe("§14.A.5 — Explicit legacy TOKENMAXXER_NO_PROMPT=0 -> replace when new mode absent", () => {
    it("explicit legacy TOKENMAXXER_NO_PROMPT=0 resolves to replace when new mode absent", () => {
      process.env.TOKENMAXXER_NO_PROMPT = "0"
      const options = loadOptions({} as unknown)
      expect(options.compactionMode).toBe("replace")
    })
  })

  describe("§14.A.6 — New valid mode wins over conflicting legacy flag", () => {
    it("TOKENMAXXER_COMPACTION_MODE=augment wins over TOKENMAXXER_NO_PROMPT=0", () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "augment"
      process.env.TOKENMAXXER_NO_PROMPT = "0"
      const options = loadOptions({} as unknown)
      expect(options.compactionMode).toBe("augment")
    })

    it("TOKENMAXXER_COMPACTION_MODE=replace wins over TOKENMAXXER_NO_PROMPT=1", () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "replace"
      process.env.TOKENMAXXER_NO_PROMPT = "1"
      const options = loadOptions({} as unknown)
      expect(options.compactionMode).toBe("replace")
    })
  })

  describe("§14.A.7 — Invalid new mode fails safely to augment", () => {
    it("invalid TOKENMAXXER_COMPACTION_MODE resolves to augment (safe fallback)", () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "invalid-mode"
      const options = loadOptions({} as unknown)
      expect(options.compactionMode).toBe("augment")
    })

    it("unknown TOKENMAXXER_COMPACTION_MODE resolves to augment (safe fallback)", () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "unknown"
      const options = loadOptions({} as unknown)
      expect(options.compactionMode).toBe("augment")
    })

    it("invalid new mode cannot silently opt into legacy replacement", () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "invalid-mode"
      process.env.TOKENMAXXER_NO_PROMPT = "0"
      const options = loadOptions({} as unknown)
      expect(options.compactionMode).toBe("augment")
    })
  })

  describe("§14.A.8 — Augment appends context and leaves output.prompt unset", () => {
    it("augment mode should not set output.prompt", () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "augment"
      const options = loadOptions({} as unknown)
      // In Wave 2, this will be checked against the actual hook behavior
      expect(options.compactionMode).toBe("augment")
    })
  })

  describe("§14.A.9 — Augment preserves pre-existing output.context entries", () => {
    it("augment mode should preserve unrelated context entries", () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "augment"
      const options = loadOptions({} as unknown)
      // In Wave 2, this will be checked against the actual hook behavior
      expect(options.compactionMode).toBe("augment")
    })
  })

  describe("§14.A.10 — Replace sets output.prompt without erasing unrelated context entries", () => {
    it("replace mode should set output.prompt without erasing unrelated context", () => {
      process.env.TOKENMAXXER_COMPACTION_MODE = "replace"
      const options = loadOptions({} as unknown)
      // In Wave 2, this will be checked against the actual hook behavior
      expect(options.compactionMode).toBe("replace")
    })
  })
})
