"""Provider-independent payment interface. Each provider gets its own adapter.

No adapter may report success from a browser redirect. Success only comes from
verify_webhook() or get_status(), i.e. data verified with the provider.
"""
import hashlib
import hmac
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum


class PaymentStatus(str, Enum):
    PENDING = "PENDING"
    PAID = "PAID"
    FAILED = "FAILED"
    EXPIRED = "EXPIRED"


class ProviderNotConfigured(Exception):
    """Raised instead of ever pretending a payment worked."""


@dataclass(frozen=True)
class VerifiedEvent:
    event_id: str            # used for idempotency
    provider_reference: str
    status: PaymentStatus
    amount_paisa: int
    currency: str


class PaymentProvider(ABC):
    name: str

    @abstractmethod
    def create_checkout(self, order_id: str, amount_paisa: int, idempotency_key: str) -> str:
        """Return the provider's hosted-checkout URL."""

    @abstractmethod
    def get_status(self, provider_reference: str) -> PaymentStatus: ...

    @abstractmethod
    def verify_webhook(self, raw_body: bytes, headers: dict) -> VerifiedEvent:
        """Raise on bad signature. Must use the RAW body bytes."""


class NotConfiguredProvider(PaymentProvider):
    name = "none"

    def create_checkout(self, *a, **k):
        raise ProviderNotConfigured("Digital payments are not yet available.")

    def get_status(self, *a, **k):
        raise ProviderNotConfigured("Digital payments are not yet available.")

    def verify_webhook(self, *a, **k):
        raise ProviderNotConfigured("Digital payments are not yet available.")


def hmac_hex_matches(secret: str, message: bytes, received_hex: str, algo=hashlib.sha256) -> bool:
    """Constant-time HMAC check. Which algorithm and message a provider signs
    is provider-specific and must come from its official docs."""
    expected = hmac.new(secret.encode(), message, algo).hexdigest()
    return hmac.compare_digest(expected, received_hex.lower())
