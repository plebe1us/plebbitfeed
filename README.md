<a href="https://t.me/plebbitfeed"><img src="plebbitfeedlogo.png"  width="150" ></a>

# PlebbitFeed Bot

A Telegram bot that automatically feeds posts from Plebbit subplebbits to your Telegram channels or groups. The bot continuously monitors multiple Plebbit communities and shares new posts with convenient links to view them on [Seedit](https://seedit.app) and [Plebchan](https://plebchan.app).

## What it does

This bot:
- 📡 Monitors multiple Plebbit subplebbits for new posts
- 🔍 Filters out adult and gore content automatically  
- 📱 Sends formatted posts to your Telegram channels/groups
- 🖼️ Supports images, videos, audio, animations, and embeddable content
- 🔗 Provides convenient "View on Seedit" and "View on Plebchan" buttons for each post
- 💾 Keeps track of processed posts to avoid duplicates

## Setup Instructions

1. **Clone the repository:**
   ```bash
   git clone https://github.com/plebe1us/plebbitfeed.git
   cd plebbitfeed
   ```

2. **Install dependencies:**
   ```bash
   yarn install
   ```

3. **Create a `.env` file** in the root directory with the required environment variables (see below)

4. **Start the bot:**
   ```bash
   yarn start
   ```

## Environment Variables

Create a `.env` file in the project root with the following variables:

```env
# Required: Telegram Bot Token from @BotFather
BOT_TOKEN=your_telegram_bot_token_here

# Required: At least one of these must be set
# Telegram Chat/Channel ID where posts will be sent (primary destination)
FEED_BOT_CHAT=-1001234567890

# Optional: Additional Telegram Group ID for posts (secondary destination)  
FEED_BOT_GROUP=-1001234567891
```

### Getting the values:

- **BOT_TOKEN**: Create a new bot on Telegram using [@BotFather](https://t.me/botfather) and get the token
- **FEED_BOT_CHAT**: The chat ID of your Telegram channel or group (use [@userinfobot](https://t.me/userinfobot) to get chat IDs)
- **FEED_BOT_GROUP**: Optional second destination for posts

**Note:** At least one of `FEED_BOT_CHAT` or `FEED_BOT_GROUP` must be configured for the bot to work.

## How it works

The bot fetches the list of active Plebbit subplebbits from the [official repository](https://github.com/plebbit/temporary-default-subplebbits), processes new posts, and formats them for Telegram. Each post includes convenient buttons that let users click to view the full content on either Seedit or Plebchan web interfaces.

