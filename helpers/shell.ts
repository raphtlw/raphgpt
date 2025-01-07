import ChildProcess from "child_process";
import Util from "util";

export const runCommand = Util.promisify(ChildProcess.exec);
