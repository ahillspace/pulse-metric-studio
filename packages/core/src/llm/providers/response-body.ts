/** Keep the operation signal alive and enforce it even when an adapter stops forwarding aborts. */
export async function readProviderBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!signal) return reader.read();
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([reader.read(), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
