// Updates the README's "GitHub activity" section every day:
// - the numbers (contributions, commits, repositories, top languages) as plain
//   README text between the github-stats markers, so they're readable on any screen
// - assets/github-stats-{light,dark}.svg: a halftone-dot activity map of the last
//   12 months, in the portfolio's monochrome style
//
// Runs daily from .github/workflows/github-stats.yml with the workflow's own
// GITHUB_TOKEN. Uses only Node's built-ins, so there is nothing to install.
// For a local preview without a token: STATS_DATA=data.json node scripts/github-stats.mjs

import { readFile, writeFile } from "node:fs/promises";

const LOGIN = process.env.GITHUB_LOGIN ?? "vinbalajadia";
const ROOT = new URL("../", import.meta.url);
const START = "<!-- github-stats:start -->";
const END = "<!-- github-stats:end -->";

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
  light: { ink: "#1f2328", muted: "#59636e", faint: "#d1d9e0", border: "#d1d9e0" },
  dark: { ink: "#e6edf3", muted: "#9198a1", faint: "#3d444d", border: "#3d444d" },
};
const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const RADII = [1.4, 2.6, 3.6, 4.6, 5.6]; // dot size for GitHub's five activity levels

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

const count = (n, one, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const percent = (share) => `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;

function summarize(user) {
  const c = user.contributionsCollection;
  const bytes = new Map();
  for (const repo of user.repositories.nodes) {
    for (const { size, node } of repo.languages.edges) bytes.set(node.name, (bytes.get(node.name) ?? 0) + size);
  }
  const totalBytes = [...bytes.values()].reduce((sum, size) => sum + size, 0);
  return {
    total: c.contributionCalendar.totalContributions,
    weeks: c.contributionCalendar.weeks.map((week) => week.contributionDays),
    // Only what's non-zero, so the README never shows a row of zeros.
    facts: [
      [c.totalCommitContributions, "commit"],
      [c.totalPullRequestContributions, "pull request"],
      [c.totalPullRequestReviewContributions, "code review"],
      [c.totalIssueContributions, "issue"],
      [c.restrictedContributionsCount, "contribution in private repositories", "contributions in private repositories"],
      [user.repositories.totalCount, "public repository", "public repositories"],
    ]
      .filter(([n]) => n > 0)
      .map(([n, one, many]) => count(n, one, many)),
    languages: totalBytes
      ? [...bytes].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, size]) => ({ name, share: size / totalBytes }))
      : [],
  };
}

const escape = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The README text: everything a visitor reads, at normal text size. Written as
 * one HTML paragraph so its line breaks look the same wherever GitHub renders it.
 */
function readmeBlock(s, updated) {
  const lines = [`<b>${escape(count(s.total, "contribution"))}</b> in the last 12 months · ${s.facts.map(escape).join(" · ")}`];
  if (s.languages.length) {
    lines.push(`Top languages in my public repositories: ${s.languages.map((l) => escape(`${l.name} ${percent(l.share)}`)).join(" · ")}`);
  }
  lines.push(`<sub>Updated daily · last update ${escape(updated)}</sub>`);
  return `<p>\n${lines.join("<br>\n")}\n</p>`;
}

/** The activity map: one dot per day, bigger and darker on busier days. */
function render(s, t) {
  const W = 840;
  const PAD = 24;
  const cell = (W - 2 * PAD) / s.weeks.length;
  const top = PAD + 22;
  const legendY = top + cell * 7 + 18;
  const H = legendY + PAD - 4;
  const max = Math.max(1, ...s.weeks.flat().map((d) => d.contributionCount));
  const parts = [];

  let lastLabel = -3;
  s.weeks.forEach((days, column) => {
    const x = PAD + cell * column + cell / 2;
    const month = days.find((d) => d.date.endsWith("-01"));
    if (month && column - lastLabel >= 3 && column < s.weeks.length - 1) {
      parts.push(`<text x="${(x - cell / 2).toFixed(1)}" y="${PAD + 8}" class="m">${MONTHS[Number(month.date.slice(5, 7)) - 1]}</text>`);
      lastLabel = column;
    }
    for (const day of days) {
      const row = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      const level = day.contributionCount === 0 ? 0 : Math.min(4, Math.ceil((day.contributionCount / max) * 4));
      parts.push(
        `<circle cx="${x.toFixed(1)}" cy="${(top + cell * row + cell / 2).toFixed(1)}" r="${RADII[level]}" fill="${level ? t.ink : t.faint}"><title>${escape(`${count(day.contributionCount, "contribution")} on ${day.date}`)}</title></circle>`,
      );
    }
  });

  // "Less ● ● ● ● ● More", bottom right, with clear space around the words.
  const moreX = W - PAD - 30; // "More" is about 29px wide at 12px
  const lastDot = moreX - 12; // centre of the biggest dot
  const firstDot = lastDot - 16 * (RADII.length - 1);
  const legend = [`<text x="${firstDot - 12}" y="${legendY + 4}" class="m" text-anchor="end">Less</text>`];
  RADII.forEach((r, level) => {
    legend.push(`<circle cx="${firstDot + level * 16}" cy="${legendY}" r="${r}" fill="${level ? t.ink : t.faint}"/>`);
  });
  legend.push(`<text x="${moreX}" y="${legendY + 4}" class="m">More</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title">
<title id="title">GitHub activity map: ${escape(count(s.total, "contribution"))} in the last 12 months</title>
<style>.m { font: 400 12px ${MONO}; fill: ${t.muted}; }</style>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="none" stroke="${t.border}"/>
${parts.join("\n")}
${legend.join("\n")}
</svg>
`;
}

const stats = summarize(await loadUser());
const updated = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Manila" });

for (const [name, theme] of Object.entries(THEMES)) {
  await writeFile(new URL(`assets/github-stats-${name}.svg`, ROOT), render(stats, theme));
}

const readmeUrl = new URL("README.md", ROOT);
const readme = await readFile(readmeUrl, "utf8");
const start = readme.indexOf(START);
const end = readme.indexOf(END);
if (start === -1 || end < start) throw new Error(`README.md needs ${START} and ${END} markers.`);
await writeFile(readmeUrl, `${readme.slice(0, start + START.length)}\n${readmeBlock(stats, updated)}\n${readme.slice(end)}`);

console.log(readmeBlock(stats, updated).replace(/<[^>]+>/g, "").trim());
