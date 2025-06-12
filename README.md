<p align="center">
  <img src=".github/images/botpic-transparent.png" alt="Bot profile picture" height="300" />
</p>

<br />

This is raphGPT, a multi-modal Telegram bot built on top of the OpenAI API as a tool that @raphtlw can use to make tasks and communication move faster.

## Develop

Prerequisites:

- [Docker Desktop](https://www.docker.com/)
- [Bun for VSCode](https://marketplace.visualstudio.com/items?itemName=oven.bun-vscode)
- [Bun](https://bun.sh/)

## System requirements

| Requirement                 | Details                                                         |
| --------------------------- | --------------------------------------------------------------- |
| Operating systems           | macOS 12+, Ubuntu 20.04+/Debian 10+, or Windows 11 **via WSL2** |
| Bun                         | **v1.2 or newer** (Latest recommended)                          |
| RAM                         | 2-GB minimum (4-GB recommended)                                 |

To develop effectively with proper autocomplete, you need to install dependencies:

```shell
cd telegram-bot
bun install
```

Launch a new terminal in the root of this project and run:

```shell
docker compose watch
```

It should start building Dockerfiles in telegram-bot and video-parser.

Auto-refreshes when changes are made.

## Contributing

Make a PR and I will review it.
