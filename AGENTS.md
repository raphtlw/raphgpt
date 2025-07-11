# Components

- telegram-bot: actual hosted Telegram Bot
- video-parser: to extract and process videos for LLM input
- task-runner: execution engine for long-running tasks

# Instructions

telegram-bot is written in TypeScript and run with Bun.
video-parser is written in Python and managed using uv.
task-runner is written in Rust and managed using cargo.

Docker compose is used to manage containers, and the same compose file is used in development and production.
All containers are to be addressed by name on the same compose network, and .env is loaded for all containerised projects.

Infisical is used to manage environment variables. The .infisical.json connects this project to the infisical CLI,
.env is generated by running `infisical export --env=dev > .env`

This project is designed to be a monorepo. If ever you need to create another project in this monorepo, stop all execution and ask the user first.

If you need to install a dependency, stop executing and ask the user to do it instead. All library documentation will be provided in the user's prompt if you need it. If unclear on how to use a library, stop all execution and ask the user.

If required, or you are unsure about how to use a library, stop all execution and ask the user to provide documentation via gitingest in the current session.

After modifying files in telegram-bot please run `cd telegram-bot && bun check` and ensure the output tells you no errors.

If `bun check` doesn't work, try `bunx tsc --noEmit` instead.

If there are still errors after running bun check from the telegram-bot folder, resolve them.

Before you stop execution, make sure to run `cd telegram-bot && bun format` (only if bun check returns no errors).

After modifying files in a uv managed project, always run `cd <project_dir> && pyright` and ensure the output tells you no errors.

If there are still errors, resolve them.

To format code in a uv managed project, run `cd <project_dir> && black .`

## Guidelines for writing tools

All tools provided to the model are stored under the telegram-bot/tools directory. When errors occur, try not to throw them but instead,
return early with the error message, telling the model to correct its own tool call. This way, errors don't just stop execution of the
task completely, but allow the model to have some time to prompt the user, asking for better input or more information.

All tools provided to the model undergo semantic search before being passed to the model. See reference implementation under
utils/tools.ts

Try your best to include console.log statements whenever meaningful, so that I can debug the code

### Agentic tools

The telegram-bot/tools directory not only contains tool sets, but also contain agents. Agents are created using the function createAgent,
located in telegram-bot/bot/agents.ts

Agents have their own data, and this data is the same as the one passed into any other tool (telegram-bot/bot/tool-data.ts:ToolData)

When creating agentic tools, be as specific as possible, so that LLMs can understand what information they are expected to give them,
and what the (agentic tools) purpose is as a sub-agent.

When creating agentic tools, in the createTools parameter when defining tools, try to write comments and log statements.
Log in debug mode, so that I (the user) can look at the logs to easily debug information.
