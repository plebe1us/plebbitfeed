import dotenv from "dotenv";
import { startPlebbitFeedBot } from "./plebbitfeed-chat/plebbitfeed-chat-bot.js";
import { Scenes, Telegraf } from "telegraf";
import { startplebbitfeedBot } from "./plebbitfeed/plebbitfeed-bot.js";
import { Logger } from "tslog";
import Plebbit from "@plebbit/plebbit-js";
import { Agent } from "https";

export const log = new Logger();
dotenv.config();

if (!process.env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN is not set");
}
export const plebbitFeedTgBot = new Telegraf<Scenes.WizardContext>(
    process.env.BOT_TOKEN!,
    {
        telegram: {
            agent: new Agent({ keepAlive: false }),
        },
    }
);

export const plebbit = await Plebbit({
    ipfsHttpClientsOptions: [`http://localhost:50019/api/v0`],
    chainProviders: {
      eth: {
        urls: [
          "ethers.js",
          "https://ethrpc.xyz",
          "viem"
        ],
        chainId: 1
      },
      avax: {
        urls: [
          "https://api.avax.network/ext/bc/C/rpc"
        ],
        chainId: 43114
      },
      matic: {
        urls: [
          "https://polygon-rpc.com"
        ],
        chainId: 137
      }
    }
});
plebbit.on("error", (error) => {
    log.error(error.details);
});

const start = async () => {
    try {
        plebbitFeedTgBot.launch();
        // Started message
        if (plebbitFeedTgBot)
            plebbitFeedTgBot.telegram
                .getMe()
                .then((res) =>
                    console.log(`Bot started on https://t.me/${res.username}`)
                );
        await Promise.all([
            startPlebbitFeedBot(plebbitFeedTgBot),
            startplebbitfeedBot(plebbitFeedTgBot),
        ]);
    } catch (error) {
        log.error(error);
    }
};
start();
