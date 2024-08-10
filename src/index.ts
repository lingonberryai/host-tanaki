import "dotenv/config";
import { Client, Message } from "discord.js";
import { ActionEvent, Soul } from "@opensouls/engine";
import fetch from "node-fetch";
import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export type DiscordEventData = {
  type: "messageCreate";
  messageId: string;
  channelId: string;
  guildId: string | null;
  userId: string;
  userDisplayName: string;
  atMentionUsername: string;
  repliedToUserId?: string;
};

function createDiscordEventData(message: Message): DiscordEventData {
  return {
    type: "messageCreate",
    messageId: message.id,
    channelId: message.channelId,
    guildId: message.guild?.id || null,
    userId: message.author.id,
    userDisplayName: message.member?.displayName || message.author.username,
    atMentionUsername: message.author.username,
    repliedToUserId: message.mentions.users.first()?.id,
  };
}

const client = new Client({
  intents: ["Guilds", "GuildMessages", "GuildMembers", "MessageContent"],
});

const lastMessageChannel = new Map<string, Message>();

client.on("ready", () => {
  console.log("sup i am ready");
});

client.on("messageCreate", (message) => {
  if (message.author.bot) return; // Ignore bot's own messages
  console.log(`🗣️ ${message.author.username}: ${message.content}`);
  // Store the message context to use for replies
  lastMessageChannel.set(message.channelId, message);
});

const soul = new Soul({
  organization: "snilgus",
  blueprint: "host-tanaki",
  soulId: "00",
  token: process.env.SOUL_ENGINE_API_KEY,
  debug: true,
});

soul
  .connect()
  .then(() => {
    console.log("Soul connected successfully.");
  })

  .catch(console.error);

soul.on("says", async ({ content }: { content: () => Promise<string> }) => {
  const channelId = Array.from(lastMessageChannel.keys())[
    lastMessageChannel.size - 1
  ];
  const message = lastMessageChannel.get(channelId);
  if (message) {
    const response = await content();
    console.log(`reply to ${message.author.username}: ${response}`);
    message.reply(response).catch(console.error);
    lastMessageChannel.delete(channelId);
  }
});

soul.on("paint", async (evt: ActionEvent) => {
  console.log("🎨👻 paint interaction request detected from soul:");
  console.log("Received event:", evt);

  console.log("_metadata:");
  console.log(evt._metadata.discordMessage);

  console.log("prompt:");
  console.log(evt._metadata.prompt);

  const discordMessage = evt._metadata.discordMessage;
  const messageId = discordMessage.messageId;
  const channelId = discordMessage.channelId;
  const prompt = evt._metadata.prompt;

  console.log(messageId);

  console.log(`🧠 making request to /brain to paint ${prompt}...`);

  try {
    const response = await fetch("http://brain.tanaki.app/paint", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: prompt }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const contentType = response.headers.get("content-type");
    let data;

    if (contentType && contentType.includes("application/json")) {
      data = await response.json();
    } else if (contentType && contentType.includes("text/plain")) {
      data = await response.text();
    } else if (contentType && contentType.includes("text/html")) {
      data = await response.text();
      console.warn(`Received HTML response: ${data}`);
    } else {
      throw new Error(`Unsupported response type: ${contentType}`);
    }

    console.log("🖼️ painting is complete:");
    console.log(data.message || data);

    const imgURL = data.message?.toString() || data.toString();

    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      await channel.send(imgURL);
    }
  } catch (error) {
    console.error("Error:", error);
  }
});

client.on("messageCreate", (message) => {
  if (message.author.bot) return; // Ignore bot's own messages

  const discordEvent = createDiscordEventData(message);

  soul.dispatch({
    action: "chatted",
    content: message.content,
    name: discordEvent.atMentionUsername,
    _metadata: {
      discordEvent,
      discordUserId: client.user?.id,
    },
  });
});

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

// Custom console.log function to broadcast logs
const originalConsoleLog = console.log;
console.log = (...args) => {
  originalConsoleLog(...args);
  io.emit('log', args.join(' '));
};

// Add this near the top of the file, after the imports
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Serve the HTML page
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// Start the server
const PORT = process.env.PORT || 6969;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

client.login(process.env.BOT_TOKEN_OZ);