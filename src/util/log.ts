/**
 * Structured logging wrapper — never throws.
 * Uses client.app.log per opencode docs (not console.log).
 */
export async function log(
  client: unknown,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const c = client as { app?: { log: (args: { body: Record<string, unknown> }) => Promise<unknown> } }
    await c.app?.log({
      body: { service: "tokenmaxxer", level, message, extra },
    })
  } catch {
    // Logging must never throw — silently swallow
  }
}