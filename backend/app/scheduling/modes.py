"""Quick vs Scheduled fulfilment for a cart with mixed item types.

If every item allows Quick, the order is Quick. Otherwise, the order is
Scheduled: quick-ready items can be held with prepared items for the selected
pickup window.
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
    if all(i.scheduled_allowed or i.quick_allowed for i in items):
        return Mode.SCHEDULED
    raise NoValidMode("an item allows neither mode")
