"""Order lifecycle. Every transition is explicit: who may do it, from where.

Payment-driven transitions can only be triggered by the 'system' actor after
server-side verification, never by a student or staff member.
"""
from enum import Enum


class OrderStatus(str, Enum):
    AWAITING_PAYMENT = "AWAITING_PAYMENT"
    PAYMENT_PENDING = "PAYMENT_PENDING"
    PAYMENT_FAILED = "PAYMENT_FAILED"
    SUBMITTED = "SUBMITTED"        # paid and visible to staff
    ACCEPTED = "ACCEPTED"
    PREPARING = "PREPARING"
    READY = "READY"
    COLLECTED = "COLLECTED"
    CANCELLED = "CANCELLED"
    REFUND_PENDING = "REFUND_PENDING"
    PARTIALLY_REFUNDED = "PARTIALLY_REFUNDED"
    REFUNDED = "REFUNDED"


S = OrderStatus
# (from, to) -> roles allowed to trigger it
TRANSITIONS: dict[tuple[S, S], set[str]] = {
    (S.AWAITING_PAYMENT, S.PAYMENT_PENDING): {"system"},
    (S.PAYMENT_PENDING, S.PAYMENT_FAILED): {"system"},
    (S.PAYMENT_FAILED, S.PAYMENT_PENDING): {"system"},   # retry
    (S.PAYMENT_PENDING, S.SUBMITTED): {"system"},        # verified payment only
    (S.AWAITING_PAYMENT, S.CANCELLED): {"student", "manager", "owner"},
    (S.PAYMENT_FAILED, S.CANCELLED): {"student", "manager", "owner", "system"},
    (S.SUBMITTED, S.ACCEPTED): {"staff", "manager", "owner"},
    (S.SUBMITTED, S.CANCELLED): {"manager", "owner"},    # triggers refund flow
    (S.ACCEPTED, S.PREPARING): {"staff", "manager", "owner"},
    (S.ACCEPTED, S.CANCELLED): {"manager", "owner"},
    (S.PREPARING, S.READY): {"staff", "manager", "owner"},
    (S.READY, S.COLLECTED): {"staff", "manager", "owner"},
    (S.CANCELLED, S.REFUND_PENDING): {"system", "manager", "owner"},
    (S.COLLECTED, S.REFUND_PENDING): {"manager", "owner"},
    (S.REFUND_PENDING, S.PARTIALLY_REFUNDED): {"system"},  # provider-confirmed
    (S.REFUND_PENDING, S.REFUNDED): {"system"},
    (S.PARTIALLY_REFUNDED, S.REFUND_PENDING): {"manager", "owner"},
}


class InvalidTransition(Exception):
    pass


def check_transition(current: S, target: S, actor_role: str) -> None:
    allowed = TRANSITIONS.get((current, target))
    if allowed is None:
        raise InvalidTransition(f"{current.value} -> {target.value} is not allowed")
    if actor_role not in allowed:
        raise InvalidTransition(f"role {actor_role!r} cannot do {current.value} -> {target.value}")
