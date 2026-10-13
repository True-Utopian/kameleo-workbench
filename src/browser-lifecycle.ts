interface BrowserConnection {
  readonly connected: boolean;
  on(event: 'disconnected', listener: () => void): unknown;
  off(event: 'disconnected', listener: () => void): unknown;
}

/** An idle automation must also fail when its Browser-owned connection exits. */
export async function withBrowserConnection<T>(browser: BrowserConnection, operation: () => Promise<T>, onDisconnect: () => void): Promise<T> {
  let rejectLoss!: (error: Error) => void;
  const loss = new Promise<never>((_resolve, reject) => { rejectLoss = reject; });
  const disconnected = () => {
    let failure = new Error('Browser connection ended before automation completed');
    try { onDisconnect(); }
    catch (cause) { failure = new Error('Browser connection ended; cancellation failed', { cause }); }
    rejectLoss(failure);
  };
  browser.on('disconnected', disconnected);
  try {
    if (!browser.connected) disconnected();
    return await Promise.race([loss, Promise.resolve().then(() => {
      if (!browser.connected) throw new Error('Browser connection is no longer available');
      return operation();
    })]);
  } finally { browser.off('disconnected', disconnected); }
}
