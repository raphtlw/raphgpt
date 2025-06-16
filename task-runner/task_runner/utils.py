import re


def safe_filename(name: str) -> str:
    """
    Sanitize a string so it is safe to use as a filename by replacing
    illegal characters with underscores.
    """
    return re.sub(r'[\\/:*?"<>|]', "_", name)
