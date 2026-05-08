# BruteCoding

**The inverse of vibe coding.** Instead of an AI that writes code for you, BruteCoding is an AI that teaches you to write it yourself.

You set a goal. The agent breaks it into milestones and guides you step by step: telling you what to build next, asking questions, reviewing your code, and keeping your hands on the keyboard.

BruteCoding is an early prototype. It works, it has opinions, and the rough edges are still part of the experiment.

---

## The Idea

Vibe coding is great for shipping. It is not always great for learning. When the AI does the work, you watch. When you do the work, you grow.

BruteCoding flips the model: you are the one at the keyboard. The AI acts like a senior engineer sitting next to you, one who refuses to touch your keyboard but will help you think through the next move.

Good for:

- Learning a new language by actually building something in it
- Getting hands-on with a new framework or stack
- Building a real project from scratch while developing intuition
- Practicing for interviews or technical assessments

---

## Features

- **Goal-driven sessions**: describe what you want to build or learn, and the agent plans milestones and gives you the next task.
- **Code review**: point the agent at your active file or selection and it reviews your work without rewriting it for you.
- **Three teaching styles**: Socratic, Direct, and Hints-only.
- **Multiple providers**: Anthropic Claude, OpenAI, OpenRouter, Ollama, and OpenAI-compatible endpoints.
- **VS Code native surfaces**: Activity Bar webview, Secondary Sidebar chat view, editor command, status bar entry, chat participant, and language model provider integration where available.
- **Safer credential storage**: pasted API keys are stored with VS Code SecretStorage, not in `settings.json`.

---

## Getting Started

### 1. Install dependencies and build

```bash
npm install
npm run build
```

### 2. Run in VS Code

Press `F5` to launch the Extension Development Host.

You can also package a VSIX:

```bash
npm run package
```

That produces `brute-coding-0.1.0.vsix`.

### 3. Configure

Open BruteCoding from the Activity Bar or command palette, choose a provider, and paste an API key if the provider needs one.

| Provider | Required configuration |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` or paste a key in the BruteCoding setup UI |
| OpenAI | `OPENAI_API_KEY` or paste a key in the BruteCoding setup UI |
| OpenRouter | `OPENROUTER_API_KEY` or paste a key in the BruteCoding setup UI |
| Ollama | Base URL only, usually `http://localhost:11434/v1` |
| OpenAI-compatible | Base URL plus optional `OPENAI_COMPATIBLE_API_KEY` or pasted key |

Keys pasted into the setup UI are stored in VS Code SecretStorage. Existing keys from older versions that were saved in VS Code settings are migrated into SecretStorage on activation and then removed from settings.

### 4. Start a session

Describe your goal and language, hit **Start Session**, and follow the agent's lead.

---

## Current Limitations

- Code review currently sends the active file or selection to the model, but it does not yet collect diagnostics, terminal output, test results, or runtime logs automatically.
- The agent does not edit files. That is intentional: BruteCoding is meant to coach, not take over.
- Session state is in memory. Restarting VS Code clears the active conversation.
- Tool-use is not implemented yet. A likely next step is read-only context tools for diagnostics, active file metadata, project config, and test output.

---

## Project Structure

```text
src/
  extension.ts                   # Extension entry point
  agent/
    BruteAgent.ts                # Core teaching agent: history, streaming, code review
    prompts.ts                   # System prompt and teaching style definitions
  chat/
    BruteCodingChatParticipant.ts
    BruteCodingLanguageModelProvider.ts
  models/
    ModelProvider.ts             # Provider interface
    AnthropicProvider.ts         # Anthropic SDK streaming
    OpenAICompatibleProvider.ts  # OpenAI, OpenRouter, Ollama, LM Studio, etc.
    OpenRouterModels.ts          # OpenRouter model-list helper
    providerFactory.ts           # Provider construction and SecretStorage helpers
  panels/
    BruteCodingViewProvider.ts   # WebviewView UI surface
    BruteCodingPanel.ts          # Floating WebviewPanel fallback
media/
  activity-icon.svg
  panel.html
  panel.css
  panel.js
```

---

## Development

```bash
npm run dev      # webpack watch mode
npm run build    # production build
npm run lint     # eslint
npm run package  # build and package a VSIX
npm audit        # dependency audit
```

The webview communicates with the extension host over VS Code's message-passing API. Non-secret preferences are stored with `vscode.workspace.getConfiguration('bruteCoding')`; API keys are stored with `context.secrets`.

Before opening a PR or packaging a release, run:

```bash
npm run build
npm run lint
npm audit
npm run package
```

---

## Roadmap Ideas

- Read-only context tools for diagnostics, active file metadata, project config, and terminal/test output
- Better code-check prompts that distinguish review from debugging
- Persisted sessions
- Per-workspace teaching preferences
- A cleaner shared controller for the Activity Bar, Secondary Sidebar, and floating panel surfaces
- More provider-specific model defaults and capability hints

---

## License

MIT
