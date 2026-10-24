/**
 * Loopguard tests: the degenerate-repetition failure mode found 2026-10-23
 * (DeepSeek V4.1 on DeepInfra at ~520k cached context).
 *
 * The corpus facts these pin down:
 * - The real loop text is short imperative sentences repeated 39–100× within
 *   one assistant text part ("Let me do it.", "OK.", "Running:"...), sometimes
 *   ending in an apology that promises a tool call that never comes.
 * - A valid detection is exactly the 6 loop messages out of 688 in that
 *   session; every other assistant text (prose, code, tables, logs) must pass
 *   clean. The false-positive assertions below replay realistic non-loop
 *   shapes of comparable length and structure.
 */

import { describe, expect, test } from "bun:test"
import { collapseLoop, detectLoop, isLooping } from "../src/loopguard.ts"

const loopBlock = (line: string, n: number, head?: string) =>
  `${head ? head + "\n\n" : ""}${Array.from({ length: n }, () => line).join("\n")}`

describe("detectLoop", () => {
  test("flags the real corpus shape: one line repeated 39–100×", () => {
    const s = detectLoop(loopBlock("Let me do it.", 100))
    expect(s.looping).toBe(true)
    expect(s.reason).toBe("line-repeat")
    expect(s.repeats).toBe(100)
  })

  test("flags near-flat vocabulary below the per-line threshold", () => {
    // 11 distinct short lines rotated exactly 7 times over 77 lines: max
    // repeats = 7 (below the per-line threshold), but the unique ratio (~0.14)
    // is far below any legitimate document.
    const lines = ["Let me do it.", "OK.", "Running:", "Let me grep.", "Let me run.", "Let me check.", "Let me view.", "Let me look.", "Let me proceed.", "Let me wait.", "Let me run it."]
    const text = Array.from({ length: 77 }, (_, i) => lines[i % lines.length]).join("\n")
    const s = detectLoop(text)
    expect(s.looping).toBe(true)
    expect(s.reason).toBe("low-unique")
    expect(s.uniqueRatio).toBeLessThan(0.15)
    expect(s.repeats).toBeLessThan(8)
  })

  test("keeps the head of the real Q31 loop: intent line + filler tail", () => {
    const head = "Now let me update the Q31 entry to reflect the backfill completion and the gap, then commit."
    const s = detectLoop(`${head}\n\n${loopBlock("Let me do it.", 60)}`)
    expect(s.looping).toBe(true)
  })

  test("declines short text even when repetitive", () => {
    expect(isLooping(loopBlock("Let me do it.", 5))).toBe(false)
  })

  test("declines normal prose with varied lines", () => {
    const prose = Array.from(
      { length: 40 },
      (_, i) => `Paragraph ${i} discusses the observation ${i} in detail with supporting numbers ${i * 7}.`,
    ).join("\n")
    const s = detectLoop(prose)
    expect(s.looping).toBe(false)
  })

  test("declines source code (loops in control flow, long lines, high diversity)", () => {
    const code = Array.from({ length: 80 }, (_, i) => `  const value_${i} = compute(${i}, { deep: { nested: ${i} } })`).join("\n")
    expect(isLooping(code)).toBe(false)
  })

  test("declines a markdown table with repeated structure but varied cells", () => {
    const table = Array.from({ length: 60 }, (_, i) => `| row ${i} | metric_${i} | ${i * 3}.5 | note ${i} |`).join("\n")
    expect(isLooping(table)).toBe(false)
  })

  test("declines a repeated separator heading in a long document", () => {
    // A doc with section headers repeating a handful of distinct lines is the
    // closest legitimate shape to the low-unique path; below 15% unique it
    // would fire, so verify a realistic doc stays above it.
    const doc = Array.from({ length: 40 }, (_, i) => [`## Section ${i}`, "Body text about section " + i + ".", "More detail " + i + "."].join("\n")).join("\n\n")
    expect(isLooping(doc)).toBe(false)
  })

  test("declines a tool-result log dump with a repeated wrapper", () => {
    const log = Array.from(
      { length: 50 },
      (_, i) => `2026-10-23T20:0${i % 10}:00 WARNING stock_watch.edgar: edgar backoff 1.0s after EdgarError (https://www.sec.gov/Archives/edgar/data/${i}/index.json)`,
    ).join("\n")
    expect(isLooping(log)).toBe(false)
  })
})

describe("collapseLoop", () => {
  test("keeps the leading intent line and appends the suppression marker", () => {
    const head = "Now let me update the Q31 entry, then commit."
    const out = collapseLoop(`${head}\n\n${loopBlock("Let me do it.", 60)}`, detectLoop("x".repeat(0) + loopBlock("Let me do it.", 60)))
    expect(out).toContain(head)
    expect(out).toContain("loop suppressed")
    expect(out).toContain("repeated 60×")
    // The filler tail must be gone.
    expect(out.endsWith("Let me do it.")).toBe(false)
  })

  test("caps a pathological head so filler cannot smuggle back in", () => {
    const longHead = "x".repeat(5000)
    const out = collapseLoop(longHead, { looping: true, reason: "line-repeat", repeats: 10, length: 6000 })
    expect(out.length).toBeLessThan(600)
  })
})
