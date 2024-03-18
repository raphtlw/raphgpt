"""
RaphGPT function set for MemGPT.
"""

import os

import requests
from memgpt.agent import Agent
from requests.exceptions import HTTPError


def google_search(self: Agent, query: str) -> dict:
    """
    A tool to search google with the provided query, and return a list of relevant summaries and URLs.

    Args:
        query (str): The search query.

    Returns:
        dict: Search results from Google
    """

    cx = os.getenv("GOOGLE_CUSTOM_SEARCH_ENGINE_ID")
    key = os.getenv("GOOGLE_CUSTOM_SEARCH_API_KEY")

    data = requests.get(
        f"https://customsearch.googleapis.com/customsearch/v1?cx={cx}&key={key}&q={query}"
    ).json()

    search_results = []
    for link in data["items"]:
        search_results.append(
            {"title": link["title"], "link": link["link"], "snippet": link["snippet"]}
        )

    return search_results


def uncensored_moderative_ai(self: Agent, message: str):
    """
    Send a message to Llama2, a self-moderating AI model which responds with more accurate data.
    Llama2 does not retain memory of previous interactions.

    Args:
        message (str): Prompt to send Llama2. Phrase your message as a full sentence.
    Returns:
        str: Reply message from Llama2
    """

    ollama_url = "http://host.docker.internal:11434"

    response = requests.post(
        f"{ollama_url}/api/chat",
        json={
            "model": "llama2-uncensored",
            "messages": [{"role": "user", "content": message}],
            "stream": False,
        },
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )

    if response.status_code >= 400:
        raise HTTPError(response.json())

    data = response.json()

    return str(data["message"]["content"]).strip()
