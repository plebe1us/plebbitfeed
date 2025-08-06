import * as fs from "fs";
import { Scenes, Telegraf } from "telegraf";
import { log, plebbit } from "./index.js";
import fetch from "node-fetch";
import PQueue from "p-queue";
import { getShortAddress } from "@plebbit/plebbit-js";

const queue = new PQueue({ concurrency: 1 });
const historyCidsFile = "history.json";
let processedCids: Set<string> = new Set();

// Global shutdown flag
let isShuttingDown = false;

export function setShuttingDown(value: boolean) {
  isShuttingDown = value;
}

// Media type detection helpers
function getMediaTypeFromUrl(
  url: string,
): "image" | "video" | "audio" | "animation" | "embeddable" | null {
  try {
    const parsedUrl = new URL(url);

    // Check for embeddable platforms first
    if (isEmbeddablePlatform(parsedUrl)) {
      return "embeddable";
    }

    // Extract extension from pathname
    const pathname = parsedUrl.pathname.toLowerCase();
    const extensionMatch = pathname.match(/\.([^.]+)$/);

    if (extensionMatch) {
      const extension = extensionMatch[1];

      // Define file type mappings for supported Telegram media types only
      const imageExtensions = ["jpg", "jpeg", "png", "webp", "bmp", "tiff"];
      const videoExtensions = [
        "mp4",
        "webm",
        "avi",
        "mov",
        "mkv",
        "m4v",
        "3gp",
        "gifv",
      ]; // gifv is actually video
      const audioExtensions = [
        "mp3",
        "wav",
        "ogg",
        "flac",
        "m4a",
        "aac",
        "opus",
      ];
      const animationExtensions = ["gif"]; // Only true GIF animations

      if (imageExtensions.includes(extension)) {
        return "image";
      } else if (videoExtensions.includes(extension)) {
        return "video";
      } else if (audioExtensions.includes(extension)) {
        return "audio";
      } else if (animationExtensions.includes(extension)) {
        return "animation";
      } else {
        // Return null for unsupported extensions to trigger fallback to text message
        return null;
      }
    }

    return null;
  } catch (error) {
    log.error("Error parsing URL:", error);
    return null;
  }
}

// Helper function to detect Twitter video URLs
function isTwitterVideoUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname === "video.twimg.com" && parsedUrl.pathname.includes(".mp4");
  } catch {
    return false;
  }
}

function isEmbeddablePlatform(parsedUrl: URL): boolean {
  const embeddableDomains = [
    // YouTube
    "youtube.com",
    "m.youtube.com",
    "youtu.be",
    // Twitter/X
    "twitter.com",
    "x.com",
    "mobile.twitter.com",
    // TikTok
    "tiktok.com",
    "m.tiktok.com",
    // Instagram
    "instagram.com",
    "m.instagram.com",
    // Twitch
    "twitch.tv",
    "m.twitch.tv",
    // Reddit
    "reddit.com",
    "m.reddit.com",
    // Others
    "odysee.com",
    "bitchute.com",
    "streamable.com",
    "spotify.com",
    "soundcloud.com",
  ];

  const hostname = parsedUrl.hostname;

  // Check for exact match or proper subdomain match
  for (const domain of embeddableDomains) {
    if (hostname === domain) {
      return true;
    }
    // More precise subdomain check: ensure it's a proper subdomain
    if (hostname.endsWith(`.${domain}`) && hostname.split('.').length > domain.split('.').length) {
      return true;
    }
  }

  // Special case for YouTube Invidious instances
  return hostname.startsWith("yt.") && parsedUrl.searchParams.has("v");
}

async function sendMediaToChatWithParsedType(
  tgBotInstance: Telegraf<Scenes.WizardContext>,
  chatId: string,
  url: string,
  caption: string,
  replyMarkup: any,
  hasSpoiler: boolean = false,
  mediaType: "image" | "video" | "audio" | "animation" | "embeddable" | null,
): Promise<void> {
  try {
    switch (mediaType) {
      case "image":
        await tgBotInstance.telegram.sendPhoto(chatId, url, {
          parse_mode: "HTML",
          caption: caption,
          has_spoiler: hasSpoiler,
          reply_markup: replyMarkup,
        });
        break;

      case "video":
        try {
          await tgBotInstance.telegram.sendVideo(chatId, url, {
            parse_mode: "HTML",
            caption: caption,
            has_spoiler: hasSpoiler,
            reply_markup: replyMarkup,
          });
        } catch (videoError) {
          // Special handling for Twitter video URLs which often fail with direct sendVideo
          if (isTwitterVideoUrl(url)) {
            log.info(`Twitter video failed to send directly to ${chatId}, trying alternative approaches`);
            
            // Try sending as text with video attachment note
            try {
              await tgBotInstance.telegram.sendMessage(
                chatId,
                `${caption}\n\n🎥 <i>Video attachment (click to view):</i> ${url}`,
                {
                  parse_mode: "HTML",
                  reply_markup: replyMarkup,
                }
              );
              return; // Success, exit early
            } catch (embedError) {
              log.warn(`Failed to send Twitter video as text message to ${chatId}:`, embedError);
            }
          }
          
          // Re-throw the original error to trigger general fallback
          throw videoError;
        }
        break;

      case "audio":
        await tgBotInstance.telegram.sendAudio(chatId, url, {
          parse_mode: "HTML",
          caption: caption,
          reply_markup: replyMarkup,
        });
        break;

      case "animation":
        await tgBotInstance.telegram.sendAnimation(chatId, url, {
          parse_mode: "HTML",
          caption: caption,
          has_spoiler: hasSpoiler,
          reply_markup: replyMarkup,
        });
        break;

      case "embeddable":
        if (hasSpoiler) {
          try {
            // Attempt to send as a spoilered video, which works for YouTube, etc.
            await tgBotInstance.telegram.sendVideo(chatId, url, {
              parse_mode: "HTML",
              caption: caption,
              has_spoiler: true,
              reply_markup: replyMarkup,
            });
          } catch (videoError) {
            log.info(
              `Could not send spoilered embeddable as video to ${chatId}, falling back to spoilered link.`,
            );
            // If sending as a video fails, send a spoilered link (no preview)
            await tgBotInstance.telegram.sendMessage(
              chatId,
              `${caption}\n\n🔗 <tg-spoiler>${url}</tg-spoiler>`,
              {
                parse_mode: "HTML",
                reply_markup: replyMarkup,
              },
            );
          }
        } else {
          // For embeddable content, send the URL as a message to get Telegram's link preview
          try {
            await tgBotInstance.telegram.sendMessage(
              chatId,
              `${caption}\n\n🔗 ${url}`,
              {
                parse_mode: "HTML",
                reply_markup: replyMarkup,
              },
            );
          } catch (embedError) {
            log.error(
              `Error sending embeddable message to ${chatId}:`,
              embedError,
            );
            // If embeddable fails, try as photo to get thumbnail
            await tgBotInstance.telegram.sendPhoto(chatId, url, {
              parse_mode: "HTML",
              caption: caption,
              has_spoiler: hasSpoiler, // This will be false
              reply_markup: replyMarkup,
            });
          }
        }
        break;

      default:
        // For null/unsupported media types, send as message with link
        await tgBotInstance.telegram.sendMessage(
          chatId,
          `${caption}\n\n🔗 ${url}`,
          {
            parse_mode: "HTML",
            reply_markup: replyMarkup,
          },
        );
        break;
    }
  } catch (error) {
    // Provide more specific error messages for different media types
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    if (mediaType === "video" && isTwitterVideoUrl(url)) {
      log.error(`Failed to send Twitter video to ${chatId} (${errorMessage}). This is a known issue with Twitter video URLs and Telegram.`);
    } else {
      log.error(`Error sending ${mediaType} to ${chatId}:`, error);
    }
    
    // Fallback to text message with appropriate emoji
    const mediaEmoji = mediaType === "video" ? "🎥" : 
                      mediaType === "image" ? "🖼️" : 
                      mediaType === "audio" ? "🎵" : 
                      mediaType === "animation" ? "🎞️" : "🔗";
    
    await tgBotInstance.telegram.sendMessage(
      chatId,
      `${caption}\n\n${mediaEmoji} ${url}`,
      {
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      },
    );
  }
}

async function scrollPosts(
  address: string,
  tgBotInstance: Telegraf<Scenes.WizardContext>,
  plebbit: any,
  subInstance: any,
) {
  try {
    
    // Use subplebbit pages instead of manual linked list traversal
    // This gives us posts with full CommentUpdate data including moderation status
    let posts: any[] = [];
    
    try {
      // Try to get the 'new' page which has the most recent posts
      if (subInstance.posts?.pageCids?.new) {
        const newPage = await subInstance.posts.getPage(subInstance.posts.pageCids.new);
        posts = newPage.comments || [];
        // Reduced verbose logging - only log if significant number of posts
        if (posts.length > 10) {
          log.info(`Loaded ${posts.length} posts from 'new' page for ${getShortAddress(address)}`);
        }
      } else if (subInstance.posts?.pages?.hot?.comments) {
        // Fallback to preloaded hot page if available
        posts = subInstance.posts.pages.hot.comments;
        // Reduced verbose logging - only log if significant number of posts
        if (posts.length > 10) {
          log.info(`Using ${posts.length} preloaded posts from 'hot' page for ${getShortAddress(address)}`);
        }
      } else {
        log.warn("No posts pages available, falling back to manual traversal");
        // Fallback to original method if pages aren't available
        let currentPostCid = subInstance.lastPostCid;
        let counter = 0;
        while (currentPostCid && counter < 20) {
          counter += 1;
          const post = await plebbit.getComment(currentPostCid);
          posts.push(post);
          currentPostCid = post.previousCid;
        }
      }
    } catch (pageError) {
      log.warn("Error loading posts page, falling back to manual traversal:", pageError);
      // Fallback to original method
      let currentPostCid = subInstance.lastPostCid;
      let counter = 0;
      while (currentPostCid && counter < 20) {
        counter += 1;
        const post = await plebbit.getComment(currentPostCid);
        posts.push(post);
        currentPostCid = post.previousCid;
      }
    }

    // Process each post
    for (const newPost of posts.slice(0, 20)) { // Limit to 20 most recent posts
      if (newPost.cid && !processedCids.has(newPost.cid)) {

        // Fetch full CommentUpdate for accurate removed status
        const comment = await plebbit.createComment({ cid: newPost.cid });
        await comment.update();

        // Wait for CommentUpdate to load with timeout
        let commentUpdateLoaded = false;
        await Promise.race([
          new Promise<void>((resolve) => {
            const updateListener = () => {
              if (typeof comment.updatedAt === 'number') {
                comment.removeListener('update', updateListener);
                commentUpdateLoaded = true;
                resolve();
              }
            };
            comment.on('update', updateListener);
          }),
          new Promise<void>((resolve) => {
            setTimeout(() => {
              // Reduced verbose logging for comment update timeouts
              resolve();
            }, 10000); // 10 second timeout for faster responsiveness
          })
        ]);

        // Store the removed status before stopping the comment
        const isRemoved = comment.removed === true;
        const removedStatus = comment.removed; // Store for logging

        // Now check removed status
        if (isRemoved) {
          // Reduced verbose logging for removed posts
          await comment.stop();
          continue;
        }
        await comment.stop();

        // Check if the post is older than 2 days (for failed retries) or 24 hours (for new posts)
        const currentTime = Math.floor(Date.now() / 1000);
        const maxAge = 2 * 24 * 60 * 60; // 2 days in seconds
        if (currentTime - newPost.timestamp > maxAge) {
          // Reduced verbose logging for old posts
          continue;
        }

        // Check if the post is deleted
        if (newPost.deleted) {
          // Reduced verbose logging for deleted posts
          continue;
        }

        const postData = {
          title: newPost.title ? newPost.title : "",
          content: newPost.content ? newPost.content : "",
          postCid: newPost.postCid,
          link: newPost.link,
          cid: newPost.cid,
          subplebbitAddress: newPost.subplebbitAddress,
          timestamp: newPost.timestamp,
          removed: isRemoved,
          deleted: newPost.deleted ? newPost.deleted : false,
        };

        // Convert plebbit spoiler tags to Telegram spoiler format before HTML escaping
        postData.title = postData.title
          .replace(/<spoiler>(.*?)<\/spoiler>/g, "||$1||")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

        postData.content = postData.content
          .replace(/<spoiler>(.*?)<\/spoiler>/g, "||$1||")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

        if (postData.title.length + postData.content.length > 900) {
          if (postData.title.length > 900) {
            const truncated = postData.title.substring(0, 900);
            postData.title =
              truncated.substring(0, truncated.length - 3) + "...";
            postData.content = postData.content.substring(0, 900) + "...";
          } else {
            const truncated = postData.content.substring(
              0,
              900 - postData.title.length,
            );
            postData.content =
              truncated.substring(0, truncated.length - 3) + "...";
          }
        }
        const captionMessage = `<b>${postData.title ? postData.title + " " : ""}</b>${newPost.spoiler ? "[SPOILER]" : newPost.nsfw ? "[NSFW]" : ""}\n${postData.content}\n\nSubmitted on <a href="https://seedit.app/#/p/${newPost.subplebbitAddress}">p/${getShortAddress(newPost.subplebbitAddress)}</a> by u/${getShortAddress(newPost.author.address)}`;

        // Get list of chat IDs to send to
        const chatIds = getChatIds();

        if (postData.link) {
          await queue.add(async () => {
            const replyMarkup = {
              inline_keyboard: [
                [
                  {
                    text: "View on Seedit",
                    url: `https://seedit.app/#/p/${postData.subplebbitAddress}/c/${postData.cid}`,
                  },
                  {
                    text: "View on Plebchan",
                    url: `https://plebchan.app/#/p/${postData.subplebbitAddress}/c/${postData.cid}`,
                  },
                ],
              ],
            };

            // Parse URL once per media item, not per chat
            const linkUrl = postData.link!; // We're already inside the if (postData.link) block
            const mediaType = getMediaTypeFromUrl(linkUrl);

            // Send to all configured chats
            const sendPromises = chatIds.map((chatId) =>
              sendMediaToChatWithParsedType(
                tgBotInstance,
                chatId,
                linkUrl,
                captionMessage,
                replyMarkup,
                newPost.spoiler || newPost.nsfw,
                mediaType,
              ).catch((error: any) => {
                log.error(`Error sending media to ${chatId}:`, error);
                return false; // Return false to indicate failure
              }),
            );

            const results = await Promise.allSettled(sendPromises);

            // Only mark as processed if at least one message was sent successfully
            const hasSuccessfulSend = results.some(
              (result) =>
                result.status === "fulfilled" && result.value !== false,
            );

            if (newPost.cid && hasSuccessfulSend) {
              processedCids.add(newPost.cid);
              // Save immediately after each successful post to prevent duplicates on restart
              savePosts();
            }

            // Removed 10-second delay for immediate post sending
          });
        } else {
          await queue.add(async () => {
            // Send to all configured chats
            const sendPromises = chatIds.map((chatId) =>
              tgBotInstance.telegram
                .sendMessage(chatId, captionMessage, {
                  parse_mode: "HTML",
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {
                          text: "View on Seedit",
                          url: `https://seedit.app/#/p/${postData.subplebbitAddress}/c/${postData.cid}`,
                        },
                        {
                          text: "View on Plebchan",
                          url: `https://plebchan.app/#/p/${postData.subplebbitAddress}/c/${postData.cid}`,
                        },
                      ],
                    ],
                  },
                })
                .catch((error: any) => {
                  log.error(`Error sending message to ${chatId}:`, error);
                  return false; // Return false to indicate failure
                }),
            );

            const results = await Promise.allSettled(sendPromises);

            // Only mark as processed if at least one message was sent successfully
            const hasSuccessfulSend = results.some(
              (result) =>
                result.status === "fulfilled" && result.value !== false,
            );

            if (newPost.cid && hasSuccessfulSend) {
              processedCids.add(newPost.cid);
              // Save immediately after each successful post to prevent duplicates on restart
              savePosts();
            }

            // Removed 10-second delay for immediate post sending
          });
        }
        // Only log new posts that were successfully sent
        if (newPost.cid && (postData.link ? true : true)) { // Always log for now, can be made conditional later
          log.info(`📩 New post: "${postData.title || "No title"}" on p/${getShortAddress(postData.subplebbitAddress)}`);
        }
      } else if (newPost.cid && processedCids.has(newPost.cid)) {
        // Post already processed, skip to prevent duplicates
        log.debug(`⏭️  Skipping already processed post: ${newPost.cid.substring(0, 12)}... on p/${getShortAddress(newPost.subplebbitAddress)}`);
      }
    }
  } catch (e) {
    log.error(
      `Error in scrollPosts for ${getShortAddress(address)}:`,
      e instanceof Error ? e.message : String(e),
    );
  }
}

// Helper function to get list of chat IDs
function getChatIds(): string[] {
  const chatIds: string[] = [];

  // Add primary channel/chat
  if (process.env.FEED_BOT_CHAT) {
    chatIds.push(process.env.FEED_BOT_CHAT);
  }

  // Add secondary group
  if (process.env.FEED_BOT_GROUP) {
    chatIds.push(process.env.FEED_BOT_GROUP);
  }

  return chatIds;
}

function loadOldPosts() {
  try {
    const data = fs.readFileSync(historyCidsFile, "utf8");
    const parsedData = JSON.parse(data);
    const loadedCids = parsedData.Cids || [];
    processedCids = new Set(loadedCids); // Ensure uniqueness
    log.info(`✅ Loaded ${loadedCids.length} previously processed post CIDs from history`);
  } catch (error) {
    if (error instanceof Error && error.message.includes('ENOENT')) {
      log.info("📝 No history file found, starting with empty history");
    } else {
      log.warn(
        "⚠️  Could not load history file, starting with empty history:",
        error instanceof Error ? error.message : String(error),
      );
    }
    processedCids = new Set(); // Initialize with empty set
  }
}

function savePosts() {
  try {
    const dataToSave = { Cids: Array.from(processedCids) };
    fs.writeFileSync(
      historyCidsFile,
      JSON.stringify(dataToSave, null, 2),
      "utf8",
    );
    log.debug(`💾 Saved ${processedCids.size} processed CIDs to history file`);
  } catch (error) {
    log.error("❌ Error saving history file:", error instanceof Error ? error.message : String(error));
  }
}

export async function startPlebbitFeedBot(
  tgBotInstance: Telegraf<Scenes.WizardContext>,
) {
  log.info("Starting plebbit feed bot");

  if (!process.env.FEED_BOT_CHAT && !process.env.FEED_BOT_GROUP) {
    throw new Error(
      "At least one of FEED_BOT_CHAT or FEED_BOT_GROUP must be set",
    );
  }

  if (!process.env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN not set");
  }

  // Load history at startup to ensure we don't send duplicates from the beginning
  loadOldPosts();

  // Error rate limiting for subplebbit errors
  const subErrorCounts = new Map<string, { count: number; lastLogged: number }>();
  const SUB_ERROR_LOG_INTERVAL = 300000; // Only log same subplebbit error once per 5 minutes
  const SUB_ERROR_CLEANUP_INTERVAL = 3600000; // Cleanup every hour
  const SUB_ERROR_RETENTION_TIME = 7200000; // Keep entries for 2 hours
  
  // Periodic cleanup to prevent unbounded Map growth
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of subErrorCounts.entries()) {
      if (now - value.lastLogged > SUB_ERROR_RETENTION_TIME) {
        subErrorCounts.delete(key);
      }
    }
  }, SUB_ERROR_CLEANUP_INTERVAL);
  
  let cycleCount = 0;
  
  while (!isShuttingDown) {
    cycleCount++;
    const cycleStartTime = Date.now();
    
    loadOldPosts();
    log.info(`Starting cycle ${cycleCount} with ${processedCids.size} processed posts`);
    
    const subs = await fetchSubs();
    log.info(`Fetched ${subs.length} subplebbits to process`);
    
    if (isShuttingDown) break;
    
    // Process subplebbits in smaller batches to reduce load
    const batchSize = 5; // Process 5 subs at a time instead of all at once
    let processedCount = 0;
    let newPostsFound = 0;
    
    for (let i = 0; i < subs.length; i += batchSize) {
      if (isShuttingDown) break;
      
      const batch = subs.slice(i, i + batchSize);
      const batchResults = await Promise.allSettled(
        batch.map(async (subAddress: string, batchIndex: number) => {
          const globalIndex = i + batchIndex + 1;
          log.info(`Processing subs: (${globalIndex}/${subs.length}) ${getShortAddress(subAddress)}`);
          processedCount++;
          try {
            if (isShuttingDown) return { postsFound: 0 };
            
            const subInstance: any = await Promise.race([
              plebbit.getSubplebbit(subAddress),
              new Promise((_, reject) => {
                setTimeout(
                  () => {
                    reject(new Error("Operation timed out after 5 minutes"));
                  },
                  5 * 60 * 1000,
                );
              }),
            ]);
            
            if (isShuttingDown) return { postsFound: 0 };
            
            if (subInstance.address) {
              const postsBefore = processedCids.size;
              await Promise.race([
                scrollPosts(
                  subInstance.address,
                  tgBotInstance,
                  plebbit,
                  subInstance,
                ),
                new Promise((_, reject) => {
                  setTimeout(
                    () => {
                      reject(
                        new Error(
                          "Timedout after 6 minutes of post crawling on " +
                            subInstance.address,
                        ),
                      );
                    },
                    6 * 60 * 1000,
                  );
                }),
              ]);
              const postsAfter = processedCids.size;
              return { postsFound: postsAfter - postsBefore };
            }
            return { postsFound: 0 };
          } catch (e) {
            // Rate limit subplebbit errors
            const errorKey = `${subAddress}:${e instanceof Error ? e.message : String(e)}`;
            const now = Date.now();
            const errorInfo = subErrorCounts.get(errorKey) || { count: 0, lastLogged: 0 };
            
            errorInfo.count++;
            
            // More aggressive rate limiting - only log every 15 minutes for IPNS errors
            const isIPNSError = e instanceof Error && e.message.includes("Failed to resolve IPNS");
            const logInterval = isIPNSError ? 15 * 60 * 1000 : SUB_ERROR_LOG_INTERVAL; // 15 minutes for IPNS errors
            
            // Update Map and log if within interval
            if (now - errorInfo.lastLogged > logInterval) {
              errorInfo.lastLogged = now;
              
              // Only log first occurrence of IPNS errors, then suppress for 15 minutes
              if (isIPNSError && errorInfo.count === 1) {
                log.warn(`Subplebbit ${getShortAddress(subAddress)} offline (IPNS resolution failed)`);
              } else if (!isIPNSError) {
                log.error(`Error processing ${getShortAddress(subAddress)}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            subErrorCounts.set(errorKey, errorInfo);
            return { postsFound: 0 };
          }
        }),
      );
      
      // Collect batch results
      batchResults.forEach((result) => {
        if (result.status === 'fulfilled' && result.value) {
          newPostsFound += result.value.postsFound || 0;
        }
      });
      
      // Small delay between batches to prevent overwhelming the system
      if (i + batchSize < subs.length && !isShuttingDown) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay between batches
      }
    }
    
    if (isShuttingDown) break;
    
    savePosts();
    
    const cycleEndTime = Date.now();
    const cycleDuration = cycleEndTime - cycleStartTime;
    log.info(`Cycle ${cycleCount} completed: ${processedCount}/${subs.length} subs processed, ${newPostsFound} new posts found (${Math.round(cycleDuration / 1000)}s)`);
    
    // Wait only 30 seconds between cycles for real-time monitoring
    log.info("Waiting 30 seconds before next cycle...");
    const CYCLE_DELAY = 30 * 1000; // 30 seconds
    
    // Break the delay into smaller chunks to allow for graceful shutdown
    const delayChunks = 6; // 6 chunks of 5 seconds each
    const chunkDelay = CYCLE_DELAY / delayChunks;
    
    for (let i = 0; i < delayChunks && !isShuttingDown; i++) {
      await new Promise(resolve => setTimeout(resolve, chunkDelay));
    }
  }
  
  // Clear cleanup interval on shutdown
  clearInterval(cleanupInterval);
  log.info("Bot feed processing stopped due to shutdown signal");
}

export async function fetchSubs() {
  let subs = [];
  try {
    const response = await fetch(
      "https://raw.githubusercontent.com/plebbit/lists/master/default-multisub.json",
    );
    if (!response.ok) {
      throw new Error("Failed to fetch subs");
    } else {
      const data: any = await response.json();

      // Filter out subplebbits with adult or gore tags
      subs = data.subplebbits
        .filter((obj: any) => {
          const tags = obj.tags || [];
          return !tags.includes("adult") && !tags.includes("gore");
        })
        .map((obj: any) => obj.address);
    }
  } catch (error) {
    log.error(
      "Error fetching subs:",
      error instanceof Error ? error.message : String(error),
    );
  }
  return subs;
}
