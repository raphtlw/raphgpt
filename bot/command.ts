import child_process from "node:child_process";
import { promisify } from "node:util";

export const Command = (cmd: string) => ({
  exec: promisify(child_process.exec),
  async run() {
    const cp = await this.exec(cmd);
    return cp;
  },
});
