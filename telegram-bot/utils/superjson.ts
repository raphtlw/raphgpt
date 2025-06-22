import SuperJSON from "superjson";

SuperJSON.registerCustom<Buffer, number[]>(
  {
    isApplicable: (v): v is Buffer => v instanceof Buffer,
    serialize: (v) => [...v],
    deserialize: (v) => Buffer.from(v),
  },
  "buffer",
);
