# 🧱 Wall of Shame

An automated catalogue of harmful, biased, and maliciously ideological content found on the internet.

This project uses an AI-powered research agent to systematically scan for and document articles, opinion pieces, and reports that normalize harmful ideologies, spread misinformation, or advocate for exploitative practices.

## 🏗️ Architecture

- **Agent (`/agent`)**: A Node.js TypeScript application that uses the `pi-research` SDK to perform web research. It iterates through defined categories, analyzes content using LLMs (DeepSeek via OpenRouter), and saves findings as structured JSON.
- **Frontend (`/site`)**: A SolidJS application that displays the findings in a searchable, filterable grid.
- **Automation**: GitHub Actions run the research agent weekly and automatically rebuild/deploy the static site to GitHub Pages.

## 🧪 Categories of Interest

The agent researches 30+ categories, including:
- **Economic Ideology**: Union Busting, Trickle-Down Propaganda, Gig Exploitation.
- **Racism & Hate**: Pseudoscientific Race Realism, Great Replacement Theory, Confederate Apologia.
- **Gender & LGBTQ+**: Red Pill Misogyny, Trans Moral Panic, Conversion Therapy Defense.
- **Environment**: Climate Denial, Corporate Greenwashing.
- **Authoritarianism**: Voter Suppression, Autocrat Admiration.
- ... and many more.

## 🚀 Getting Started

### Local Development

1. **Install Dependencies**:
   ```bash
   # In the root
   cd agent && npm install
   cd ../site && npm install
   ```

2. **Run Interactive CLI**:
   The agent comes with a rich interactive menu for running research, viewing stats, and managing state.
   ```bash
   cd agent
   npx tsx src/cli.ts
   ```

3. **Run Frontend**:
   ```bash
   cd site
   npm run dev
   ```

### Prerequisites for Research
To run the research agent locally, you need:
- `pi-research` extension checked out in `~/Documents/pi-research`.
- A valid OpenRouter API key configured in `~/.pi/agent/auth.json`.

## 🤖 Automated Research

Research runs automatically every Monday at 08:00 (local via cron or 06:00 UTC via GitHub Actions).
The results are committed to `agent/data/findings.json`, which triggers a redeploy of the site.

## ⚖️ License

MIT
