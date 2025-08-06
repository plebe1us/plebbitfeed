import dotenv from "dotenv";
import { startPlebbitFeedBot, setShuttingDown } from "./plebbitfeed.js";
import { Scenes, Telegraf } from "telegraf";
import { Logger } from "tslog";
import Plebbit from "@plebbit/plebbit-js";

export const log = new Logger({
  minLevel: "info", // Only log info, warn, error - skip debug and trace
  prettyLogTemplate:
    "{{yyyy}}.{{mm}}.{{dd}} {{hh}}:{{MM}}:{{ss}} {{logLevelName}} [{{filePathWithLine}}] ",
  prettyErrorTemplate:
    "{{yyyy}}.{{mm}}.{{dd}} {{hh}}:{{MM}}:{{ss}} {{logLevelName}} [{{filePathWithLine}}] {{errorName}}: {{errorMessage}}\n{{errorStack}}",
});

console.log("Loading dotenv config...");
dotenv.config();
console.log("Dotenv config loaded");

console.log("Checking BOT_TOKEN...");
if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set");
}
console.log("BOT_TOKEN found, creating Telegraf instance...");
export const plebbitFeedTgBot = new Telegraf<Scenes.WizardContext>(
  process.env.BOT_TOKEN!
  // Removed agent configuration to test if that's causing the issue
);
console.log("Telegraf instance created");

// Set environment variable to reduce debug logging before loading Plebbit
process.env.DEBUG = "";

// Override console methods to filter out massive object dumps from debug packages
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;

console.log = (...args: any[]) => {
  // Filter out large object dumps from debug packages
  const stringified = args
    .map((arg) => (typeof arg === "object" ? String(arg) : arg))
    .join(" ");
  if (
    stringified.includes("upvoteCount") &&
    stringified.includes("signature") &&
    stringified.includes("protocolVersion")
  ) {
    // Skip massive plebbit object dumps
    return;
  }
  originalConsoleLog.apply(console, args);
};

console.error = (...args: any[]) => {
  const stringified = args
    .map((arg) => (typeof arg === "object" ? String(arg) : arg))
    .join(" ");
  if (
    stringified.includes("upvoteCount") &&
    stringified.includes("signature") &&
    stringified.includes("protocolVersion")
  ) {
    return;
  }
  originalConsoleError.apply(console, args);
};

console.warn = (...args: any[]) => {
  const stringified = args
    .map((arg) => (typeof arg === "object" ? String(arg) : arg))
    .join(" ");
  if (
    stringified.includes("upvoteCount") &&
    stringified.includes("signature") &&
    stringified.includes("protocolVersion")
  ) {
    return;
  }
  originalConsoleWarn.apply(console, args);
};

// Plebbit instance will be initialized in start() function with timeout
export let plebbit: any;

// Interval IDs for cleanup
let errorCleanupInterval: NodeJS.Timeout | undefined;

// Graceful shutdown handling
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) {
    log.warn("Force shutting down...");
    process.exit(1);
  }
  
  isShuttingDown = true;
  log.info(`\nReceived ${signal}. Shutting down bot gracefully...`);
  
  try {
    // Set shutdown flag for plebbitfeed
    setShuttingDown(true);
    
    // Stop the Telegram bot
    if (plebbitFeedTgBot) {
      log.info("Stopping Telegram bot...");
      await plebbitFeedTgBot.stop();
    }
    
    // Stop Plebbit instance
    if (plebbit) {
      log.info("Stopping Plebbit instance...");
      await plebbit.destroy();
    }
    
    // Clear error cleanup interval if it exists
    if (errorCleanupInterval) {
      clearInterval(errorCleanupInterval);
    }
    
    log.info("Bot shutdown complete");
    process.exit(0);
  } catch (error) {
    log.error("Error during shutdown:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};

// Handle various shutdown signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGQUIT', () => gracefulShutdown('SIGQUIT'));

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  log.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled Rejection:', reason);
  gracefulShutdown('unhandledRejection');
});

const start = async () => {
  console.log("Starting bot...");
  try {
    if (isShuttingDown) return;
    
    console.log("Launching Telegram bot...");
    
    // Launch bot asynchronously without waiting for long polling to start
    plebbitFeedTgBot.launch().catch((error) => {
      log.error("Telegram bot launch error:", error);
    });
    
    // Give it a moment to initialize, then test connection
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    log.info("Telegram bot launched successfully");
    
    // Started message
    try {
      const botInfo = await plebbitFeedTgBot.telegram.getMe();
      log.info(`Bot started: https://t.me/${botInfo.username}`);
    } catch (error) {
      log.warn("Could not get bot info:", error instanceof Error ? error.message : String(error));
    }
    
    // Initialize Plebbit with timeout
    log.info("Initializing Plebbit...");
    try {
    
      plebbit = await Promise.race([
        Plebbit({
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
        }),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error("Plebbit initialization timed out after 2 minutes"));
          }, 2 * 60 * 1000); // 2 minutes timeout
        }),
      ]);
      
      // Error rate limiting to prevent spam
      const errorCounts = new Map<string, { count: number; lastLogged: number }>();
      const ERROR_LOG_INTERVAL = 60000; // Only log same error once per minute
      const MAX_ERROR_LOGS_PER_INTERVAL = 3; // Max 3 logs per error type per interval
      const ERROR_CLEANUP_INTERVAL = 3600000; // Cleanup every hour
      const ERROR_RETENTION_TIME = 7200000; // Keep entries for 2 hours
      
      // Periodic cleanup to prevent unbounded Map growth
      errorCleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, value] of errorCounts.entries()) {
          if (now - value.lastLogged > ERROR_RETENTION_TIME) {
            errorCounts.delete(key);
          }
        }
      }, ERROR_CLEANUP_INTERVAL);
      
      plebbit.on("error", (error: any) => {
        const errorKey = error.message || error.code || "Unknown plebbit error";
        const now = Date.now();
        const errorInfo = errorCounts.get(errorKey) || { count: 0, lastLogged: 0 };
        
        errorInfo.count++;
        let shouldLog = false;
        
        // Reset count if enough time has passed
        if (now - errorInfo.lastLogged > ERROR_LOG_INTERVAL) {
          errorInfo.count = 1;
          errorInfo.lastLogged = now;
          shouldLog = true;
        } else if (errorInfo.count <= MAX_ERROR_LOGS_PER_INTERVAL) {
          errorInfo.lastLogged = now;
          shouldLog = true;
        }
        
        // Update Map once after adjusting values
        errorCounts.set(errorKey, errorInfo);
        
        // Log if should log
        if (shouldLog) {
          // Use appropriate log level based on error type
          if (errorKey.includes("Failed to resolve IPNS")) {
            log.warn("IPNS resolution failed (subplebbit may be offline)");
          } else {
            log.error("Plebbit error:", errorKey);
          }
        }
      });
      
      log.info("Plebbit initialized successfully");
    } catch (error) {
      log.error("Failed to initialize Plebbit:", error instanceof Error ? error.message : String(error));
      throw error;
    }
    
    if (isShuttingDown) return;
    
    // Start the plebbit feed bot
    await startPlebbitFeedBot(plebbitFeedTgBot);
    
  } catch (error) {
    log.error(
      "Bot startup error:",
      error instanceof Error ? error.message : String(error),
    );
    
    if (!isShuttingDown) {
      await gracefulShutdown('startup-error');
    }
  }
};

console.log("About to call start()...");
start().catch((error) => {
  log.error("Unhandled start error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
