// Minimal usePasteHandler — wraps onInput without paste detection
export function usePasteHandler(opts: {
  onPaste?: (text: string) => void
  onInput: (input: string, key: any) => void
  onImagePaste?: (...args: any[]) => void
}): { wrappedOnInput: (input: string, key: any) => void; isPasting: boolean } {
  return {
    wrappedOnInput: opts.onInput,
    isPasting: false,
  }
}
