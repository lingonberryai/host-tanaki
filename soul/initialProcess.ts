import { MentalProcess, useActions, usePerceptions, useRag, useSoulMemory } from "@opensouls/engine";
import externalDialog from "./cognitiveSteps/externalDialog.js";

import decision from "./cognitiveSteps/decision.js";
import { VectorRecordWithSimilarity } from "@opensouls/engine";
import { Perception } from "@opensouls/engine";
// import { DiscordEventData } from "../discord/soulGateway.js";
import { getMetadataFromPerception, getUserDataFromDiscordEvent, newMemory } from "./lib/utils.js";
import { prompt } from "./lib/prompt.js";

const initialProcess: MentalProcess = async ({ workingMemory }) => {
  const { speak, log, dispatch } = useActions();
  const { invokingPerception, pendingPerceptions } = usePerceptions();
  const { userName, discordEvent: discordMessageMetadata } = getMetadataFromPerception(invokingPerception);

  if (pendingPerceptions.current.length > 10) {
    log("Pending perceptions limit reached. Skipping perception.");
    return workingMemory;
  }

  if (hasMoreMessagesFromSameUser(pendingPerceptions.current, userName)) {
    log(`Skipping perception from ${userName} because it's part of a message burst`);
    return workingMemory;
  }

  let updatedMemory = rememberUser(workingMemory, discordMessageMetadata);

  const shouldReply = await isUserTalkingToHost(invokingPerception, updatedMemory, userName);
  if (!shouldReply) {
    log(`Ignoring message from ${userName} because they're not talking to Host`);
    return workingMemory;
  }

  if (hasMoreMessagesFromSameUser(pendingPerceptions.current, userName)) {
    log(`Aborting response to ${userName} because they've sent more messages in the meantime`);
    return workingMemory;
  }

  const shouldPaint = await isUserAskingForPainting(invokingPerception, updatedMemory, userName);

  if (shouldPaint) {
    log(`User ${userName} is asking for painting, drawing, or creating something 🎨🎨🎨🎨. consider the prior messages in your decision making too.`);
    
    const [excitedMemory, excitementResponse] = await externalDialog(updatedMemory, `tell ${userName} tell the user how excited you are to paint their request and riff on the subject`, { model: "quality" });
    
    const [glifPromptMemory, glifPrompt] = await brainstorm(excitedMemory, `now that you're excited to paint, riff on the subject you just spoke about and come up with an image prompt to paint based on the conversation messages. think of just the image prompt.`, { model: "quality" });

    log("This is the excitement response 🧠");
    log(excitementResponse);
    
    log("This is the glif prompt 🧠");
    log(glifPrompt);

    speak(excitementResponse);
    updatedMemory = glifPromptMemory;

    if (discordMessageMetadata) {
      dispatch({
        action: "paint",
        content: excitementResponse,
        _metadata: {
          discordMessage: discordMessageMetadata,
          prompt: glifPrompt,
        },
      });
      log("Dispatched a paint request to the Discord Bot");
    } else {
      log("Discord message metadata is undefined, unable to dispatch paint request");
    }
  }

  updatedMemory = await withSearchResults(updatedMemory, invokingPerception);

  log(`Answering message from ${userName}`);

  const [finalMemory, stream] = await externalDialog(
    updatedMemory,
    `Talk to the user ${userName} trying to gain trust and learn about their inner world.`,
    { stream: true, model: "quality" }
  );

  speak(stream);

  dispatch({
    action: "says",
    content: stream,
    _metadata: {
      discordEvent: discordMessageMetadata,
    },
  });

  return finalMemory;
};

function hasMoreMessagesFromSameUser(pendingPerceptions: Perception[], userName: string) {
  return pendingPerceptions.filter((perception) => 
    getMetadataFromPerception(perception)?.userName === userName
  ).length > 0;
}

async function isUserAskingForPainting(perception: Perception | undefined | null, workingMemory: WorkingMemory, userName: string) {
  const { log } = useActions();

  if (!perception || !perception.content) {
    log("No perception content available to analyze.");
    return false;
  }

  log(`🧠 👀 Analyzing perception content: ${perception.content}`);
  
  const [, isAskingForPainting] = await decision(
    workingMemory,
    `was a painting, drawing, or art requested to be created/made by tanaki in the most RECENT message from ${userName}? `,
    ["Yes", "Not Sure", "No"],
    { model: "quality" }
  );

  log(`🎨 Decision on asking for painting: ${isAskingForPainting}`);

  return isAskingForPainting === "Yes";
}

async function isUserTalkingToHost(
  perception: Perception | undefined | null,
  workingMemory: WorkingMemory,
  userName: string
) {
  const { log } = useActions();

  const discordUserId = soul.env.discordUserId?.toString();
  if (discordUserId && perception && perception.content.includes(`<@${discordUserId}>`)) {
    log(`User at-mentioned Host, will reply`);
    return true;
  }

  const [, interlocutor] = await decision(
    workingMemory,
    `Tanaki is the moderator of this channel. Participants sometimes talk to Tanaki, and sometimes between themselves. In this last message sent by ${userName}, guess which person they are probably speaking with.`,
    ["Tanaki, for sure", "Tanaki, possibly", "someone else", "not sure"],
    { model: "quality" }
  );

  log(`Tanaki decided that ${userName} is talking to: ${interlocutor}`);

  return interlocutor.toString().startsWith("Tanaki");
}

async function withSearchResults(workingMemory: WorkingMemory, invokingPerception: Perception | null | undefined) {
  const { log } = useActions();
  const { search } = useRag();
  const { content: userMessage } = getMetadataFromPerception(invokingPerception);
  
  const retrievedContent = await search({
    query: userMessage,
    maxDistance: 0.6,
  }) as VectorRecordWithSimilarity[];
  
  const results = retrievedContent.map((doc) => ({
    content: doc.content,
    similarity: doc.similarity,
  }));

  const sortedResults = results.sort((a, b) => b.similarity - a.similarity);
  const firstThreeResults = sortedResults.slice(0, 3);

  log(prompt`
    Found ${results.length} related documents with RAG search, using best ${firstThreeResults.length} results:
    ${firstThreeResults.map((result) => `- ${result.content?.toString().slice(0, 100)}... (similarity: ${result.similarity})`).join("\n")}
  `);

  const content = firstThreeResults.map((result) => `- ${result.content}`).join("\n");

  return workingMemory.withMemory(
    newMemory(prompt`
      Tanaki remembers:
      ${content}
    `)
  );
}

function rememberUser(workingMemory: WorkingMemory, discordEvent: DiscordEventData | undefined) {
  const { log } = useActions();
  const { userName, userDisplayName } = getUserDataFromDiscordEvent(discordEvent);

  const userModel = useSoulMemory(userName, `- Display name: "${userDisplayName}"`);
  const userLastMessage = useSoulMemory(userName + "-lastMessage", "");

  let remembered = "";

  if (userModel.current) {
    remembered += userModel.current;
  }

  if (userLastMessage.current) {
    remembered += `\n\nThe last message Tanaki sent to ${userName} was:\n- ${userLastMessage.current}`;
  }

  remembered = remembered.trim();

  if (remembered.length > 0) {
    log(`Remembered this about ${userName}:\n${remembered}`);

    remembered = `Tanaki remembers this about ${userName}:\n${remembered.trim()}`;
    return workingMemory.withMemory(newMemory(remembered));
  } else {
    log(`No memory about ${userName}`);
    return workingMemory;
  }
}

export default initialProcess;