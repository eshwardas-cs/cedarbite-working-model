import enum


class Role(str, enum.Enum):
    OWNER = "owner"
    COLLEGE_ADMIN = "college_admin"
    MANAGER = "manager"
    STAFF = "staff"
    STUDENT = "student"
    STAFF_CUSTOMER = "staff_customer"
