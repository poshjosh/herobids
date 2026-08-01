# AI First UX

We want our UI/UX to be AI first. We are thinking of making the entry point chat based.

- The user is shown a chat box, with a default message e.g: 

```
Hi, ask anything;

Or, I can help you create your own: 

1. AI personal assistant

2. AI crypto trader

3. Custom AI

What do you prefer?
```

- The above list could be populated from our supported roles, from the frontend

- If the user chooses any of the roles we e.g. trading, we ask follow up questions, with the aim of filling out the "Create agent" form for the user. Some example follow up questions, to be asked if the user decide for an agent in the trading role/preset are:

  - What type of crypto do you want to trade e.g. DEX, CEX or any.
  - What trading platform: Hyperliquid, bybit, jupiter or any? A NOTE ON THIS: This is still too jargony. Rather we could ask the user: "What chain do you want to trade on e.g. Ethereum, Solana, Base, BSC, Arbitrum or any"
  - Do you have an existing wallet or should we create one for you?

- The chat session should be able to display supporting forms for the user to fill, supporting forms may be reserved for things that involve secrets e.g. when we add connections.

- After creating the agent, the LLm may say things like: 
  - Don't forget to fund your wallet, with <capital-USD-specified-during-creation>
  - Your agent is in test mode, you can change this anytime by ...

- For the above to be successfuly, the LLM agent should have access to the code for the form or at least a markdown page explaining the create agent process (the form and all its schenanigans) for an LLM agent. This would required adding tools like: search_app_docs, list_app_docs, read_app_docs to a skill (available to all agents?).

Open questions

- Should our initial messages be translated into various supported languages?
- Should the app documentation related skill be available by default e.g core skill?
