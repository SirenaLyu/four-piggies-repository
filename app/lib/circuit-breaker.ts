export type CircuitBreakerState = {
  failures: number;
  openUntil: number;
};

export function createCircuitBreaker(threshold: number, cooldownMs: number) {
  const state: CircuitBreakerState = { failures: 0, openUntil: 0 };

  return {
    canRequest(now = Date.now()) {
      return state.openUntil <= now;
    },
    recordSuccess() {
      state.failures = 0;
      state.openUntil = 0;
    },
    recordFailure(now = Date.now()) {
      state.failures += 1;
      if (state.failures >= threshold) state.openUntil = now + cooldownMs;
    },
    snapshot(): CircuitBreakerState {
      return { ...state };
    },
  };
}
