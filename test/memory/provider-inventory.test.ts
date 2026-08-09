import { describe, expect, it } from "vitest"
import {
  isEligibleAutomaticModel,
  normalizeProviderInventory,
} from "../../src/memory/provider-inventory"

function response(all: unknown[], connected?: unknown) {
  return {
    data: {
      all,
      ...(connected === undefined ? {} : { connected }),
    },
  }
}

function model(overrides: Record<string, unknown> = {}) {
  return {
    tool_call: true,
    cost: { input: 0, output: 0 },
    ...overrides,
  }
}

describe("v1 provider inventory adapter", () => {
  it("normalizes envelope, connected IDs, model IDs, flags, and variants", () => {
    const inventory = normalizeProviderInventory(response([
      {
        id: "provider",
        models: {
          "provider-model": model({ id: "provider-model", status: "active", variants: { none: {}, thinking: {} } }),
        },
      },
    ], ["provider"]))

    expect(inventory).not.toBeNull()
    expect(inventory?.connected_provider_ids).toEqual(["provider"])
    expect(inventory?.models).toEqual([expect.objectContaining({
      provider: "provider",
      model: "provider-model",
      connected: true,
      active: true,
      tool_callable: true,
      zero_cost: true,
      variants: ["none", "thinking"],
    })])
  })

  it("supports model arrays and capabilities.toolcall with omitted active status", () => {
    const inventory = normalizeProviderInventory({
      data: {
        providers: [{
          providerID: "provider",
          connected: true,
          models: [{
            modelID: "free",
            capabilities: { toolcall: true },
            cost: { input: 0, output: 0 },
            variants: ["none"],
          }],
        }],
      },
    })
    const candidate = inventory?.models[0]
    expect(candidate).toMatchObject({ model: "free", active: true, variants: ["none"] })
    expect(candidate && isEligibleAutomaticModel(candidate)).toBe(true)
  })

  it("filters disconnected, inactive, paid, and non-tool models", () => {
    const inventory = normalizeProviderInventory(response([
      { id: "disconnected", models: { free: model() } },
      { id: "connected", models: {
        inactive: model({ status: "beta" }),
        paid: model({ cost: { input: 1, output: 0 } }),
        noTools: model({ tool_call: false }),
        eligible: model(),
      } },
    ], ["connected"]))

    expect(inventory?.models.filter(isEligibleAutomaticModel).map((item) => item.model))
      .toEqual(["eligible"])
  })

  it("rejects ambiguous IDs and bounds drift diagnostics", () => {
    const inventory = normalizeProviderInventory(response([
      { id: "provider", providerID: "other", models: {} },
      { id: "valid", models: { good: model() } },
    ], ["valid"]))

    expect(inventory?.models.map((item) => item.provider)).toEqual(["valid"])
    expect(inventory?.diagnostics).toHaveLength(1)
    expect(inventory?.diagnostics[0]?.code).toBe("ambiguous-provider-id")
  })
})
