"""Money is stored as integer paisa (1 PKR = 100 paisa). Never use floats."""
from decimal import Decimal, ROUND_HALF_UP

CURRENCY = "PKR"


def rupees_to_paisa(value: str | Decimal) -> int:
    """Parse a rupee string like '125.50' into integer paisa."""
    d = Decimal(str(value))
    if d < 0:
        raise ValueError("amount cannot be negative")
    return int((d * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def format_pkr(paisa: int) -> str:
    sign = "-" if paisa < 0 else ""
    paisa = abs(paisa)
    return f"{sign}Rs {paisa // 100:,}.{paisa % 100:02d}"
