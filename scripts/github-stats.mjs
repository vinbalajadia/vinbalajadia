// Builds the GitHub activity cards in assets/ (light and dark), in the same
// monochrome style as the portfolio: total contributions over the last 12 months,
// a halftone-dot activity map, and top languages.
//
// Runs daily from .github/workflows/github-stats.yml with the workflow's own
// GITHUB_TOKEN. Uses only Node's built-ins, so there is nothing to install.
// For a local preview without a token: STATS_DATA=data.json node scripts/github-stats.mjs

import { readFile, writeFile } from "node:fs/promises";

const LOGIN = process.env.GITHUB_LOGIN ?? "vinbalajadia";
const ASSETS = new URL("../assets/", import.meta.url);

const QUERY = `query ($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }
      totalCommitContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalIssueContributions
      restrictedContributionsCount
    }
    repositories(first: 100, ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) {
      totalCount
      nodes { languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } } }
    }
  }
}`;

const THEMES = {
  light: { ink: "#0a0a0a", muted: "#525252", faint: "#d4d4d4", border: "#e5e5e5", shades: ["#0a0a0a", "#525252", "#a3a3a3", "#d4d4d4"] },
  dark: { ink: "#f4f4f5", muted: "#a0a0a8", faint: "#3a3a42", border: "#30363d", shades: ["#f4f4f5", "#a0a0a8", "#6b6b73", "#3a3a42"] },
};
const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`;
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

async function loadUser() {
  if (process.env.STATS_DATA) return JSON.parse(await readFile(process.env.STATS_DATA, "utf8"));
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("Set GITHUB_TOKEN, or STATS_DATA for a local preview.");
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${token}`, "content-type": "application/json", "user-agent": `${LOGIN}-profile-stats` },
    body: JSON.stringify({ query: QUERY, variables: { login: LOGIN } }),
  });
  const json = await response.json();
  if (!response.ok || json.errors || !json.data?.user) {
    throw new Error(`GitHub API ${response.status}: ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data.user;
}

function summarize(user) {
  const collection = user.contributionsCollection;
  const plural = (n, word) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
  const bytes = new Map();
  for (const repo of user.repositories.nodes) {
    for (const { size, node } of repo.languages.edges) bytes.set(node.name, (bytes.get(node.name) ?? 0) + size);
  }
  const totalBytes = [...bytes.values()].reduce((sum, size) => sum + size, 0);
  return {
    total: collection.contributionCalendar.totalContributions,
    weeks: collection.contributionCalendar.weeks.map((week) => week.contributionDays),
    // Only what's non-zero, so the card never shows a row of zeros.
    facts: [
      [collection.totalCommitContributions, "commit"],
      [collection.totalPullRequestContributions, "pull request"],
      [collection.totalPullRequestReviewContributions, "code review"],
      [collection.totalIssueContributions, "issue"],
      [user.repositories.totalCount, "public repository"],
    ]
      .filter(([n]) => n > 0)
      .map(([n, word]) => (word === "public repository" ? `${n} public ${n === 1 ? "repository" : "repositories"}` : plural(n, word)))
      .concat(collection.restrictedContributionsCount > 0 ? [`${collection.restrictedContributionsCount} in private repositories`] : []),
    languages: totalBytes
      ? [...bytes].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, size]) => ({ name, share: size / totalBytes }))
      : [],
  };
}

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function render(s, t, updated) {
  const W = 840;
  const PAD = 28;
  const cell = (W - 2 * PAD) / s.weeks.length;
  const top = 132; // heatmap's first row
  const max = Math.max(1, ...s.weeks.flat().map((d) => d.contributionCount));
  const parts = [];

  // Activity map: one dot per day; bigger, darker dots for busier days (GitHub's four levels).
  let lastLabel = -3;
  s.weeks.forEach((days, column) => {
    const x = PAD + cell * column + cell / 2;
    const first = new Date(`${days[0].date}T00:00:00Z`);
    const month = days.find((d) => d.date.endsWith("-01"));
    if (month && column - lastLabel >= 3 && column < s.weeks.length - 1) {
      parts.push(`<text x="${x - cell / 2}" y="${top - 12}" class="m">${MONTHS[Number(month.date.slice(5, 7)) - 1]}</text>`);
      lastLabel = column;
    }
    for (const day of days) {
      const row = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      const y = top + cell * row + cell / 2;
      const level = day.contributionCount === 0 ? 0 : Math.min(4, Math.ceil((day.contributionCount / max) * 4));
      const r = [1.4, 2.6, 3.6, 4.6, 5.6][level];
      const fill = level === 0 ? t.faint : t.ink;
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${fill}"><title>${escape(`${day.contributionCount} on ${day.date}`)}</title></circle>`);
    }
    void first;
  });

  // Top languages: a stacked bar in grey shades, with a legend.
  const langTop = top + cell * 7 + 34;
  let x = PAD;
  const barWidth = W - 2 * PAD;
  s.languages.forEach((lang, i) => {
    const width = Math.max(2, lang.share * barWidth);
    parts.push(`<rect x="${x.toFixed(1)}" y="${langTop + 12}" width="${Math.min(width, PAD + barWidth - x).toFixed(1)}" height="8" fill="${t.shades[i]}"/>`);
    x += width;
  });
  let legendX = PAD;
  const legend = s.languages.map((lang, i) => {
    const label = `${lang.name} ${(lang.share * 100).toFixed(lang.share < 0.1 ? 1 : 0)}%`;
    const item = `<rect x="${legendX}" y="${langTop + 33}" width="9" height="9" rx="2" fill="${t.shades[i]}" stroke="${t.border}"/><text x="${legendX + 15}" y="${langTop + 42}" class="l">${escape(label)}</text>`;
    legendX += 15 + label.length * 7.4 + 22;
    return item;
  });

  const height = s.languages.length ? langTop + 62 : top + cell * 7 + 24;
  const summary = `${s.total} contributions in the last 12 months`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="title desc">
<title id="title">GitHub activity: ${escape(summary)}</title>
<desc id="desc">${escape([...s.facts, ...s.languages.map((l) => `${l.name} ${(l.share * 100).toFixed(0)}%`)].join(", "))}</desc>
<style>
  .k { font: 600 11px ${MONO}; letter-spacing: 1.6px; fill: ${t.muted}; }
  .n { font: 600 34px ${MONO}; fill: ${t.ink}; }
  .u { font: 400 16px ${SANS}; fill: ${t.muted}; }
  .f { font: 400 13px ${SANS}; fill: ${t.muted}; }
  .m { font: 400 10px ${MONO}; fill: ${t.muted}; }
  .l { font: 400 12px ${SANS}; fill: ${t.ink}; }
</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="10" fill="none" stroke="${t.border}"/>
<text x="${PAD}" y="38" class="k">GITHUB ACTIVITY · LAST 12 MONTHS</text>
<text x="${W - PAD}" y="38" class="k" text-anchor="end">UPDATED ${escape(updated.toUpperCase())}</text>
<text x="${PAD}" y="80" class="n">${s.total.toLocaleString("en-US")}<tspan class="u" dx="10">contribution${s.total === 1 ? "" : "s"}</tspan></text>
<text x="${PAD}" y="104" class="f">${escape(s.facts.join("  ·  "))}</text>
${parts.join("\n")}
${s.languages.length ? `<text x="${PAD}" y="${langTop}" class="k">TOP LANGUAGES · PUBLIC REPOSITORIES</text>\n${legend.join("\n")}` : ""}
</svg>
`;
}

const stats = summarize(await loadUser());
const updated = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Manila" });
for (const [name, theme] of Object.entries(THEMES)) {
  await writeFile(new URL(`github-stats-${name}.svg`, ASSETS), render(stats, theme, updated));
}
console.log(`${stats.total} contributions; ${stats.facts.join(", ")}; languages: ${stats.languages.map((l) => l.name).join(", ") || "none"}`);
