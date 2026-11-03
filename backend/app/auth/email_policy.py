import re


_CEDAR_STUDENT_EMAIL = re.compile(r"^(?P<student_id>\d{7})@cedar\.edu\.pk$", re.IGNORECASE)


def normalize_email(email: str) -> str:
    return email.strip().lower()


def student_id_from_email(email: str) -> str | None:
    """Derive the Cedar student ID without keeping a second copy of the identifier."""
    match = _CEDAR_STUDENT_EMAIL.fullmatch(normalize_email(email))
    return match.group("student_id") if match else None


def email_domain_allowed(email: str, allowed_domain: str) -> bool:
    """Exact-match domain check. Fails closed if no domain is configured."""
    allowed = allowed_domain.strip().lower()
    parts = normalize_email(email).split("@")
    if not allowed or len(parts) != 2 or not parts[0]:
        return False
    return parts[1] == allowed
