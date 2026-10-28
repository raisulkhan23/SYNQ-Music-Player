"use client"

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"

import { Button } from "@/components/ui/button"
import { HaloSearchInput } from "./HaloSearch"

/** How long the demo keeps `isLoading` true; wire your real request the same way. */
const MOCK_LOADING_MS = 4800

/** Optional: tune loading line motion from the parent (defaults are already slower than placeholder). */
const LOADING_STAGGER_SEC = 0.044
const LOADING_CHAR_DURATION_SEC = 0.42

export default function HaloSearchDemo() {
  const [searchValue, setSearchValue] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [blobTranslucent, setBlobTranslucent] = useState(false)
  /** Browser timer id (`window.setTimeout`); avoid `NodeJS.Timeout` mismatch in tsc with `@types/node`. */
  const loadTimerRef = useRef<number | null>(null)
  const haloSearchRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    return () => {
      if (loadTimerRef.current) clearTimeout(loadTimerRef.current)
    }
  }, [])

  const runSearch = useCallback(() => {
    if (!searchValue.trim()) return
    setIsLoading(true)
    if (loadTimerRef.current) clearTimeout(loadTimerRef.current)
    loadTimerRef.current = window.setTimeout(() => {
      setIsLoading(false)
    }, MOCK_LOADING_MS)
  }, [searchValue])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter" && !isLoading) {
        runSearch()
      }
    },
    [isLoading, runSearch],
  )

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={haloSearchRef}
        className="relative"
        onKeyDown={handleKeyDown}
      >
        <HaloSearchInput
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          placeholder="Search tracks..."
          disabled={isLoading}
          loading={isLoading}
          blobTranslucent={blobTranslucent}
        />
      </div>

      <div className="flex gap-2">
        <Button variant="outline" onClick={runSearch} disabled={isLoading || !searchValue.trim()}>
          Search
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setBlobTranslucent((v) => !v)}
        >
          Toggle blob translucent
        </Button>
      </div>
    </div>
  )
}
