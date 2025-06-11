# Components

- telegram-bot: actual hosted Telegram Bot
- video-parser: to extract and process videos for LLM input

# Instructions

telegram-bot is written in TypeScript and run with Bun.
video-parser is written in Python and managed using uv.

This project is designed to be a monorepo. If ever you need to create another project in this monorepo, stop all execution and ask the user first.

If you need to install a dependency, stop executing and ask the user to do it instead. All library documentation will be provided in the user's prompt if you need it. If unclear on how to use a library, stop all execution and ask the user.

If required, or you are unsure about how to use a library, stop all execution and ask the user to provide documentation via gitingest in the current session.

After modifying files in telegram-bot please run bun check (inside the telegram-bot folder) and ensure the output tells you no errors.

If there are still errors after running bun check from the telegram-bot folder, resolve them.

## Guidelines for writing tools

All tools provided to the model are stored under the telegram-bot/tools directory. When errors occur, try not to throw them but instead,
return early with the error message, telling the model to correct its own tool call. This way, errors don't just stop execution of the
task completely, but allow the model to have some time to prompt the user, asking for better input or more information.

All tools provided to the model undergo semantic search before being passed to the model. See reference implementation under
utils/tools.ts.
