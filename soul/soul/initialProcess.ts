import { CortexStep, brainstorm, decision, externalDialog, internalMonologue } from "socialagi";
import { MentalProcess, VectorRecordWithSimilarity, useActions, usePerceptions, useRag, useSoulMemory } from "soul-engine";
import { Perception } from "soul-engine/soul";
import { DiscordEventData } from "../discord/soulGateway.js";
import { getMetadataFromPerception, getUserDataFromDiscordEvent, newMemory } from "./lib/utils.js";
import { prompt } from "./lib/prompt.js";

const initialProcess: MentalProcess = async ({ step: initialStep }) => {
  const { log, dispatch } = useActions();
  const { invokingPerception, pendingPerceptions } = usePerceptions();
  const { userName, discordEvent: discordMessageMetadata } = getMetadataFromPerception(invokingPerception);

  const hasReachedPendingPerceptionsLimit = pendingPerceptions.current.length > 10;
  if (hasReachedPendingPerceptionsLimit) {
    log("Pending perceptions limit reached. Skipping perception.");
    return initialStep;
  }

  const isMessageBurst = hasMoreMessagesFromSameUser(pendingPerceptions.current, userName);
  if (isMessageBurst) {
    log(`Skipping perception from ${userName} because it's part of a message burst`);
    return initialStep;
  }

  let step = rememberUser(initialStep, discordMessageMetadata);

  const shouldReply = await isUserTalkingToHost(invokingPerception, step, userName);
  if (!shouldReply) {
    log(`Ignoring message from ${userName} because they're not talking to Host`);
    return initialStep;
  }

  const userSentNewMessagesInMeantime = hasMoreMessagesFromSameUser(pendingPerceptions.current, userName);
  if (userSentNewMessagesInMeantime) {
    log(`Aborting response to ${userName} because they've sent more messages in the meantime`);
    return initialStep;
  }

  const shouldPaint = await isUserAskingForPainting(invokingPerception, step, userName);

  if (shouldPaint) {
    log(`User ${userName} is asking for painting, drawing, or creating something 🎨🎨🎨🎨. consider the prior messages in your decision making too.`);
  
    const internalResponse = await step.next(externalDialog(`tell ${userName} tell the user how excited you are to paint their request and riff on the subject`));

    const glifPrompt = await step.next(brainstorm(`now that you're excited to paint, riff on the subject you just spoke about and come up with an image prompt to paint based on the conversation messages. think of just the image prompt.`));

    log("this is the internal response 🧠")
    log(internalResponse.value)
    
    log("this is the glif prompt 🧠")
    log(glifPrompt.value)

    const excitementResponse = internalResponse.value;
  
    step = await step.next(externalDialog(excitementResponse));
  
    if (discordMessageMetadata) {
      dispatch({
        action: "says",
        content: excitementResponse,
        _metadata: {
          discordMessage: discordMessageMetadata,
        },
      });
      log("Dispatched a message to the user expressing excitement about painting");
      

      log("Discord message metadata:", discordMessageMetadata);


      dispatch({
        action: "paint",
        content: excitementResponse, 
        _metadata: {
          discordMessage: discordMessageMetadata,
          prompt: glifPrompt.value, 
        },
      });
      log("Dispatched a paint request to the Discord Bot");
  
      step = await step.next(externalDialog(`Dispatched a paint request to the Discord Bot`));
    } else {
      log("Discord message metadata is undefined, unable to dispatch paint request");
    }
  }
  

  step = await withSearchResults(step, invokingPerception);

  log(`Answering message from ${userName}`);

  const { stream, nextStep } = await step.next(externalDialog(`Host answers ${userName}'s message`), {
    stream: true,
    model: "quality",
  });


  dispatch({
    action: "says",
    content: stream,
    _metadata: {
      discordEvent: discordMessageMetadata,
    },
  });

  return await nextStep;
};

function hasMoreMessagesFromSameUser(pendingPerceptions: Perception[], userName: string) {
  const countOfPendingPerceptionsBySamePerson = pendingPerceptions.filter((perception) => {
    return getMetadataFromPerception(perception)?.userName === userName;
  }).length;

  return countOfPendingPerceptionsBySamePerson > 0;
}



async function isUserAskingForPainting(perception: Perception | undefined | null, step: CortexStep<any>, userName: string) {
  const { log } = useActions();

  if (!perception || !perception.content) {
    log("No perception content available to analyze.");
    return false;
  }

  log(`🧠 👀 Analyzing perception content: ${perception.content}`);
  
  const isAskingForPainting = await step.compute(
    decision(
      `was a painting, drawing, or art requested to be created/made by tanaki in the most RECENT message from ${userName}? `,
      ["Yes", "Not Sure", "No"]
    ),
    {
      model: "quality",
    }
  );

  log(`🎨 Decision on asking for painting: ${isAskingForPainting}`);

  // Return true if the decision is "Yes"
  return isAskingForPainting === "Yes";

}





async function isUserTalkingToHost(
  perception: Perception | undefined | null,
  step: CortexStep<any>,
  userName: string
) {
  const { log } = useActions();

  const discordUserId = soul.env.discordUserId?.toString();
  if (discordUserId && perception && perception.content.includes(`<@${discordUserId}>`)) {
    log(`User at-mentioned Host, will reply`);
    return true;
  }

  const interlocutor = await step.compute(
    decision(
      `Tanaki is the moderator of this channel. Participants sometimes talk to Tanaki, and sometimes between themselves. In this last message sent by ${userName}, guess which person they are probably speaking with.`,
      ["Tanaki, for sure", "Tanaki, possibly", "someone else", "not sure"]
    ),
    {
      model: "quality",
    }
  );

  log(`Tanaki decided that ${userName} is talking to: ${interlocutor}`);

  return interlocutor.toString().startsWith("Tanaki");
}

async function withSearchResults(step: CortexStep<any>, invokingPerception: Perception | null | undefined) {
  const { log } = useActions();
  const { search } = useRag();
  const { content: userMessage } = getMetadataFromPerception(invokingPerception);
  
  const retrievedContent = await search({
    query: userMessage,
    maxDistance: 0.6, // this is actually the minimum similarity
  }) as VectorRecordWithSimilarity[]
  
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

  return step.withMemory(
    newMemory(prompt`
      Tanaki remembers:
      ${content}
    `)
  );
}



function rememberUser(step: CortexStep<any>, discordEvent: DiscordEventData | undefined) {
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
    step = step.withMemory(newMemory(remembered));
  } else {
    log(`No memory about ${userName}`);
  }

  return step;
}

export default initialProcess;
