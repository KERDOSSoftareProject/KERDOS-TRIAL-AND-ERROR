// Backend-agnostic session policy. Authentication providers may emit refresh/recovery events;
// the UI receives a stable session transition instead of provider-specific navigation behavior.
export function createSessionController(sessionPort) {
  let subscription = null;
  let currentSession = undefined;
  let generation = 0;
  return {
    async start(onChange) {
      const myGeneration = ++generation;
      const initial = await sessionPort.get();
      if (myGeneration !== generation) return;
      currentSession = initial || null;
      onChange({ session: currentSession, entered: false, reason: "startup" });
      subscription = sessionPort.subscribe(({event,session}) => {
        if (myGeneration !== generation) return;
        const previous = currentSession;
        currentSession = session || null;
        const entered = !previous && !!currentSession && event === "SIGNED_IN";
        onChange({ session: currentSession, entered, reason: event });
      });
    },
    stop() {
      generation++;
      subscription?.();
      subscription = null;
    },
    get current() { return currentSession; },
  };
}
