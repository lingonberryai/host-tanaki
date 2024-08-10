import "dotenv/config";
import { Client, Message, TextChannel, Events, GatewayIntentBits, Partials } from "discord.js";
import { ActionEvent, Soul } from "@opensouls/engine";
import fetch from "node-fetch";

export type DiscordEventData = {
  type: "messageCreate";
  messageId: string;
  channelId: string;
  guildId: string | null;
  userId: string;
  userDisplayName: string;
  atMentionUsername: string;
  repliedToUserId?: string;
  timestamp: number;
  isBot: boolean;
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
    timestamp: Date.now(),
    isBot: message.author.bot,
  };
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.User],
});

client.on("ready", () => {
  console.log("Tanaki Ultra is ready!");
  console.log("Logged in as:", client.user?.tag);
  console.log("Bot ID:", client.user?.id);
});

const soul = new Soul({
  organization: "psql",
  blueprint: "tanaki-oz-discord",
  soulID: "01",
  token: process.env.SOUL_ENGINE_API_KEY,
  debug: true,
});

soul.connect().then(() => {
  console.log("Soul connected successfully.");
}).catch(console.error);

const MAX_RESPONSE_DELAY = 60000; // 60 seconds

client.on(Events.MessageCreate, async (message) => {
  console.log("Received message:");
  console.log("- Content:", message.content);
  console.log("- Author:", message.author.tag);
  console.log("- Is bot:", message.author.bot);
  console.log("- Channel:", message.channel.id);
  console.log("- Guild:", message.guild?.id || "DM");

  // Ignore messages from self to prevent potential loops
  if (message.author.id === client.user?.id) {
    console.log("Ignoring message from self");
    return;
  }

  // Explicitly log bot messages
  if (message.author.bot) {
    console.log("Received message from another bot:", message.content);
  }

  console.log(`🗣️ ${message.author.username} ${message.author.bot ? '(BOT)' : ''}: ${message.content}`);

  const discordEvent = createDiscordEventData(message);

  // Process messages from both humans and bots
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

soul.on("says", async ({ content, _metadata }) => {
  const response = await content();
  console.log("Raw response from soul:", response);
  console.log("Metadata received:", _metadata);

  const metadata = _metadata?.discordMessage || _metadata?.discordEvent;

  if (metadata) {
    try {
      const channel = await client.channels.fetch(metadata.channelId);
      if (channel.isTextBased()) {
        const now = Date.now();
        if (now - metadata.timestamp > MAX_RESPONSE_DELAY) {
          console.log(`Response delayed beyond ${MAX_RESPONSE_DELAY}ms, sending as new message`);
          await channel.send(`[Delayed response to a message from ${metadata.userDisplayName}${metadata.isBot ? ' (BOT)' : ''}]\n${response}`);
        } else {
          const originalMessage = await channel.messages.fetch(metadata.messageId);
          await originalMessage.reply(response);
        }
        console.log(`Sent response to message ${metadata.messageId} in channel ${metadata.channelId}`);
      }
    } catch (error) {
      console.error("Error sending reply:", error);
    }
  } else {
    console.error("No metadata found for response:", response);
  }
});

soul.on("paint", async (evt: ActionEvent) => {
  console.log("🎨👻 Paint interaction request detected from soul");

  const discordMessage = evt._metadata.discordMessage;
  const prompt = evt._metadata.prompt;

  if (!discordMessage || !prompt) {
    console.error("Missing discord message or prompt for paint request");
    return;
  }

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
    let imgURL;

    if (contentType && contentType.includes("application/json")) {
      const data = await response.json();
      imgURL = data.message || data;
    } else {
      imgURL = await response.text();
    }

    console.log("🖼️ Painting is complete:", imgURL);

    const channel = await client.channels.fetch(discordMessage.channelId);
    if (channel.isTextBased()) {
      const now = Date.now();
      if (now - discordMessage.timestamp > MAX_RESPONSE_DELAY) {
        console.log(`Painting response delayed beyond ${MAX_RESPONSE_DELAY}ms, sending as new message`);
        await channel.send(`[Delayed painting response to a message from ${discordMessage.userDisplayName}${discordMessage.isBot ? ' (BOT)' : ''}]\n${imgURL}`);
      } else {
        const originalMessage = await channel.messages.fetch(discordMessage.messageId);
        await originalMessage.reply(imgURL);
      }
      console.log(`Sent painting response to message ${discordMessage.messageId} in channel ${discordMessage.channelId}`);
    }
  } catch (error) {
    console.error("Error in paint request:", error);
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);