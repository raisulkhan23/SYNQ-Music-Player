import { type InputHTMLAttributes, forwardRef } from "react"

export interface HaloSearchInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "ref"> {
  loading?: boolean
  blobTranslucent?: boolean
}

export const HaloSearchInput = forwardRef<HTMLInputElement, HaloSearchInputProps>(
  function HaloSearchInput(props, ref) {
    return <input ref={ref} {...props} />
  },
)
