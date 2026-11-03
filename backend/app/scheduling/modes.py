"""Quick vs Scheduled fulfilment, and the mixed-cart rule.

Initial-release decision (docs/decisions.md): a cart where every item allows
Quick is a Quick Order and needs no pickup slot. Otherwise, if every item
allows Scheduled, the WHOLE order is Scheduled and needs a slot. If neither
works, the student is asked to split the order. Nothing is silently guessed.
"""
from dataclasses import dataclass
from enum import Enum


class Mode(str, Enum):
    QUICK = "QUICK"
    SCHEDULED = "SCHEDULED"


@dataclass(frozen=True)
class ItemRules:
    quick_allowed: bool
    scheduled_allowed: bool


class NoValidMode(Exception):
    pass


def resolve_order_mode(items: list[ItemRules]) -> Mode:
    if not items:
        raise NoValidMode("empty cart")
    if any(not i.quick_allowed and not i.scheduled_allowed for i in items):
        raise NoValidMode("an item allows neither mode")
    if all(i.quick_allowed for i in items):
        return Mode.QUICK
    if all(i.scheduled_allowed for i in items):
        return Mode.SCHEDULED
    raise NoValidMode("cart items cannot share a fulfilment mode; split the order")
