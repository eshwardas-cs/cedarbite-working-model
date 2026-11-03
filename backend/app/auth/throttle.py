import time


class LoginThrottle:
    """In-memory failed-login limiter (per process). Fine for one server;
    use a shared store (e.g. the database or Redis) if you run several."""

    def __init__(self, max_failures=5, window_seconds=900, clock=time.monotonic):
        self.max_failures = max_failures
        self.window = window_seconds
        self.clock = clock
        self._fails: dict[str, list[float]] = {}

    def _recent(self, key):
        now = self.clock()
        kept = [t for t in self._fails.get(key, []) if now - t < self.window]
        self._fails[key] = kept
        return kept

    def blocked(self, key: str) -> bool:
        return len(self._recent(key)) >= self.max_failures

    def record_failure(self, key: str) -> None:
        self._recent(key).append(self.clock())

    def reset(self, key: str) -> None:
        self._fails.pop(key, None)
