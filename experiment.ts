import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { Connection } from "@solana/web3.js";

const connection = new Connection(
  "https://mainnet.helius-rpc.com/?api-key=b6881db8-dbbc-406a-a59e-249db9523225",
  "confirmed",
);

const raydium = await Raydium.load({
  connection,
});

const data = await raydium.api.getTokenInfo([
  "So11111111111111111111111111111111111111112",
]);

console.log(data);

console.log(
  await raydium.api.fetchPoolByMints({
    mint1: "So11111111111111111111111111111111111111112",
    mint2: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  }),
);

connection.onLogs("all", (data) => {
  console.log(data);
});
