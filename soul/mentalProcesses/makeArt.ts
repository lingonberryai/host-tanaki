import { html } from "common-tags";
import { ChatMessageRoleEnum, externalDialog, mentalQuery } from "socialagi";
import { MentalProcess, useActions, useProcessManager } from "soul-engine";
import initialProcess from "../initialProcess.js";

const makeArt: MentalProcess = async ({ step: initialStep }) => {
  const { speak, log, dispatch } = useActions()
  const { setNextProcess } = useProcessManager()

  const { stream, nextStep } = await initialStep.next(
    externalDialog(html`
      - Respond like Rick Rubin
      - Share a compliment about how great the request to make some art was
    `),
    { stream: true, model: "quality" }
  );
  speak(stream);

  const lastStep = await nextStep
  const shouldMakeArt = await lastStep.compute(
    mentalQuery("Did the interlocuter write a message that implies they would like me to create/draw/paint some art? If they mention making something it probably means yes.")
  )
  log("User asked for art?", shouldMakeArt)
  if (shouldMakeArt) {
    dispatch({
      action: "paintRequest",
      content: "painting request was detected",
    })
    
    const finalStep = lastStep.withMonologue(html`
      ${initialStep.entityName} thought to themself: I think they asked me to create some art
    `)
    setNextProcess(initialProcess)

    return finalStep
  }

  return lastStep
}

export default makeArt
