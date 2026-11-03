"""Login attempt limiting. In-memory: resets on restart and is per-process.
For several server workers, move this to the database or Redis (see docs/security.md)."""
import time


class AttemptLimiter:
    def __init__(self, max_failures: int, window_seconds: int, clock=time.monotonic):
        self.max_failures, self.window, self.clock = max_failures, window_seconds, clock
        self._fails: dict[str, list[float]] = {}

    def _prune(self, key):
        cutoff = self.clock() - self.window
        kept = [t for t in self._fails.get(key, []) if t > cutoff]
        if kept:
            self._fails[key] = kept
        else:
            self._fails.pop(key, None)
        return kept

    def blocked(self, key: str) -> bool:
        return len(self._prune(key)) >= self.max_failures

    def record_failure(self, key: str) -> None:
        self._prune(key)
        self._fails.setdefault(key, []).append(self.clock())

    def reset(self, key: str) -> None:
        self._fails.pop(key, None)


class LoginLimits:
    """Limit per email (stops guessing one account) and per IP (stops spraying many)."""
    def __init__(self, clock=time.monotonic):
        self.by_email = AttemptLimiter(5, 15 * 60, clock)
        self.by_ip = AttemptLimiter(30, 15 * 60, clock)

    def blocked(self, email: str, ip: str) -> bool:
        return self.by_email.blocked(email) or self.by_ip.blocked(ip)

    def failure(self, email: str, ip: str) -> None:
        self.by_email.record_failure(email)
        self.by_ip.record_failure(ip)

    def success(self, email: str) -> None:
        self.by_email.reset(email)
