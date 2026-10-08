/**
 * Manual smoke-test for the CTFd client.
 * Run with: npm run test:ctfd
 *
 * Usage: CTF_URL=https://your-ctf.example.com CTF_TOKEN=your-token npm run test:ctfd
 */
import { fetchChallenges, fetchChallengeDetail } from "./ctfd.js";

async function main(): Promise<void> {
  const baseUrl = process.env.CTF_URL;
  const token = process.env.CTF_TOKEN;

  if (!baseUrl || !token) {
    console.error("Set CTF_URL and CTF_TOKEN environment variables.");
    process.exit(1);
  }

  console.log(`Fetching challenges from ${baseUrl}...`);
  const challenges = await fetchChallenges(baseUrl, token);
  console.log(`Found ${challenges.length} challenges.\n`);

  if (challenges.length === 0) return;

  // Show first 5
  challenges.slice(0, 5).forEach((c) => {
    console.log(`  [${c.id}] ${c.name} (${c.category}) - ${c.value} pts`);
  });

  // Fetch detail for first challenge
  const first = challenges[0];
  console.log(`\nFetching detail for challenge ${first.id}: ${first.name}...`);
  const detail = await fetchChallengeDetail(baseUrl, token, first.id);
  console.log(`  description: ${detail.description.slice(0, 120)}...`);
  console.log(`  files:       ${detail.files.join(", ") || "none"}`);
  console.log(`  host:        ${detail.host ?? "none"}`);
  console.log(`  port:        ${detail.port ?? "none"}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
