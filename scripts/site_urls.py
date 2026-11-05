"""Shared exclusion of authentication-flow artifacts from site inventories."""

import re
from urllib.parse import urlparse

JUNK_URL_QUERY = re.compile(r"execution=e\d+s\d+|ServiceLogin|test_login|[?&]token=", re.IGNORECASE)
JUNK_HOSTS = {"weblogin.umich.edu", "accounts.google.com", "shibboleth.umich.edu"}


def is_junk_url(url: str | None) -> bool:
    if not url:
        return False
    parsed = urlparse(url if "://" in url else "https://" + url)
    if (parsed.hostname or "").lower() in JUNK_HOSTS or parsed.username or parsed.password:
        return True
    return bool(JUNK_URL_QUERY.search(url))
