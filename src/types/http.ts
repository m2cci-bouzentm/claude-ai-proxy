export interface RequestCancellation {
  signal: AbortSignal
  abort: () => void
  touch: () => void
  dispose: () => void
}
