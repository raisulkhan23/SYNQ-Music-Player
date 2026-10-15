export interface HaloDropzoneProps {
  className?: string;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  translucent?: boolean;
  onFiles?: (files: File[]) => void;
  successResetMs?: number;
  emptyLabel?: string;
  successLabel?: string;
  idleIcon?: React.ReactNode;
  formatHint?: string | null;
  showSuccessThumbnails?: boolean;
}

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { Upload, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export interface HaloDropzoneProps {
  className?: string;
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  translucent?: boolean;
  onFiles?: (files: File[]) => void;
  successResetMs?: number;
  emptyLabel?: string;
  successLabel?: string;
  idleIcon?: React.ReactNode;
  formatHint?: string | null;
  showSuccessThumbnails?: boolean;
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
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const successTimerRef = useRef<number | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  const ariaFileSummary = useMemo(() => {
    if (uploadedFiles.length === 0) return "";
    if (uploadedFiles.length === 1) return uploadedFiles[0]?.name ?? "";
    return `${uploadedFiles.length} files: ${uploadedFiles.map((f) => f.name).join(", ")}`;
  }, [uploadedFiles]);

  const interactive = !disabled;
  const highlighted = interactive && (isHovered || isFocused || isDragging || showSuccess);

  useEffect(() => {
    return () => {
      if (successTimerRef.current) window.clearTimeout(successTimerRef.current);
    };
  }, []);

  const imageObjectUrls = useMemo(() => {
    const next: Record<string, string> = {};
    for (const f of uploadedFiles) {
      if (f.type.startsWith("image/")) next[f.name] = URL.createObjectURL(f);
    }
    return next;
  }, [uploadedFiles]);

  useEffect(() => {
    const urls = imageObjectUrls;
    return () => {
      for (const u of Object.values(urls)) URL.revokeObjectURL(u);
    };
  }, [imageObjectUrls]);

  const emitFiles = useCallback(
    (list: FileList | File[] | null) => {
      if (!list || disabled) return;
      const files = Array.from(list);
      if (files.length === 0) return;
      onFiles?.(files);
      setUploadedFiles(files);
      setShowSuccess(true);
      if (successResetMs > 0) {
        if (successTimerRef.current) window.clearTimeout(successTimerRef.current);
        successTimerRef.current = window.setTimeout(() => {
          setShowSuccess(false);
          setUploadedFiles([]);
          successTimerRef.current = null;
        }, successResetMs);
      }
    },
    [disabled, onFiles, successResetMs],
  );

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    emitFiles(e.target.files);
    e.target.value = "";
  };

  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    dragDepth.current += 1;
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) e.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setIsDragging(false);
    if (disabled) return;
    emitFiles(e.dataTransfer.files);
  };

  const openPicker = () => {
    if (disabled) return;
    fileInputRef.current?.click();
  };

  const fileCount = uploadedFiles.length;
  const thumbnails = useMemo(() => {
    if (!showSuccessThumbnails || fileCount === 0) return null;
    return uploadedFiles.slice(0, 4);
  }, [uploadedFiles, showSuccessThumbnails]);

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
          "group relative block cursor-pointer rounded-2xl outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          disabled && "pointer-events-none cursor-not-allowed opacity-60",
          highlighted && "ring-2 ring-ring/30",
        )}
        htmlFor={inputId}
        onBlur={() => setIsFocused(false)}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onFocus={() => setIsFocused(true)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPicker();
          }
        }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        tabIndex={disabled ? -1 : 0}
      >
        <div
          className={cn(
            "relative rounded-2xl p-6 text-center transition-colors",
            isDragging && "bg-accent/10",
            !interactive && "cursor-not-allowed",
          )}
          style={translucent && interactive ? { background: "rgba(255, 255, 255, 0.03)" } : undefined}
        >
          {showSuccess && fileCount > 0 ? (
            <div className="flex flex-col items-center gap-2">
              <Check className="h-6 w-6 text-green-500" />
              <p className="text-sm font-medium">{successLabel}</p>
              {thumbnails ? (
                <div className="flex flex-wrap gap-2 mt-2 justify-center">
                  {thumbnails.map((f) => {
                    const url = imageObjectUrls[f.name];
                    if (!url) return null;
                    return (
                      <img
                        key={f.name}
                        src={url}
                        alt={f.name}
                        className="h-10 w-10 rounded-lg object-cover border border-border/40"
                      />
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {fileCount} file{fileCount === 1 ? "" : "s"}
                </p>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              {idleIcon ? (
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10 text-accent">
                  {idleIcon}
                </div>
              ) : (
                <Upload className="h-8 w-8 text-muted-foreground/60" />
              )}
              <div className="text-left">
                <p className="text-sm font-medium">{emptyLabel}</p>
                {formatHint ? (
                  <p className="mt-1 text-xs text-muted-foreground">{formatHint}</p>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </label>
    </div>
  );
}
