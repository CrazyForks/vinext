import { describe, expect, it } from "vite-plus/test";
import {
  buildBoundaryOutcomeCompatibility,
  buildCacheVariant,
  buildRenderObservation,
  CACHE_PROOF_MODEL_SCHEMA_VERSION,
  classifyCacheVariantDimensionDowngrade,
  classifyRenderObservationDowngrade,
  createAppRouteCacheProofGraphScope,
  createDisabledCacheProofDecision,
  DEFAULT_CACHE_VARIANT_BUDGET,
  hasCompleteNegativeRequestApiProof,
  type AppRouteCacheProofGraphScopeInput,
  type CacheProofBreakerFallback,
} from "../packages/vinext/src/server/cache-proof.js";

function expectBreakerReason(
  result: ReturnType<typeof buildCacheVariant>,
  code: CacheProofBreakerFallback["code"],
): CacheProofBreakerFallback {
  expect(result.kind).toBe("breakerFallback");
  if (result.kind !== "breakerFallback") {
    throw new Error("Expected cache variant construction to return a breaker fallback");
  }
  expect(result.fallback.code).toBe(code);
  return result.fallback;
}

describe("disabled cache proof model", () => {
  it("normalizes route graph semantic ids for cache proof scopes", () => {
    const route = {
      ids: {
        route: "route:/shop/:id",
        page: "page:/shop/:id",
        routeHandler: null,
        rootBoundary: "root-boundary:/",
        layouts: ["layout:/", "layout:/shop/[id]"],
        templates: [],
        slots: {
          "zebra@shop/[id]/@zebra": "slot:zebra:/shop/[id]",
          "modal@shop/[id]/@modal": "slot:modal:/shop/[id]",
          "modal-copy@shop/[id]/@modal": "slot:modal:/shop/[id]",
        },
      },
    } satisfies AppRouteCacheProofGraphScopeInput;

    const scope = createAppRouteCacheProofGraphScope(route);

    expect(scope).toEqual({
      routeId: "route:/shop/:id",
      pageId: "page:/shop/:id",
      routeHandlerId: null,
      layoutIds: ["layout:/", "layout:/shop/[id]"],
      templateIds: [],
      slotIds: ["slot:modal:/shop/[id]", "slot:zebra:/shop/[id]"],
    });
  });

  it("canonicalizes dimensions while keeping cache keys and traces redacted", () => {
    const first = buildCacheVariant({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [
        {
          name: "sort",
          privacy: "public",
          source: "search",
          values: ["desc"],
        },
        {
          name: "SORT",
          privacy: "public",
          source: "search",
          values: ["asc", "asc"],
        },
        {
          name: "id",
          privacy: "public",
          source: "params",
          values: ["super-secret-token"],
        },
      ],
      existingVariantCount: 0,
      output: {
        kind: "app-rsc",
        mountedSlotsFingerprint: "slots:main",
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/shop/:id",
      },
    });
    const second = buildCacheVariant({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [
        {
          name: "id",
          privacy: "public",
          source: "params",
          values: ["super-secret-token"],
        },
        {
          name: "sort",
          privacy: "public",
          source: "search",
          values: ["asc", "desc"],
        },
      ],
      existingVariantCount: 0,
      output: {
        kind: "app-rsc",
        mountedSlotsFingerprint: "slots:main",
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/shop/:id",
      },
    });

    expect(first.kind).toBe("variant");
    expect(second.kind).toBe("variant");
    if (first.kind !== "variant" || second.kind !== "variant") {
      throw new Error("Expected both inputs to produce cache variants");
    }

    expect(first.variant.cacheKey).toBe(second.variant.cacheKey);
    expect(first.variant.cacheKey.startsWith(`cp${CACHE_PROOF_MODEL_SCHEMA_VERSION}:`)).toBe(true);
    expect(first.variant.schemaVersion).toBe(CACHE_PROOF_MODEL_SCHEMA_VERSION);
    expect(first.variant.dimensions.map((dimension) => dimension.name)).toEqual(["id", "sort"]);
    expect(first.variant.dimensions[0].valueHashes).toHaveLength(1);
    expect(first.variant.dimensions[1].valueHashes).toHaveLength(2);

    const serializedVariant = JSON.stringify(first.variant);
    expect(serializedVariant).not.toContain("super-secret-token");
    expect(serializedVariant).not.toContain("desc");
    expect(serializedVariant).not.toContain("asc");
  });

  it("keeps null and empty-string output scope dimensions distinct", () => {
    const absentEpoch = buildCacheVariant({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [],
      existingVariantCount: 0,
      output: {
        kind: "app-html",
        renderEpoch: null,
        rootBoundaryId: null,
        routeId: "route:/",
      },
    });
    const emptyEpoch = buildCacheVariant({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [],
      existingVariantCount: 0,
      output: {
        kind: "app-html",
        renderEpoch: "",
        rootBoundaryId: "",
        routeId: "route:/",
      },
    });

    expect(absentEpoch.kind).toBe("variant");
    expect(emptyEpoch.kind).toBe("variant");
    if (absentEpoch.kind !== "variant" || emptyEpoch.kind !== "variant") {
      throw new Error("Expected both output scopes to produce cache variants");
    }

    expect(absentEpoch.variant.cacheKey).not.toBe(emptyEpoch.variant.cacheKey);
  });

  it("returns breaker fallbacks for unsafe or over-budget variants", () => {
    const unsafePublicCookie = buildCacheVariant({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [
        {
          name: "session",
          privacy: "public",
          source: "cookie",
          values: ["abc"],
        },
      ],
      existingVariantCount: 0,
      output: {
        kind: "layout",
        layoutId: "layout:/account",
        rootBoundaryId: "layout:/",
        routeId: "route:/account",
      },
    });

    const fallback = expectBreakerReason(unsafePublicCookie, "CP_UNSAFE_PUBLIC_DIMENSION");
    expect(JSON.stringify(fallback.fields)).not.toContain("abc");

    expectBreakerReason(
      buildCacheVariant({
        budget: {
          ...DEFAULT_CACHE_VARIANT_BUDGET,
          maxDimensionValueLength: 4,
        },
        dimensions: [
          {
            name: "tenant",
            privacy: "public",
            source: "params",
            values: ["customer-a"],
          },
        ],
        existingVariantCount: 0,
        output: {
          kind: "layout",
          layoutId: "layout:/[tenant]",
          rootBoundaryId: "layout:/",
          routeId: "route:/:tenant",
        },
      }),
      "CP_DIMENSION_VALUE_TOO_LONG",
    );

    expectBreakerReason(
      buildCacheVariant({
        budget: {
          ...DEFAULT_CACHE_VARIANT_BUDGET,
          maxVariantsPerRoute: 2,
        },
        dimensions: [
          {
            name: "tenant",
            privacy: "public",
            source: "params",
            values: ["a"],
          },
        ],
        existingVariantCount: 2,
        output: {
          kind: "layout",
          layoutId: "layout:/[tenant]",
          rootBoundaryId: "layout:/",
          routeId: "route:/:tenant",
        },
      }),
      "CP_ROUTE_VARIANT_CEILING_EXCEEDED",
    );

    const invalidBudget = buildCacheVariant({
      budget: {
        ...DEFAULT_CACHE_VARIANT_BUDGET,
        maxEncodedLength: -1,
      },
      dimensions: [],
      existingVariantCount: 0,
      output: {
        kind: "layout",
        layoutId: "layout:/[tenant]",
        rootBoundaryId: "layout:/",
        routeId: "route:/:tenant",
      },
    });
    expect(invalidBudget.kind).toBe("breakerFallback");
    if (invalidBudget.kind !== "breakerFallback") {
      throw new Error("Expected invalid cache variant budget to return a breaker fallback");
    }
    expect(invalidBudget.fallback).toMatchObject({
      code: "CP_INVALID_VARIANT_BUDGET",
      fields: { budgetField: "maxEncodedLength" },
    });
  });

  it("requires complete negative request-api observations before absence is proof", () => {
    const complete = buildRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "public",
      cacheTags: ["posts", "posts"],
      completeness: "complete",
      dynamicFetches: ["https://api.example.test/posts?token=secret"],
      output: {
        kind: "layout",
        layoutId: "layout:/blog",
        rootBoundaryId: "layout:/",
        routeId: "route:/blog",
      },
      pathTags: ["/blog"],
      requestApis: [
        { kind: "headers", status: "notObserved" },
        { kind: "cookies", status: "notObserved" },
      ],
    });
    const partial = buildRenderObservation({
      ...complete,
      completeness: "partial",
    });
    const observed = buildRenderObservation({
      ...complete,
      requestApis: [
        { kind: "headers", status: "observed" },
        { kind: "cookies", status: "notObserved" },
      ],
    });
    const missingApiKind = buildRenderObservation({
      ...complete,
      requestApis: [{ kind: "cookies", status: "notObserved" }],
    });

    expect(hasCompleteNegativeRequestApiProof(complete, ["headers", "cookies"])).toBe(true);
    expect(hasCompleteNegativeRequestApiProof(partial, ["headers", "cookies"])).toBe(false);
    expect(hasCompleteNegativeRequestApiProof(observed, ["headers", "cookies"])).toBe(false);
    expect(hasCompleteNegativeRequestApiProof(missingApiKind, ["headers", "cookies"])).toBe(false);
    expect(complete.cacheTags).toEqual(["posts"]);
    expect(JSON.stringify(complete.dynamicFetches)).not.toContain("secret");
  });

  it("treats boundary outcome compatibility as exact-match only", () => {
    expect(
      buildBoundaryOutcomeCompatibility({
        candidate: { kind: "success" },
        expected: { kind: "success" },
      }).kind,
    ).toBe("compatible");

    const mismatch = buildBoundaryOutcomeCompatibility({
      candidate: { kind: "notFound" },
      expected: { kind: "success" },
    });
    expect(mismatch.kind).toBe("incompatible");
    if (mismatch.kind === "incompatible") {
      expect(mismatch.fallback.code).toBe("CP_BOUNDARY_OUTCOME_MISMATCH");
    }

    const unknown = buildBoundaryOutcomeCompatibility({
      candidate: { kind: "unknown" },
      expected: { kind: "success" },
    });
    expect(unknown.kind).toBe("incompatible");
    if (unknown.kind === "incompatible") {
      expect(unknown.fallback.code).toBe("CP_BOUNDARY_OUTCOME_UNKNOWN");
    }
  });

  it("never authorizes runtime reuse while the proof model is disabled", () => {
    const variant = buildCacheVariant({
      budget: DEFAULT_CACHE_VARIANT_BUDGET,
      dimensions: [],
      existingVariantCount: 0,
      output: {
        kind: "app-html",
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/",
      },
    });

    expect(variant.kind).toBe("variant");
    if (variant.kind !== "variant") {
      throw new Error("Expected cache variant construction to succeed");
    }

    const decision = createDisabledCacheProofDecision({
      variant: variant.variant,
      observation: buildRenderObservation({
        boundaryOutcome: { kind: "success" },
        cacheability: "public",
        cacheTags: [],
        completeness: "complete",
        dynamicFetches: [],
        output: variant.variant.output,
        pathTags: [],
        requestApis: [],
      }),
    });

    expect(decision).toMatchObject({
      canReuse: false,
      kind: "disabled",
      fallback: {
        code: "CP_MODEL_DISABLED",
        mode: "renderFresh",
        scope: "affectedOutput",
      },
    });
  });

  it("classifies public request observations as public variant dimensions", () => {
    const observation = buildRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "public",
      cacheTags: [],
      completeness: "complete",
      dynamicFetches: [],
      output: {
        kind: "app-html",
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/products/:id",
      },
      pathTags: ["/products/1"],
      requestApis: [
        { kind: "params", status: "observed" },
        { kind: "searchParams", status: "observed" },
      ],
    });

    expect(observation.downgrade).toEqual(classifyRenderObservationDowngrade(observation));
    expect(observation.downgrade).toMatchObject({
      isPublicCacheCandidate: true,
      target: "publicVariant",
      fallback: null,
    });
    expect(observation.downgrade.reasons.map((reason) => reason.code)).toEqual([
      "CP_DOWNGRADE_PUBLIC_REQUEST_API",
      "CP_DOWNGRADE_PUBLIC_REQUEST_API",
    ]);
  });

  it("classifies private auth draft and session dimensions without enabling public reuse", () => {
    expect(classifyCacheVariantDimensionDowngrade({ source: "auth" })).toEqual({
      code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
      inputClass: "auth",
      source: "auth",
      target: "private",
    });
    expect(classifyCacheVariantDimensionDowngrade({ source: "session" })).toEqual({
      code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
      inputClass: "session",
      source: "session",
      target: "private",
    });
    expect(classifyCacheVariantDimensionDowngrade({ source: "draft-mode" })).toEqual({
      code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
      inputClass: "draft",
      source: "draft-mode",
      target: "privateUncacheable",
    });
    expect(classifyCacheVariantDimensionDowngrade({ source: "cookie" })).toEqual({
      code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
      inputClass: "private",
      source: "cookie",
      target: "private",
    });
    expect(classifyCacheVariantDimensionDowngrade({ source: "header" })).toEqual({
      code: "CP_DOWNGRADE_PRIVATE_DIMENSION",
      inputClass: "private",
      source: "header",
      target: "private",
    });
    expect(classifyCacheVariantDimensionDowngrade({ source: "params" })).toBeNull();
    expect(classifyCacheVariantDimensionDowngrade({ source: "search" })).toBeNull();
  });

  it("classifies private request API observations away from public cache", () => {
    const observation = buildRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "public",
      cacheTags: [],
      completeness: "complete",
      dynamicFetches: [],
      output: {
        kind: "app-rsc",
        mountedSlotsFingerprint: null,
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/account",
      },
      pathTags: ["/account"],
      requestApis: [
        { kind: "cookies", status: "observed" },
        { kind: "draftMode", status: "observed" },
        { kind: "headers", status: "observed" },
      ],
    });

    expect(observation.downgrade).toMatchObject({
      isPublicCacheCandidate: false,
      target: "privateUncacheable",
      fallback: {
        code: "CP_PRIVATE_DYNAMIC_DOWNGRADE",
        mode: "privateUncacheable",
        scope: "affectedOutput",
      },
    });
    expect(observation.downgrade.reasons).toEqual([
      {
        code: "CP_DOWNGRADE_PRIVATE_REQUEST_API",
        requestApi: "cookies",
        target: "private",
      },
      {
        code: "CP_DOWNGRADE_DRAFT_MODE",
        requestApi: "draftMode",
        target: "privateUncacheable",
      },
      {
        code: "CP_DOWNGRADE_PRIVATE_REQUEST_API",
        requestApi: "headers",
        target: "private",
      },
    ]);
  });

  it("classifies dynamic and incomplete observations as fresh-render downgrades", () => {
    const observation = buildRenderObservation({
      boundaryOutcome: { kind: "success" },
      cacheability: "unknown",
      cacheTags: [],
      completeness: "partial",
      dynamicFetches: ["https://api.example.test/live?token=secret"],
      output: {
        kind: "app-rsc",
        mountedSlotsFingerprint: null,
        renderEpoch: null,
        rootBoundaryId: "layout:/",
        routeId: "route:/live",
      },
      pathTags: ["/live"],
      requestApis: [{ kind: "connection", status: "observed" }],
    });

    expect(observation.downgrade).toMatchObject({
      isPublicCacheCandidate: false,
      target: "freshRender",
      fallback: {
        code: "CP_PRIVATE_DYNAMIC_DOWNGRADE",
        mode: "renderFresh",
        scope: "affectedOutput",
      },
    });
    expect(observation.downgrade.reasons.map((reason) => reason.code)).toEqual([
      "CP_DOWNGRADE_CACHEABILITY_UNKNOWN",
      "CP_DOWNGRADE_INCOMPLETE_OBSERVATION",
      "CP_DOWNGRADE_DYNAMIC_FETCH",
      "CP_DOWNGRADE_DYNAMIC_REQUEST_API",
    ]);
    expect(JSON.stringify(observation.downgrade)).not.toContain("secret");
  });
});
