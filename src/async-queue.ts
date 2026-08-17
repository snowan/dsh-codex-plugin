interface Waiter<T> {
  resolve: (value: T) => void
  reject: (reason: unknown) => void
  cleanup: () => void
}

export class AsyncQueue<T> {
  readonly #values: T[] = []
  readonly #waiters: Waiter<T>[] = []

  push(value: T): void {
    const waiter = this.#waiters.shift()
    if (waiter !== undefined) {
      waiter.cleanup()
      waiter.resolve(value)
      return
    }
    this.#values.push(value)
  }

  poll(): T | undefined {
    return this.#values.shift()
  }

  take(signal?: AbortSignal): Promise<T> {
    const value = this.#values.shift()
    if (value !== undefined) return Promise.resolve(value)
    if (signal?.aborted === true) return Promise.reject(signal.reason)

    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.#waiters.indexOf(waiter)
        if (index >= 0) this.#waiters.splice(index, 1)
        reject(signal?.reason)
      }
      const waiter: Waiter<T> = {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      }
      this.#waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}
