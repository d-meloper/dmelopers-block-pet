/** One webview owns one native visibility queue. A late show must finish before a newer hide. */
export function createWindowVisibilityQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = tail.catch(() => {}).then(operation)
    tail = pending
    return pending
  }
}
