import * as fs from "fs";
import { Scenes, Telegraf } from "telegraf";
import Logger from "@plebbit/plebbit-logger";
import { plebbit } from "./index.js";
import fetch from "node-fetch";
import PQueue from "p-queue";

const log = Logger('plebbitfeed:bot');
const queue = new PQueue({ concurrency: 1 });
const historyCidsFile = "history.json";
let processedCids: Set<string> = new Set();

async function scrollPosts(
  address: string,
  tgBotInstance: Telegraf<Scenes.WizardContext>,
  plebbit: typeof import("./index.js").plebbit,
  subInstance: any,
) {
  log("Checking sub: ", address);
  try {
    log("Sub loaded");
    let currentPostCid = subInstance.lastPostCid;
    let counter = 0;
    while (currentPostCid && counter < 20) {
      counter += 1;
      log(`Processing CID: ${currentPostCid}`);
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
          log("Post is older than 24 hours, skipping.");
          currentPostCid = newPost.previousCid;
          continue;
        }

        // Check if the post is removed or deleted
        if (postData.removed || postData.deleted) {
          log("Post is removed or deleted, skipping.");
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
        const captionMessage = `<b>${postData.title ? postData.title + " " : ""}</b>${newPost.spoiler ? "[SPOILER]" : newPost.nsfw ? "[NSFW]" : ""}\n${postData.content}\n\nSubmitted on <a href="https://seedit.app/#/p/${newPost.subplebbitAddress}">p/${newPost.subplebbitAddress}</a> by u/${newPost.author.address.includes(".") ? newPost.author.address : newPost.author.shortAddress}`;

        // Get list of chat IDs to send to
        const chatIds = getChatIds();

        if (postData.link) {
          await queue.add(async () => {
            // Send to all configured chats
            const sendPromises = chatIds.map(chatId => 
              tgBotInstance.telegram
                .sendPhoto(chatId, postData.link!, {
                  parse_mode: "HTML",
                  caption: captionMessage,
                  has_spoiler: newPost.spoiler || newPost.nsfw,
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
                  log.error(`Error sending photo to ${chatId}:`, error);
                  // if the link is not a valid image, send the caption
                  return tgBotInstance.telegram
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
                    .catch((fallbackError: any) => {
                      log.error(`Fallback error for ${chatId}:`, fallbackError);
                    });
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
        log("New post: ", postData);
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
  log("Finished on ", address);
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
  log("Starting plebbit feed bot");

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
          log("Loading sub ", subAddress);
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
          log("Time to load sub: ", endTime - startTime);
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
          log(e);
          log(subAddress);
        }
      }),
    );
    log("saving new posts");
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

      subs = data.subplebbits.map((obj: any) => obj.address);
    }
  } catch (error) {
    log.error("Error:", error);
  }
  return subs;
}
