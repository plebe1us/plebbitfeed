import * as fs from "fs";
import { Scenes, Telegraf } from "telegraf";
import { log, plebbit } from "./index.js";
import fetch from "node-fetch";
import PQueue from "p-queue";
import { getShortAddress } from "@plebbit/plebbit-js";

const queue = new PQueue({ concurrency: 1 });
const historyCidsFile = "history.json";
let processedCids: Set<string> = new Set();

// Media type detection helpers
function getMediaTypeFromUrl(url: string): 'image' | 'video' | 'audio' | 'animation' | 'embeddable' | null {
  try {
    const parsedUrl = new URL(url);
    
    // Check for embeddable platforms first
    if (isEmbeddablePlatform(parsedUrl)) {
      return 'embeddable';
    }
    
    // Extract extension from pathname
    const pathname = parsedUrl.pathname.toLowerCase();
    const extensionMatch = pathname.match(/\.([^.]+)$/);
    
    if (extensionMatch) {
      const extension = extensionMatch[1];
      
      // Define file type mappings for supported Telegram media types only
      const imageExtensions = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff'];
      const videoExtensions = ['mp4', 'webm', 'avi', 'mov', 'mkv', 'm4v', '3gp', 'gifv']; // gifv is actually video
      const audioExtensions = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'];
      const animationExtensions = ['gif']; // Only true GIF animations
      
      if (imageExtensions.includes(extension)) {
        return 'image';
      } else if (videoExtensions.includes(extension)) {
        return 'video';
      } else if (audioExtensions.includes(extension)) {
        return 'audio';
      } else if (animationExtensions.includes(extension)) {
        return 'animation';
      } else {
        // Return null for unsupported extensions to trigger fallback to text message
        return null;
      }
    }
    
    return null;
  } catch (error) {
    log.error('Error parsing URL:', error);
    return null;
  }
}

function isEmbeddablePlatform(parsedUrl: URL): boolean {
  const embeddableDomains = [
    // YouTube
    'youtube.com', 'youtu.be',
    // Twitter/X
    'twitter.com', 'x.com',
    // TikTok
    'tiktok.com',
    // Instagram
    'instagram.com',
    // Twitch
    'twitch.tv',
    // Reddit
    'reddit.com',
    // Others
    'odysee.com',
    'bitchute.com',
    'streamable.com',
    'spotify.com',
    'soundcloud.com',
  ];
  
  const hostname = parsedUrl.hostname;
  
  // Check for exact match or subdomain match (hostname ends with .domain.com)
  for (const domain of embeddableDomains) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) {
      return true;
    }
  }
  
  // Special case for YouTube Invidious instances
  return hostname.startsWith('yt.') && parsedUrl.searchParams.has('v');
}

async function sendMediaToChatWithParsedType(
  tgBotInstance: Telegraf<Scenes.WizardContext>,
  chatId: string,
  url: string,
  caption: string,
  replyMarkup: any,
  hasSpoiler: boolean = false,
  mediaType: 'image' | 'video' | 'audio' | 'animation' | 'embeddable' | null
): Promise<void> {
  try {
    switch (mediaType) {
      case 'image':
        await tgBotInstance.telegram.sendPhoto(chatId, url, {
          parse_mode: "HTML",
          caption: caption,
          has_spoiler: hasSpoiler,
          reply_markup: replyMarkup,
        });
        break;
        
      case 'video':
        await tgBotInstance.telegram.sendVideo(chatId, url, {
          parse_mode: "HTML",
          caption: caption,
          has_spoiler: hasSpoiler,
          reply_markup: replyMarkup,
        });
        break;
        
      case 'audio':
        await tgBotInstance.telegram.sendAudio(chatId, url, {
          parse_mode: "HTML",
          caption: caption,
          reply_markup: replyMarkup,
        });
        break;
        
      case 'animation':
        await tgBotInstance.telegram.sendAnimation(chatId, url, {
          parse_mode: "HTML",
          caption: caption,
          has_spoiler: hasSpoiler,
          reply_markup: replyMarkup,
        });
        break;
        
      case 'embeddable':
        // For embeddable content, send the URL as a message to get Telegram's link preview
        await tgBotInstance.telegram.sendMessage(chatId, `${caption}\n\n🔗 ${url}`, {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });
        break;
        
      default:
        // For null/unsupported media types, send as message with link
        await tgBotInstance.telegram.sendMessage(chatId, `${caption}\n\n🔗 ${url}`, {
          parse_mode: "HTML",
          reply_markup: replyMarkup,
        });
        break;
    }
  } catch (error) {
    log.error(`Error sending ${mediaType} to ${chatId}:`, error);
    // Fallback to text message
    await tgBotInstance.telegram.sendMessage(chatId, `${caption}\n\n🔗 ${url}`, {
      parse_mode: "HTML",
      reply_markup: replyMarkup,
    });
  }
}

async function scrollPosts(
  address: string,
  tgBotInstance: Telegraf<Scenes.WizardContext>,
  plebbit: typeof import("./index.js").plebbit,
  subInstance: any,
) {
  log.info("Checking sub: ", address);
  try {
    log.info("Sub loaded");
    let currentPostCid = subInstance.lastPostCid;
    let counter = 0;
    while (currentPostCid && counter < 20) {
      counter += 1;
      log.info(`Processing CID: ${currentPostCid}`);
      if (currentPostCid && !processedCids.has(currentPostCid)) {
        const newPost = await plebbit.getComment(currentPostCid);
        const postData = {
          title: newPost.title ? newPost.title : "",
          content: newPost.content ? newPost.content : "",
          postCid: newPost.postCid,
          link: newPost.link,
          cid: newPost.cid,
          subplebbitAddress: newPost.subplebbitAddress,
          timestamp: newPost.timestamp,
          removed: newPost.removed ? newPost.removed : false,
          deleted: newPost.deleted ? newPost.deleted : false,
        };
        postData.title = postData.title
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

        postData.content = postData.content
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

        // Check if the post is older than 24 hours
        const currentTime = Math.floor(Date.now() / 1000);
        if (currentTime - postData.timestamp > 24 * 60 * 60) {
          log.info("Post is older than 24 hours, skipping.");
          currentPostCid = newPost.previousCid;
          continue;
        }

        // Check if the post is removed or deleted
        if (postData.removed || postData.deleted) {
          log.info("Post is removed or deleted, skipping.");
          currentPostCid = newPost.previousCid;
          continue;
        }

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
            const sendPromises = chatIds.map(chatId => 
              sendMediaToChatWithParsedType(
                tgBotInstance,
                chatId,
                linkUrl,
                captionMessage,
                replyMarkup,
                newPost.spoiler || newPost.nsfw,
                mediaType
              ).catch((error: any) => {
                log.error(`Error sending media to ${chatId}:`, error);
              })
            );

            await Promise.allSettled(sendPromises);
            
            if (currentPostCid) {
              processedCids.add(currentPostCid);
            }

            await new Promise((resolve) => setTimeout(resolve, 10 * 1000));
          });
        } else {
          await queue.add(async () => {
            // Send to all configured chats
            const sendPromises = chatIds.map(chatId =>
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
                })
            );

            await Promise.allSettled(sendPromises);
            
            if (currentPostCid) {
              processedCids.add(currentPostCid);
            }
            
            await new Promise((resolve) => setTimeout(resolve, 10 * 1000));
          });
        }
        log.info("New post: ", postData);
        currentPostCid = newPost.previousCid;
      } else {
        //log.info("Already processsed: ", currentPostCid);
        const post = await plebbit.getComment(currentPostCid);
        currentPostCid = post.previousCid;
      }
    }
  } catch (e) {
    log.error(e);
  }
  log.info("Finished on ", address);
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
    processedCids = new Set(parsedData.Cids); // Ensure uniqueness
  } catch (error) {
    log.error(error);
    throw new Error();
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
  } catch (error) {
    log.error("Error saving json file");
  }
}

export async function startPlebbitFeedBot(
  tgBotInstance: Telegraf<Scenes.WizardContext>,
) {
  log.info("Starting plebbit feed bot");

  if (!process.env.FEED_BOT_CHAT && !process.env.FEED_BOT_GROUP) {
    throw new Error("At least one of FEED_BOT_CHAT or FEED_BOT_GROUP must be set");
  }
  
  if (!process.env.BOT_TOKEN) {
    throw new Error("BOT_TOKEN not set");
  }

  while (true) {
    loadOldPosts();
    console.log("Length of loaded posts: ", processedCids.size);
    const subs = await fetchSubs();
    await Promise.all(
      subs.map(async (subAddress: string) => {
        try {
          log.info("Loading sub ", subAddress);
          const startTime = performance.now();
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
          const endTime = performance.now();
          log.info("Time to load sub: ", endTime - startTime);
          if (subInstance.address) {
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
          }
        } catch (e) {
          log.info(e);
          log.info(subAddress);
        }
      }),
    );
    log.info("saving new posts");
    savePosts();
  }
}

export async function fetchSubs() {
  let subs = [];
  try {
    const response = await fetch(
      "https://raw.githubusercontent.com/plebbit/temporary-default-subplebbits/master/multisub.json",
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
    log.error("Error:", error);
  }
  return subs;
}
