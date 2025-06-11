import dotenv from "dotenv";
import { startPlebbitFeedBot } from "./plebbitfeed.js";
import { Scenes, Telegraf } from "telegraf";
import { Logger } from "tslog";
import Plebbit from "@plebbit/plebbit-js";
import { Agent } from "https";

export const log = new Logger({
  minLevel: "info", // Only log info, warn, error - skip debug and trace
  prettyLogTemplate: "{{yyyy}}.{{mm}}.{{dd}} {{hh}}:{{MM}}:{{ss}} {{logLevelName}} [{{filePathWithLine}}] ",
  prettyErrorTemplate: "{{yyyy}}.{{mm}}.{{dd}} {{hh}}:{{MM}}:{{ss}} {{logLevelName}} [{{filePathWithLine}}] {{errorName}}: {{errorMessage}}\n{{errorStack}}",
});
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
  },
);

// Set environment variable to reduce debug logging before loading Plebbit
process.env.DEBUG = '';

// Override console methods to filter out massive object dumps from debug packages
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

console.log = (...args: any[]) => {
  // Filter out large object dumps from debug packages
  const stringified = args.map(arg => typeof arg === 'object' ? String(arg) : arg).join(' ');
  if (stringified.includes('upvoteCount') && stringified.includes('signature') && stringified.includes('protocolVersion')) {
    // Skip massive plebbit object dumps
    return;
  }
  originalConsoleLog.apply(console, args);
};

console.error = (...args: any[]) => {
  const stringified = args.map(arg => typeof arg === 'object' ? String(arg) : arg).join(' ');
  if (stringified.includes('upvoteCount') && stringified.includes('signature') && stringified.includes('protocolVersion')) {
    return;
  }
  originalConsoleError.apply(console, args);
};

console.warn = (...args: any[]) => {
  const stringified = args.map(arg => typeof arg === 'object' ? String(arg) : arg).join(' ');
  if (stringified.includes('upvoteCount') && stringified.includes('signature') && stringified.includes('protocolVersion')) {
    return;
  }
  originalConsoleWarn.apply(console, args);
};

export const plebbit = await Plebbit({
  kuboRpcClientsOptions: [`http://localhost:50019/api/v0`],
  chainProviders: {
    eth: {
      urls: ["ethers.js", "https://ethrpc.xyz", "viem"],
      chainId: 1,
    },
    avax: {
      urls: ["https://api.avax.network/ext/bc/C/rpc"],
      chainId: 43114,
    },
    matic: {
      urls: ["https://polygon-rpc.com"],
      chainId: 137,
    },
  },
});
plebbit.on("error", (error: any) => {
  log.error("Plebbit error:", error.message || error.code || "Unknown plebbit error");
});

const start = async () => {
  try {
    plebbitFeedTgBot.launch();
    // Started message
    if (plebbitFeedTgBot)
      plebbitFeedTgBot.telegram
        .getMe()
        .then((res) =>
          console.log(`Bot started on https://t.me/${res.username}`),
        );
    await Promise.all([startPlebbitFeedBot(plebbitFeedTgBot)]);
  } catch (error) {
    log.error("Bot startup error:", error instanceof Error ? error.message : String(error));
  }
};
start();
