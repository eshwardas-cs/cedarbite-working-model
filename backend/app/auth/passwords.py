"""Password hashing with Argon2id (argon2-cffi defaults are Argon2id)."""
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher()


def check_password_policy(password: str) -> None:
    if len(password) < 10:
        raise ValueError("Password must be at least 10 characters.")
    if len(password) > 128:
        raise ValueError("Password must be at most 128 characters.")
    if not password.strip():
        raise ValueError("Password cannot be only spaces.")


def hash_password(password: str) -> str:
    check_password_policy(password)
    return _hasher.hash(password)


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        return _hasher.verify(stored_hash, password)
    except (VerificationError, InvalidHashError):
        return False


# Verified against when an email is unknown, so timing doesn't reveal which emails exist.
DUMMY_HASH = _hasher.hash("not-a-real-password-value")
