import { inspect } from "util";

export const debugPrint = <T>(obj: T) => {
  console.log(inspect(obj, true, 10, true));
};
