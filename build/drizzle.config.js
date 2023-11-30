import "dotenv/config";
export default {
    schema: "./schema.ts",
    out: "./migrations",
    driver: "better-sqlite",
    dbCredentials: {
        url: "./sqlite.db",
    },
};
