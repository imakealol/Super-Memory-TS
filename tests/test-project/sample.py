"""
Sample Python file for testing
"""

from dataclasses import dataclass
from typing import Optional, List


@dataclass
class User:
    """User data class"""
    id: str
    name: str
    email: str
    
    def to_dict(self) -> dict:
        return {
            'id': self.id,
            'name': self.name,
            'email': self.email
        }


class UserRepository:
    """Repository for user data access"""
    
    def __init__(self):
        self._users: dict[str, User] = {}
    
    def find_by_id(self, user_id: str) -> Optional[User]:
        return self._users.get(user_id)
    
    def save(self, user: User) -> None:
        self._users[user.id] = user
    
    def delete(self, user_id: str) -> bool:
        if user_id in self._users:
            del self._users[user_id]
            return True
        return False
    
    def list_all(self) -> List[User]:
        return list(self._users.values())


def validate_email(email: str) -> bool:
    """Validate email format"""
    import re
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return bool(re.match(pattern, email))


def create_default_user() -> User:
    """Create a default user"""
    return User(
        id="default-001",
        name="Default User",
        email="default@example.com"
    )


DEFAULT_CONFIG = {
    'page_size': 25,
    'max_results': 100,
    'timeout': 30
}
