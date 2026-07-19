import { describe, expect, it } from "vitest"
import { classifyAppServerModelOrigin } from "../../../src/native/app-server/provider-readiness-service.js"

describe("classifyAppServerModelOrigin", () => {
  it("reports loopback runtimes as local and remote provider endpoints as cloud", () => {
    expect(classifyAppServerModelOrigin("http://localhost:8066/v1")).toBe("local")
    expect(classifyAppServerModelOrigin("http://127.0.0.1:11434/v1")).toBe("local")
    expect(classifyAppServerModelOrigin("https://api.kimi.com/coding/v1")).toBe("cloud")
    expect(classifyAppServerModelOrigin(undefined)).toBe("unknown")
  })
})
