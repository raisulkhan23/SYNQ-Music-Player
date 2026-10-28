import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
  type SVGProps,
} from "react"
import { Check, File, FileText, Upload, X } from "lucide-react"
import { DropzoneCardRimBlobs } from "./DropzoneCardRimBlobs"
import { DropzoneBody } from "./DropzoneBody"
import { DropzoneCardBorderTrail } from "./DropzoneCardBorderTrail"
import { dropzoneSurfaceClassNames } from "./dropzoneSurfaceClassNames"
import { motion } from "framer-motion"

import { cn } from "@/lib/utils"

export interface HaloDropzoneProps {
  className?: string
  accept?: string
  multiple?: boolean
  disabled?: boolean
  translucent?: boolean
  onFiles?: (files: File[]) => void
  successResetMs?: number
  emptyLabel?: string
  successLabel?: string
  idleIcon?: React.ReactNode
  formatHint?: string | null
  showSuccessThumbnails?: boolean
}

export function HaloDropzone({
  className,
  accept,
  multiple = false,
  disabled = false,
  translucent = true,
  onFiles,
  successResetMs = 2400,
  emptyLabel = "Drop files here or browse",
  successLabel = "Upload complete",
  idleIcon,
  formatHint = "PNG, JPG, PDF up to 10MB",
  showSuccessThumbnails = true,
}: HaloDropzoneProps) {
  const reduceMotion = false
  const inputId = useId()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const successTimerRef = useRef<number | null>(null)
  const [pendingUrlCleanup, setPendingUrlCleanup] = useState(false)

  const [isDragging, setIsDragging] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([])
  const [isHovered, setIsHovered] = useState(false)
  const [isFocused, setIsFocused] = useState(false)

  const ariaFileSummary = useMemo(() => {
    if (uploadedFiles.length === 0) return ''
    if (uploadedFiles.length === 1) return uploadedFiles[0]?.name ?? ''
    return `${uploadedFiles.length} files: ${uploadedFiles.map((f) => f.name).join(', ')}`
  }, [uploadedFiles])

  const cf = useMemo(() => undefined, [reduceMotion])
  const cfTransition = useMemo(() => undefined, [reduceMotion])

  const interactive = !disabled
  const rimEmphasis = interactive && (isHovered || isFocused || isDragging || showSuccess)

  const borderGlow = useMemo(() => ({}), [translucent, rimEmphasis])

  const fillBackground = useMemo(() => "", [translucent, interactive, rimEmphasis])

  const showTrailChrome = interactive && !reduceMotion
  const trailActive = interactive && (isHovered || isFocused || isDragging)

  useEffect(() => {
    return () => {
      if (successTimerRef.current) window.clearTimeout(successTimerRef.current)  }
}
, [])

  const imageObjectUrls = useMemo(() => {
    const next: Record<string, string> = {}
    for (const f of uploadedFiles) {
      const k = f.name
      if (f.type.startsWith('image/')) next[k] = URL.createObjectURL(f)
    }
    return next
  }, [uploadedFiles])

  useEffect(() => {
    const urls = imageObjectUrls
    return () => {
      for (const u of Object.values(urls)) URL.revokeObjectURL(u)  }
}
, [imageObjectUrls])

  const emitFiles = useCallback((list: FileList | File[] | null) => {
    if (!list || disabled) return
    const files = Array.from(list)
    if (files.length === 0) return
    onFiles?.(files)
    setUploadedFiles(files)
    setShowSuccess(true)
    if (successResetMs > 0) {
      if (successTimerRef.current) window.clearTimeout(successTimerRef.current)
      successTimerRef.current = window.setTimeout(() => {
        setShowSuccess(false)
        setUploadedFiles([])
        successTimerRef.current = null
      }, successResetMs)  }
}
, [disabled, onFiles, successResetMs])

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    emitFiles(e.target.files)
    e.target.value = ''
  }

  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (disabled) return
    dragDepth.current += 1
    setIsDragging(true)
  }

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setIsDragging(false)
  }

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!disabled) e.dataTransfer.dropEffect = 'copy'
  }

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth.current = 0
    setIsDragging(false)
    if (disabled) return
    emitFiles(e.dataTransfer.files)
  }

  const openPicker = () => {
    if (disabled) return
    fileInputRef.current?.click()
  }

  return (
    <div className={cn("relative w-full max-w-2xl", className)}>
      <input
        accept={accept}
        className="sr-only"
        disabled={disabled}
        id={inputId}
        multiple={multiple}
        onChange={handleInputChange}
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
      />
      <label
        aria-disabled={disabled || undefined}
        aria-label={showSuccess && ariaFileSummary ? `${successLabel}: ${ariaFileSummary}` : emptyLabel}
        className={cn(
          "relative block cursor-pointer rounded-2xl outline-none",
          "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          disabled && "pointer-events-none cursor-not-allowed opacity-60"
        )}
        htmlFor={inputId}
        onBlur={() => setIsFocused(false)}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onFocus={() => setIsFocused(true)}
        onKeyDown={(e) => {
          if (disabled) return
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            openPicker()
          }
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        tabIndex={disabled ? -1 : 0}
      >
        <div className="relative rounded-2xl p-px">
          <DropzoneCardRimBlobs borderGlow={borderGlow} reduceMotion={reduceMotion} />
          <div className={dropzoneSurfaceClassNames(interactive, translucent, isDragging)} style={{ background: fillBackground }}>                                          <DropzoneBody
              cf={cf}
              cfTransition={cfTransition}
              disabled={disabled}
              emptyLabel={emptyLabel}
              formatHint={formatHint}
              idleIcon={idleIcon}
              imageObjectUrls={imageObjectUrls}
              reduceMotion={reduceMotion}
              showSuccess={showSuccess}
              showSuccessThumbnails={showSuccessThumbnails}
              successLabel={successLabel}
              uploadedFiles={uploadedFiles}
            />
          </div>
          {showTrailChrome ? (
            <div className="pointer-events-none absolute inset-0 z-10 rounded-2xl">
              <DropzoneCardBorderTrail active={trailActive} />
            </div>          ) : null}
        </div>
      </label>
    </div>
  )
}
